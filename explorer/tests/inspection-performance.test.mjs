import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createInspectionService } from "../server/inspection.mjs";
import { createReference } from "../shared/references.mjs";
import { inspectionFixture } from "./inspection-fixtures.mjs";

test("synthetic large mesh: warm selections avoid mesh-size work; oversized cache entries still inspect", async (t) => {
  // Repeated triangles exercise JSON/validation cost, not real assembly complexity or CAD kernel correctness.
  const fixture = await inspectionFixture(t, { triangles: 420_000, sourceBytes: 32 * 1024 * 1024 });
  const { service, reference, modelFile, sourceFile, model, runtimeRoot, workbenchRoot } = fixture;
  const modelBytes = (await stat(modelFile)).size;
  assert.ok(modelBytes > 25 * 1024 * 1024);
  const started = performance.now();
  assert.equal((await service.inspectReference(reference)).snapshotStatus, "available");
  const coldMs = performance.now() - started;
  const warm = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const result = await service.inspectReference(createReference(model, model.nodes[i % 2].id, i % 3 ? "f1" : null));
    warm.push(performance.now() - start);
    assert.equal(result.snapshotStatus, "available");
  }
  const stats = service.cacheStats();
  assert.equal(stats.modelReads, 1);
  assert.equal(stats.jsonParses, 1);
  assert.equal(stats.modelValidations, 1);
  assert.equal(stats.sourceHashes, 1);
  assert.equal(stats.sourceBytesRead, (await stat(sourceFile)).size);
  assert.equal(stats.models.hits, 20);
  assert.equal(stats.sources.hits, 20);
  assert.ok(stats.models.retainedBytes < modelBytes / 100);
  assert.ok(stats.models.retainedBytes <= stats.models.maxBytes);
  const uncached = createInspectionService({ runtimeRoot, workbenchRoot, cacheLimits: { modelMaxBytes: 1 } });
  assert.equal((await uncached.inspectReference(reference)).face.triangleCount, 420_000);
  assert.equal(uncached.cacheStats().models.entries, 0);
  t.diagnostic(JSON.stringify({
    syntheticOnly: true, realAssemblyCertification: false,
    modelMiB: +(modelBytes / 1024 / 1024).toFixed(2), sourceMiB: 32,
    coldMs: +coldMs.toFixed(2),
    warmMeanMs: +(warm.reduce((sum, ms) => sum + ms, 0) / warm.length).toFixed(2),
    warmP95Ms: +warm.toSorted((a, b) => a - b)[18].toFixed(2),
    retainedFactBytes: stats.models.retainedBytes,
    modelReads: stats.modelReads, jsonParses: stats.jsonParses, validations: stats.modelValidations, sourceHashes: stats.sourceHashes,
  }));
});
