import assert from "node:assert/strict";
import test from "node:test";
import { importDiagnostics } from "../shared/diagnostics.mjs";
import { topologyRevision, validateModel } from "../server/protocol.mjs";
import { inspectionModel } from "./inspection-fixtures.mjs";

test("legacy generic limitations are not reported as model-specific import warnings", () => {
  const messages = [
    "Prototype preview: part-level RGB only; PMI, layers, materials, textures and saved views are not represented.",
    "STEP transfer: actual file warning",
    "Transparency is unsupported; transparent parts are shown opaque.",
    "Zero-area tessellation triangles were omitted.",
  ];
  assert.deepEqual(importDiagnostics({ warnings: messages }), {
    warnings: messages.slice(1, 3), cleanup: { degenerateEdges: 0, zeroAreaTriangles: null },
  });
  assert.equal(messages.length, 4);
});

test("only exact historical cleanup messages become information, without inventing counts", () => {
  const real = [
    "STEP transfer: Degenerate CAD edge e1 was omitted from edge selection.",
    "Zero-length CAD edge e2 was omitted from edge selection.",
    "Degenerate CAD edge e01 was omitted from edge selection.",
    "Degenerate CAD edge e3 was omitted from edge selection. Unexpected data.",
    "Zero-area tessellation triangles were omitted. Face missing.",
    "Standalone points are unsupported and are not drawn.",
  ];
  const model = { warnings: [
    ...real, "Zero-area tessellation triangles were omitted.",
    ...Array.from({ length: 150 }, (_, i) => `Degenerate CAD edge e${i + 1} was omitted from edge selection.`),
  ] };
  const before = structuredClone(model);
  const result = importDiagnostics(model);
  assert.deepEqual(result, { warnings: real, cleanup: { degenerateEdges: null, zeroAreaTriangles: null } });
  assert.deepEqual(model, before);
  assert.deepEqual(importDiagnostics(result), result, "Normalization is idempotent");
});

test("current counters stay exact and do not reinterpret warnings or change topology", () => {
  const model = inspectionModel("a".repeat(64));
  model.cleanup = { degenerateEdges: 130, zeroAreaTriangles: 72 };
  model.warnings = ["STEP transfer: actual file warning", "Zero-area tessellation triangles were omitted."];
  const normalized = { ...model, ...importDiagnostics(model) };
  assert.deepEqual(normalized, model);
  assert.equal(topologyRevision(normalized), model.topologyRevision);
  validateModel(normalized);
  normalized.cleanup.degenerateEdges = null;
  validateModel(normalized);
  assert.equal(model.cleanup.degenerateEdges, 130, "Do not mutate the cached diagnostic object");
});

test("cleanup counts are optional for old models, bounded and validated independently of topology", () => {
  const model = inspectionModel("a".repeat(64));
  validateModel(model);
  for (const cleanup of [
    null, [], {}, { degenerateEdges: 0 }, { degenerateEdges: -1, zeroAreaTriangles: 0 },
    { degenerateEdges: 0.5, zeroAreaTriangles: 0 }, { degenerateEdges: "2", zeroAreaTriangles: 0 },
    { degenerateEdges: 200_001, zeroAreaTriangles: 0 }, { degenerateEdges: 0, zeroAreaTriangles: 1_000_001 },
    { degenerateEdges: 0, zeroAreaTriangles: NaN }, { degenerateEdges: 0, zeroAreaTriangles: Infinity },
    { degenerateEdges: 1, zeroAreaTriangles: 1, extra: 1 },
  ]) assert.throws(() => validateModel({ ...model, cleanup }), /Invalid display cleanup diagnostics/);
  validateModel({ ...model, cleanup: { degenerateEdges: null, zeroAreaTriangles: null } });
  validateModel({ ...model, cleanup: { degenerateEdges: 200_000, zeroAreaTriangles: 1_000_000 } });
  const broken = structuredClone(model);
  broken.parts[0].faces = [];
  assert.throws(() => validateModel({ ...broken, ...importDiagnostics(broken) }), /Missing CAD face map/);
});
