import { readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const day = 24 * 60 * 60 * 1000;
/**
 * Retention for the content-addressed runtime store. The snapshot a saved setup shows is kept while that setup has
 * been used in the last setupDays; other snapshots are kept for keepDays within maxSnapshotBytes. Anything younger
 * than minAgeMs is kept so a concurrent import or capture is never removed while it is being published.
 */
export const RETENTION = Object.freeze({
  setupDays: 30, keepDays: 7, maxSnapshotBytes: 256 * 1024 ** 2, keepCaptures: 50, captureDays: 7, minAgeMs: 10 * 60 * 1000,
});

async function entries(directory) {
  const names = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const found = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info) found.push({ name, file, info, bytes: info.isDirectory() ? 0 : info.size });
  }
  return found;
}

// Every saved setup names the model caches and source snapshots it shows (a setup that shows several files names
// each one); a setup saves itself whenever it is used.
async function protectedNames(root, since) {
  const names = new Set();
  const collect = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (typeof value.modelCache === "string") names.add(`models/${path.basename(value.modelCache)}`);
    if (typeof value.inputFile === "string") names.add(`inputs/${path.basename(value.inputFile)}`);
    for (const child of Object.values(value)) collect(child, depth + 1);
  };
  for (const { name, file, info } of await entries(path.join(root, "views"))) {
    if (!/^[a-f0-9]{24}\.json$/.test(name) || info.mtimeMs < since) continue;
    try { collect(JSON.parse(await readFile(file, "utf8"))); }
    catch { /* An unreadable setup protects nothing; its own viewer reports the problem. */ }
  }
  return names;
}

// Reopening an identical snapshot reuses its files; refreshing their time keeps recently used ones.
export async function markUsed(...files) {
  const now = new Date();
  await Promise.all(files.filter(Boolean).map((file) => utimes(file, now, now).catch(() => {})));
}

// Snapshots are named by content hash. A source snapshot may have any extension; a model cache is <hash>.json, and
// any other file with the same hash beside it (such as binary geometry) belongs to it and goes with it. A group
// without its model cache (geometry whose publish was interrupted, or whose cache is gone) is an orphan that nothing
// can show. A group counts as used as recently as its most recently used file.
const hashed = /^([a-f0-9]{64})\.[a-z0-9]+$/;
function snapshotsIn(items, kind, primary) {
  const groups = new Map();
  for (const item of items) {
    const stem = hashed.exec(item.name)?.[1];
    if (stem) groups.set(stem, [...(groups.get(stem) ?? []), item]);
  }
  return [...groups.values()].map((files) => {
    const main = files.find((item) => primary(item.name));
    return {
      ...(main ?? files[0]), kind, orphan: !main, members: files,
      mtimeMs: Math.max(...files.map((item) => item.info.mtimeMs)), bytes: files.reduce((total, item) => total + item.bytes, 0),
    };
  });
}

/** Remove old, unused snapshots, model caches, captures and orphaned reference descriptors. `all` keeps only what saved setups use. */
export async function pruneRuntime(root, { all = false, dryRun = false, now = Date.now(), retention = RETENTION } = {}) {
  const keep = await protectedNames(root, now - retention.setupDays * day);
  const removed = { inputs: 0, models: 0, captures: 0, references: 0, staging: 0 };
  let freedBytes = 0;
  let keptBytes = 0;
  const gone = new Set();
  // Another process may reuse a file between its listing and its removal (a load reopening an identical snapshot
  // refreshes its time first): a file touched since it was listed is in use again and stays.
  const touchedSince = async (files) => {
    for (const { file, info } of files) {
      const current = info && await stat(file).catch(() => null);
      if (current && current.mtimeMs > info.mtimeMs) return true;
    }
    return false;
  };
  const remove = async (kind, files, bytes) => {
    if (await touchedSince(files)) {
      keptBytes += bytes;
      return;
    }
    removed[kind]++;
    freedBytes += bytes;
    for (const { file } of files) gone.add(file);
    if (!dryRun) for (const { file } of files) await rm(file, { recursive: true, force: true });
  };
  const recent = (mtimeMs) => now - mtimeMs < retention.minAgeMs;
  // Folders a conversion or a one-shot render was using when its process ended.
  const staging = (items, prefix) => items.filter(({ name }) => name.startsWith(prefix));

  const models = await entries(path.join(root, "models"));
  for (const item of staging(models, ".import-")) if (!recent(item.info.mtimeMs)) await remove("staging", [item], item.bytes);
  const snapshots = [
    ...snapshotsIn(await entries(path.join(root, "inputs")), "inputs", () => true),
    ...snapshotsIn(models, "models", (name) => name.endsWith(".json")),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);
  let budget = retention.maxSnapshotBytes;
  for (const item of snapshots) {
    const used = !item.orphan && keep.has(`${item.kind}/${item.name}`);
    const fresh = !all && !item.orphan && now - item.mtimeMs < retention.keepDays * day && budget >= item.bytes;
    if (used || recent(item.mtimeMs) || fresh) {
      if (!used) budget -= item.bytes;
      keptBytes += item.bytes;
    } else await remove(item.kind, item.members, item.bytes);
  }

  const captureEntries = await entries(path.join(root, "captures"));
  for (const item of staging(captureEntries, ".render-")) if (!recent(item.info.mtimeMs)) await remove("staging", [item], item.bytes);
  const captures = captureEntries.filter(({ name }) => name.endsWith(".png")).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const [index, item] of captures.entries()) {
    const fresh = !all && index < retention.keepCaptures && now - item.info.mtimeMs < retention.captureDays * day;
    if (fresh || recent(item.info.mtimeMs)) keptBytes += item.bytes;
    else await remove("captures", [item, { file: `${item.file}.json`, info: null }], item.bytes);
  }

  // A copied reference descriptor is useless once its model cache is gone.
  const liveModels = new Set(snapshots.filter((item) => item.kind === "models" && !item.orphan && !gone.has(item.file)).map(({ name }) => name));
  for (const item of (await entries(path.join(root, "references"))).filter(({ name }) => name.endsWith(".json"))) {
    let topology = "";
    try { topology = JSON.parse(await readFile(item.file, "utf8")).topologyRevision; } catch { /* unreadable: orphaned */ }
    if (liveModels.has(`${topology}.json`) || recent(item.info.mtimeMs)) keptBytes += item.bytes;
    else await remove("references", [item], item.bytes);
  }
  return { root, dryRun, removed, freedBytes, keptBytes };
}

// Viewers and one-shot renders in any number of processes share a store; a marker file spaces their prunes out.
export async function pruneIfDue(root, { intervalMs = 10 * 60 * 1000, log = () => {}, now = Date.now() } = {}) {
  const marker = path.join(root, ".pruned");
  const last = await stat(marker).then((info) => info.mtimeMs, () => 0);
  if (now - last < intervalMs) return null;
  await writeFile(marker, "");
  try {
    const result = await pruneRuntime(root, { now });
    const counts = Object.entries(result.removed).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`);
    if (result.freedBytes) log(`Explorer storage: removed ${counts.join(", ")} (${Math.round(result.freedBytes / 1048576)} MB)`);
    return result;
  } catch (error) {
    log(`Explorer storage cleanup: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
