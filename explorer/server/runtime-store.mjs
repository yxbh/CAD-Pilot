import { readFile, readdir, rm, stat, utimes } from "node:fs/promises";
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

// Every saved setup names the model cache and STEP snapshot it shows; a setup saves itself whenever it is used.
async function protectedNames(root, since) {
  const names = new Set();
  for (const { name, file, info } of await entries(path.join(root, "views"))) {
    if (!/^[a-f0-9]{24}\.json$/.test(name) || info.mtimeMs < since) continue;
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (typeof saved.modelCache === "string") names.add(`models/${saved.modelCache}`);
      if (typeof saved.inputFile === "string") names.add(`inputs/${path.basename(saved.inputFile)}`);
    } catch { /* An unreadable setup protects nothing; its own viewer reports the problem. */ }
  }
  return names;
}

// Reopening an identical snapshot reuses its files; refreshing their time keeps recently used ones.
export async function markUsed(...files) {
  const now = new Date();
  await Promise.all(files.filter(Boolean).map((file) => utimes(file, now, now).catch(() => {})));
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
    ...(await entries(path.join(root, "inputs"))).filter(({ name }) => /^[a-f0-9]{64}\.step$/.test(name)).map((item) => ({ ...item, kind: "inputs" })),
    ...models.filter(({ name }) => /^[a-f0-9]{64}\.json$/.test(name)).map((item) => ({ ...item, kind: "models" })),
  ].sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  let budget = retention.maxSnapshotBytes;
  for (const item of snapshots) {
    const used = keep.has(`${item.kind}/${item.name}`);
    const fresh = !all && now - item.info.mtimeMs < retention.keepDays * day && budget >= item.bytes;
    if (used || recent(item) || fresh) {
      if (!used) budget -= item.bytes;
      keptBytes += item.bytes;
    } else await remove(item.kind, item);
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
