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
// any other file with the same hash beside it (such as binary geometry) belongs to it and goes with it.
const hashed = /^([a-f0-9]{64})\.[a-z0-9]+$/;
function snapshotsIn(items, kind, primary) {
  const groups = new Map();
  for (const item of items) {
    const stem = hashed.exec(item.name)?.[1];
    if (stem) groups.set(stem, [...(groups.get(stem) ?? []), item]);
  }
  return [...groups.values()].flatMap((files) => {
    const main = files.find((item) => primary(item.name));
    if (!main) return [];
    const companions = files.filter((item) => item !== main);
    return [{ ...main, kind, companions, bytes: files.reduce((total, item) => total + item.bytes, 0) }];
  });
}

/** Remove old, unused snapshots, model caches, captures and orphaned reference descriptors. `all` keeps only what saved setups use. */
export async function pruneRuntime(root, { all = false, dryRun = false, now = Date.now(), retention = RETENTION } = {}) {
  const keep = await protectedNames(root, now - retention.setupDays * day);
  const removed = { inputs: 0, models: 0, captures: 0, references: 0, staging: 0 };
  let freedBytes = 0;
  let keptBytes = 0;
  const gone = new Set();
  const remove = async (kind, item, extra = []) => {
    removed[kind]++;
    gone.add(item.file);
    freedBytes += item.bytes;
    if (!dryRun) for (const file of [item.file, ...extra]) await rm(file, { recursive: true, force: true });
  };
  const recent = (item) => now - item.info.mtimeMs < retention.minAgeMs;

  const models = await entries(path.join(root, "models"));
  for (const item of models.filter(({ name }) => name.startsWith(".import-"))) if (!recent(item)) await remove("staging", item);
  const snapshots = [
    ...snapshotsIn(await entries(path.join(root, "inputs")), "inputs", () => true),
    ...snapshotsIn(models, "models", (name) => name.endsWith(".json")),
  ].sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  let budget = retention.maxSnapshotBytes;
  for (const item of snapshots) {
    const used = keep.has(`${item.kind}/${item.name}`);
    const fresh = !all && now - item.info.mtimeMs < retention.keepDays * day && budget >= item.bytes;
    if (used || recent(item) || fresh) {
      if (!used) budget -= item.bytes;
      keptBytes += item.bytes;
    } else await remove(item.kind, item, item.companions.map(({ file }) => file));
  }

  const captures = (await entries(path.join(root, "captures"))).filter(({ name }) => name.endsWith(".png"))
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const [index, item] of captures.entries()) {
    const fresh = !all && index < retention.keepCaptures && now - item.info.mtimeMs < retention.captureDays * day;
    if (fresh || recent(item)) keptBytes += item.bytes;
    else await remove("captures", item, [`${item.file}.json`]);
  }

  // A copied reference descriptor is useless once its model cache is gone.
  const liveModels = new Set(snapshots.filter((item) => item.kind === "models" && !gone.has(item.file)).map(({ name }) => name));
  for (const item of (await entries(path.join(root, "references"))).filter(({ name }) => name.endsWith(".json"))) {
    let topology = "";
    try { topology = JSON.parse(await readFile(item.file, "utf8")).topologyRevision; } catch { /* unreadable: orphaned */ }
    if (liveModels.has(`${topology}.json`) || recent(item)) keptBytes += item.bytes;
    else await remove("references", item);
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
