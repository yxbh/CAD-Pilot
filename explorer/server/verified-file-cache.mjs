import { open, stat } from "node:fs/promises";

export class FileChangedError extends Error {
  constructor() { super("Cached file changed during inspection"); }
}

// Nanosecond timestamps plus device/inode detect same-length writes and atomic replacements, including restored mtimes.
const signature = (info) => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(":");

// Retention is bounded by entries and conservatively accounted bytes, not a promise about total V8/process memory.
// Only completed values are retained; oversized values still work and concurrent callers share their transient load.
export function createVerifiedFileCache({ maxEntries, maxBytes, check, load, io = { open, stat } }) {
  for (const value of [maxEntries, maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Cache limits must be non-negative safe integers");
  }
  const entries = new Map();
  const pending = new Map();
  const counts = { hits: 0, loads: 0, coalesced: 0, evictions: 0, invalidations: 0, stats: 0 };
  let retainedBytes = 0;

  function remove(key, reason) {
    const previous = entries.get(key);
    if (!previous) return;
    retainedBytes -= previous.bytes;
    entries.delete(key);
    if (reason) counts[reason]++;
  }

  async function current(file) {
    counts.stats++;
    const preliminary = await io.stat(file, { bigint: true });
    if (!preliminary.isFile()) throw new FileChangedError();
    check(preliminary);
    // A path-only stat on Windows may precede ctime finalization after a writer closes. Opening a read handle refreshes it without reading payload bytes.
    const handle = await io.open(file, "r");
    let info;
    try {
      counts.stats++;
      info = await handle.stat({ bigint: true });
    } finally { await handle.close(); }
    if (!info.isFile()) throw new FileChangedError();
    check(info);
    counts.stats++;
    if (signature(await io.stat(file, { bigint: true })) !== signature(info)) throw new FileChangedError();
    return { info, signature: signature(info) };
  }

  async function verify(record) {
    try {
      if ((await current(record.file)).signature !== record.signature) throw new FileChangedError();
    } catch (error) {
      if (entries.get(record.key)?.signature === record.signature) remove(record.key, "invalidations");
      throw error;
    }
  }

  async function read(key, file) {
    counts.loads++;
    const handle = await io.open(file, "r");
    try {
      // Windows can finalize a just-written file's ctime at first open. Start from the opened handle, then verify its path before reading.
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) throw new FileChangedError();
      check(opened);
      const record = { key, file, signature: signature(opened) };
      await verify(record);
      const { value, bytes } = await load(handle, opened);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Invalid cache byte accounting");
      if (signature(await handle.stat({ bigint: true })) !== record.signature) throw new FileChangedError();
      await verify(record);
      return { ...record, value, bytes };
    } finally {
      await handle.close();
    }
  }

  async function get(key, file) {
    let expected;
    try { expected = await current(file); }
    catch (error) { remove(key, "invalidations"); throw error; }
    const previous = entries.get(key);
    if (previous?.signature === expected.signature) {
      counts.hits++;
      entries.delete(key);
      entries.set(key, previous);
      return previous;
    }
    remove(key, "invalidations");
    const pendingKey = `${key}:${expected.signature}`;
    let work = pending.get(pendingKey);
    if (work) counts.coalesced++;
    else {
      work = read(key, file).finally(() => {
        if (pending.get(pendingKey) === work) pending.delete(pendingKey);
      });
      pending.set(pendingKey, work);
    }
    const record = await work;
    // Every waiter checks again: sharing an older read must not hide a newer replacement.
    await verify(record);
    if (maxEntries > 0 && record.bytes <= maxBytes) {
      remove(key);
      while (entries.size >= maxEntries || retainedBytes + record.bytes > maxBytes) {
        remove(entries.keys().next().value, "evictions");
      }
      entries.set(key, record);
      retainedBytes += record.bytes;
    }
    return record;
  }

  return {
    get,
    verify,
    stats: () => ({ ...counts, entries: entries.size, retainedBytes, inFlight: pending.size, maxEntries, maxBytes }),
  };
}
