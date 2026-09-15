import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createInspectionService } from "../server/inspection.mjs";
import { topologyRevision } from "../server/protocol.mjs";
import { createReference } from "../shared/references.mjs";
import { inspectionFixture, inspectionIo, latch } from "./inspection-fixtures.mjs";

test("warm face and part inspections skip JSON parsing, full validation and source hashing", async (t) => {
  const { service, reference, model } = await inspectionFixture(t);
  const first = await service.inspectReference(reference);
  assert.equal(first.snapshotStatus, "available");
  assert.equal(first.face.triangleCount, 2);
  for (const node of model.nodes) {
    for (const face of [null, "f1"]) {
      const result = await service.inspectReference(createReference(model, node.id, face));
      assert.equal(result.occurrence.id, node.id);
      assert.equal(result.face?.id ?? null, face);
      assert.deepEqual(result.originalWorldMatrix, node.matrix);
    }
  }
  const stats = service.cacheStats();
  assert.equal(stats.modelReads, 1);
  assert.equal(stats.jsonParses, 1);
  assert.equal(stats.modelValidations, 1);
  assert.equal(stats.sourceHashes, 1);
  assert.equal(stats.models.hits, 4);
  assert.equal(stats.sources.hits, 4);
  assert.ok(stats.models.stats >= 10);
  assert.ok(stats.sources.stats >= 10);
});

test("returned nested facts and stats cannot corrupt the private snapshot", async (t) => {
  const { service, reference } = await inspectionFixture(t);
  const result = await service.inspectReference(reference);
  const expected = structuredClone(result);
  result.face.center[0] = 999;
  result.face.bounds.min[0] = 999;
  result.partBounds.max[0] = 999;
  result.face.id = "f99";
  result.originalWorldMatrix[12] = 999;
  result.source.sha256 = "0".repeat(64);
  result.occurrence.id = "changed";
  service.cacheStats().models.maxEntries = 0;
  assert.deepEqual(await service.inspectReference(reference), expected);
  assert.equal(service.cacheStats().modelValidations, 1);
});

test("retained display labels stay bounded without changing UTF-16 truncation semantics", async (t) => {
  const { service, model, runtimeRoot } = await inspectionFixture(t);
  model.source.name = "Source " + "s".repeat(64 * 1024);
  model.nodes[0].label = "A".repeat(236) + "😊" + "B".repeat(20);
  model.topologyRevision = topologyRevision(model);
  await writeFile(path.join(runtimeRoot, "models", `${model.topologyRevision}.json`), JSON.stringify(model));
  const result = await service.inspectReference(createReference(model, model.nodes[0].id, "f1"));
  assert.equal(result.source.name, model.source.name.slice(0, 237) + "...");
  assert.equal(result.occurrence.label, model.nodes[0].label.slice(0, 237) + "...");
  assert.ok(service.cacheStats().models.retainedBytes < 16 * 1024);
});

test("same-length tampering with a restored mtime is revalidated, never served from warm facts", async (t) => {
  const { service, reference, model, modelFile } = await inspectionFixture(t);
  await service.inspectReference(reference);
  const before = await stat(modelFile);
  model.parts[0].positions[0] = 9;
  await writeFile(modelFile, JSON.stringify(model));
  await utimes(modelFile, before.atime, before.mtime);
  assert.equal((await stat(modelFile)).size, before.size);
  await assert.rejects(service.inspectReference(reference), { code: "invalid_model" });
  assert.equal(service.cacheStats().modelValidations, 2);
  assert.equal(service.cacheStats().models.entries, 0);
  model.parts[0].positions[0] = 0;
  await writeFile(modelFile, JSON.stringify(model));
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  assert.equal(service.cacheStats().modelValidations, 3);
});

test("removed warm models, malformed JSON, and a valid but wrong topology retain explicit errors", async (t) => {
  const { service, reference, model, modelFile } = await inspectionFixture(t);
  await service.inspectReference(reference);
  await unlink(modelFile);
  await assert.rejects(service.inspectReference(reference), { code: "reference_unavailable", status: 404 });
  await writeFile(modelFile, "{");
  await assert.rejects(service.inspectReference(reference), SyntaxError);
  model.nodes[0].label = "Changed";
  model.topologyRevision = topologyRevision(model);
  await writeFile(modelFile, JSON.stringify(model));
  await assert.rejects(service.inspectReference(reference), { code: "stale_reference", status: 409 });
});

test("source hashes are refreshed on same-size writes, replacements and missing snapshots", async (t) => {
  const { service, reference, sourceFile } = await inspectionFixture(t);
  const original = await readFile(sourceFile);
  const before = await stat(sourceFile);
  await service.inspectReference(reference);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  await writeFile(sourceFile, changed);
  await utimes(sourceFile, before.atime, before.mtime);
  assert.equal((await stat(sourceFile)).size, before.size);
  const result = await service.inspectReference(reference);
  assert.equal(result.snapshotStatus, "changed");
  assert.equal(result.workbenchRelativeSnapshot, null);
  assert.equal(service.cacheStats().sourceHashes, 2);
  await writeFile(`${sourceFile}.replacement`, original);
  await rename(`${sourceFile}.replacement`, sourceFile);
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  assert.equal(service.cacheStats().sourceHashes, 3);
  await unlink(sourceFile);
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "missing");
  assert.equal(service.cacheStats().sources.entries, 0);
  await mkdir(sourceFile);
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "changed");
  assert.equal(service.cacheStats().modelValidations, 1);
});

test("concurrent cold requests coalesce both expensive reads", async (t) => {
  const entered = latch();
  const release = latch();
  t.after(release.resolve);
  const { service, reference } = await inspectionFixture(t, {
    io: inspectionIo({ afterModelRead: async () => { entered.resolve(); await release.promise; } }),
  });
  const requests = Array.from({ length: 12 }, () => service.inspectReference(reference));
  await entered.promise;
  release.resolve();
  const results = await Promise.all(requests);
  assert.ok(results.every((result) => result.snapshotStatus === "available"));
  const stats = service.cacheStats();
  assert.equal(stats.modelReads, 1);
  assert.equal(stats.jsonParses, 1);
  assert.equal(stats.modelValidations, 1);
  assert.equal(stats.sourceHashes, 1);
  assert.equal(stats.models.inFlight, 0);
  assert.equal(stats.sources.inFlight, 0);
  assert.ok(stats.models.coalesced > 0);
});

test("concurrent failures are shared but never poison a repaired snapshot retry", async (t) => {
  const entered = latch();
  const release = latch();
  t.after(release.resolve);
  const { service, reference, model, modelFile } = await inspectionFixture(t, {
    io: inspectionIo({ afterModelRead: async () => { entered.resolve(); await release.promise; } }),
  });
  await writeFile(modelFile, "{");
  const requests = Promise.allSettled(Array.from({ length: 8 }, () => service.inspectReference(reference)));
  await entered.promise;
  release.resolve();
  const failures = await requests;
  assert.ok(failures.every((result) => result.status === "rejected" && result.reason instanceof SyntaxError));
  assert.equal(service.cacheStats().models.inFlight, 0);
  assert.equal(service.cacheStats().models.entries, 0);
  await writeFile(modelFile, JSON.stringify(model));
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  assert.equal(service.cacheStats().modelValidations, 1);
});

test("a changed model during a coalesced read rejects old and new requests independently", async (t) => {
  const entered = latch();
  const release = latch();
  t.after(release.resolve);
  let reads = 0;
  const { service, reference, model, modelFile } = await inspectionFixture(t, {
    io: inspectionIo({ afterModelRead: async () => { if (++reads === 1) { entered.resolve(); await release.promise; } } }),
  });
  const old = assert.rejects(service.inspectReference(reference), { code: "stale_reference" });
  await entered.promise;
  model.parts[0].positions[0] = 9;
  await writeFile(modelFile, JSON.stringify(model));
  await assert.rejects(service.inspectReference(reference), { code: "invalid_model" });
  release.resolve();
  await old;
  assert.equal(service.cacheStats().models.entries, 0);
  model.parts[0].positions[0] = 0;
  await writeFile(modelFile, JSON.stringify(model));
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
});

test("a model removed while its source is hashing cannot return stale success", async (t) => {
  const entered = latch();
  const release = latch();
  t.after(release.resolve);
  const { service, reference, modelFile } = await inspectionFixture(t, {
    io: inspectionIo({ afterSourceRead: async () => { entered.resolve(); await release.promise; } }),
  });
  const result = assert.rejects(service.inspectReference(reference), { code: "reference_unavailable" });
  await entered.promise;
  await unlink(modelFile);
  release.resolve();
  await result;
});

test("a late old-read failure cannot evict a newer, independently verified snapshot", async (t) => {
  const entered = latch();
  const release = latch();
  t.after(release.resolve);
  let reads = 0;
  const { service, reference, model, modelFile } = await inspectionFixture(t, {
    io: inspectionIo({ afterModelRead: async () => { if (++reads === 1) { entered.resolve(); await release.promise; } } }),
  });
  const old = assert.rejects(service.inspectReference(reference), { code: "stale_reference" });
  await entered.promise;
  await writeFile(modelFile, JSON.stringify(model) + "\n");
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  release.resolve();
  await old;
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  assert.equal(service.cacheStats().modelValidations, 2);
  assert.equal(service.cacheStats().models.entries, 1);
});

test("source mutation during hashing reports changed, then rehashes on retry", async (t) => {
  const entered = latch();
  const release = latch();
  t.after(release.resolve);
  const { service, reference, sourceFile } = await inspectionFixture(t, {
    io: inspectionIo({ afterSourceRead: async () => { entered.resolve(); await release.promise; } }),
  });
  const original = await readFile(sourceFile);
  const request = service.inspectReference(reference);
  await entered.promise;
  await writeFile(sourceFile, Buffer.alloc(original.length, 42));
  release.resolve();
  assert.equal((await request).snapshotStatus, "changed");
  assert.equal(service.cacheStats().sources.entries, 0);
  await writeFile(sourceFile, original);
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  assert.equal(service.cacheStats().sourceHashes, 2);
});

test("source IO failures do not poison retries even when file metadata is unchanged", async (t) => {
  let hashes = 0;
  const { service, reference } = await inspectionFixture(t, {
    io: inspectionIo({ afterSourceRead: () => {
      if (++hashes === 1) throw Object.assign(new Error("Injected source read failure"), { code: "EIO" });
    } }),
  });
  await assert.rejects(service.inspectReference(reference), { code: "EIO" });
  assert.equal(service.cacheStats().sources.entries, 0);
  assert.equal(service.cacheStats().sources.inFlight, 0);
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  assert.equal(service.cacheStats().modelValidations, 1);
  assert.equal(service.cacheStats().sourceHashes, 2);
});

test("entry limits evict LRU facts and byte limits allow uncached inspection", async (t) => {
  const { service, reference, model, runtimeRoot } = await inspectionFixture(t, { cacheLimits: { modelMaxEntries: 1 } });
  await service.inspectReference(reference);
  const other = structuredClone(model);
  other.nodes[0].label = "Second topology";
  other.topologyRevision = topologyRevision(other);
  await writeFile(path.join(runtimeRoot, "models", `${other.topologyRevision}.json`), JSON.stringify(other));
  await service.inspectReference(createReference(other, other.nodes[0].id, "f1"));
  assert.equal(service.cacheStats().models.evictions, 1);
  await service.inspectReference(reference);
  assert.equal(service.cacheStats().modelValidations, 3);
  assert.equal(service.cacheStats().models.entries, 1);
  assert.equal(service.cacheStats().sourceHashes, 1);

  const uncached = createInspectionService({
    runtimeRoot, workbenchRoot: runtimeRoot,
    cacheLimits: { modelMaxBytes: 1, sourceMaxBytes: 1 },
  });
  for (let i = 0; i < 2; i++) assert.equal((await uncached.inspectReference(reference)).snapshotStatus, "available");
  const stats = uncached.cacheStats();
  assert.equal(stats.modelValidations, 2);
  assert.equal(stats.sourceHashes, 2);
  assert.equal(stats.models.entries, 0);
  assert.equal(stats.sources.entries, 0);
  assert.equal(stats.models.retainedBytes, 0);
  assert.equal(stats.sources.retainedBytes, 0);
});

test("cache limits reject invalid configuration instead of creating unbounded caches", () => {
  for (const value of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => createInspectionService({
      runtimeRoot: ".", workbenchRoot: ".", cacheLimits: { modelMaxBytes: value },
    }), /non-negative safe integers/);
  }
});

test("source entry eviction and model byte-budget eviction each require fresh verification", async (t) => {
  const first = await inspectionFixture(t);
  const second = await inspectionFixture(t, { sourceBytes: 513 });
  await first.service.inspectReference(first.reference);
  const budget = first.service.cacheStats().models.retainedBytes;
  await writeFile(path.join(first.runtimeRoot, "models", path.basename(second.modelFile)), await readFile(second.modelFile));
  await writeFile(path.join(first.runtimeRoot, "inputs", path.basename(second.sourceFile)), await readFile(second.sourceFile));
  const service = createInspectionService({
    runtimeRoot: first.runtimeRoot, workbenchRoot: first.workbenchRoot,
    cacheLimits: { modelMaxBytes: budget, sourceMaxEntries: 1 },
  });
  for (const reference of [first.reference, second.reference, first.reference]) {
    assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
    const stats = service.cacheStats();
    assert.ok(stats.models.retainedBytes <= budget);
    assert.ok(stats.sources.entries <= 1);
  }
  assert.equal(service.cacheStats().modelValidations, 3);
  assert.equal(service.cacheStats().sourceHashes, 3);
  assert.equal(service.cacheStats().models.evictions, 2);
  assert.equal(service.cacheStats().sources.evictions, 2);
});

test("existing model and source size limits still apply after a warm inspection", async (t) => {
  const { service, reference, modelFile, sourceFile } = await inspectionFixture(t);
  await service.inspectReference(reference);
  await truncate(sourceFile, 100 * 1024 * 1024 + 1);
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "changed");
  assert.equal(service.cacheStats().sourceHashes, 1);
  await truncate(modelFile, 160 * 1024 * 1024 + 1);
  await assert.rejects(service.inspectReference(reference), { code: "model_too_large", status: 413 });
  assert.equal(service.cacheStats().modelValidations, 1);
  assert.equal(service.cacheStats().models.entries, 0);
});
