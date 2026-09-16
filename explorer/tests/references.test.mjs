import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createReference, formatSelection, parseReference } from "../shared/references.mjs";
import { changeView, initialState, topologyRevision, validateModel } from "../server/protocol.mjs";
import { createInspectionService } from "../server/inspection.mjs";
import { runtimeRoot, workbenchRoot } from "../server/paths.mjs";
import { inspectionFixture } from "./inspection-fixtures.mjs";

function fixture() {
  const bounds = { min: [0, 0, 0], max: [1, 1, 0] };
  const model = {
    schemaVersion: 2, source: { name: "fixture.step", sha256: "f".repeat(64) }, units: "mm", warnings: [], bounds,
    parts: [{
      id: "shape", label: "Plate", color: [1, 0, 0], bounds,
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3],
      faces: [{ id: "f1", triangleStart: 0, triangleCount: 2, area: 1, center: [0.5, 0.5, 0], surfaceType: "plane", bounds }],
    }],
    nodes: ["node:root/a", "node:root/b"].map((id) => ({
      id, label: id, parentId: null, partId: "shape", color: [1, 0, 0],
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    })),
  };
  model.topologyRevision = topologyRevision(model);
  return model;
}

test("references are occurrence-specific, readable and not imported @cad identifiers", () => {
  const model = fixture();
  validateModel(model);
  const first = createReference(model, model.nodes[0].id, "f1");
  const second = createReference(model, model.nodes[1].id, "f1");
  assert.notEqual(first, second);
  const parsed = parseReference(formatSelection(model, model.nodes[0].id, "f1"));
  assert.deepEqual(parsed, { topologyRevision: model.topologyRevision, nodeId: model.nodes[0].id, faceId: "f1", edgeId: null });
  assert.throws(() => parseReference("@cad[fixture#f1]"), /exactly one/);
  assert.throws(() => parseReference(first + "\n" + second), /exactly one/);
  assert.throws(() => parseReference(first.replace("/f1", "/f1junk")), /format/);
  model.nodes[0].id = "x".repeat(4097);
  assert.throws(() => createReference(model, model.nodes[0].id, "f1"), /identity/);
});

test("topology output changes invalidate references even when STEP bytes do not change", () => {
  const model = fixture();
  const previous = model.topologyRevision;
  model.parts[0].faces[0].id = "f2";
  assert.notEqual(topologyRevision(model), previous);
  assert.throws(() => validateModel(model), /reference identity/);
  model.topologyRevision = topologyRevision(model);
  const state = initialState();
  assert.throws(() => changeView(state, model, "select_face", { id: model.nodes[0].id, faceId: "f2", topologyRevision: previous }), /older model/);
  const selected = changeView(state, model, "select_face", { id: model.nodes[0].id, faceId: "f2", topologyRevision: model.topologyRevision });
  const exploded = changeView(selected, model, "set_explode", { amount: 1 });
  assert.deepEqual(exploded.selectedFace, selected.selectedFace);
  assert.equal(createReference(model, model.nodes[0].id, "f2"), createReference(model, exploded.selectedFace.nodeId, exploded.selectedFace.faceId));
  const hidden = changeView(selected, model, "set_visibility", { ids: [model.nodes[0].id], visible: false });
  assert.equal(hidden.selectedFace, null);
  assert.throws(() => changeView(hidden, model, "select_face", { id: model.nodes[0].id, faceId: "f2", topologyRevision: model.topologyRevision }), /Show this part/);
});

test("face maps cannot omit or overlap render triangles", () => {
  const model = fixture();
  model.parts[0].faces[0].triangleCount = 1;
  assert.throws(() => validateModel(model, { requireRevision: false }), /cover the final triangles/);
});

test("a pasted reference resolves from immutable cache without its original canvas", async (t) => {
  const { model, modelFile: file, sourceFile, service: { inspectReference } } = await inspectionFixture(t);
  await unlink(sourceFile);
  try {
    const result = await inspectReference(formatSelection(model, model.nodes[1].id, "f1"));
    assert.equal(result.occurrence.id, model.nodes[1].id);
    assert.equal(result.face.triangleCount, 2);
    assert.equal(result.face.area, 1.6875);
    assert.deepEqual(result.originalWorldMatrix, model.nodes[1].matrix);
    assert.equal(result.workbenchRelativeSnapshot, null);
    assert.equal("snapshotPath" in result, false);
    await assert.rejects(inspectReference(createReference(model, model.nodes[0].id, "f1").replace("/f1", "/f99")), /not present/);
    const changed = structuredClone(model);
    changed.parts[0].indices = [0, 2, 1, 0, 2, 3];
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(inspectReference(createReference(model, model.nodes[0].id, "f1")), /reference identity/);
  } finally {
    await unlink(file);
  }
  await assert.rejects(inspectReference(createReference(model, model.nodes[0].id, "f1")), /no longer cached/);
});

test("legacy chip descriptors exist before preparation resolves and remain inspectable after service restart", async (t) => {
  assert.equal(runtimeRoot, path.join(workbenchRoot, ".github", "extensions", "cad-explorer-prototype", ".runtime"));
  const fixture = await inspectionFixture(t);
  const { service, reference, model } = fixture;
  const prepared = await service.prepareClipboardReference(reference);
  const hash = createHash("sha256").update(reference).digest("hex");
  assert.equal(prepared.filePath, path.join(fixture.runtimeRoot, "references", `${hash}.json`));
  assert.ok(path.isAbsolute(prepared.filePath));
  assert.ok(prepared.text.startsWith('<copilot-ref kind="file" '));
  const descriptor = JSON.parse(await readFile(prepared.filePath, "utf8"));
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.kind, "cad-prototype-selection");
  assert.equal(descriptor.inspectionTool, "cad_explorer_prototype_inspect");
  assert.equal(descriptor.reference, reference);
  assert.equal(descriptor.topologyRevision, model.topologyRevision);
  assert.equal(descriptor.occurrence.id, model.nodes[0].id);
  assert.equal(descriptor.face.id, "f1");
  const restarted = createInspectionService({ runtimeRoot: fixture.runtimeRoot, workbenchRoot: fixture.workbenchRoot });
  const resolved = await restarted.inspectReference(descriptor.reference);
  assert.deepEqual(resolved.face, descriptor.face);
  assert.deepEqual(resolved.originalWorldMatrix, descriptor.originalWorldMatrix);
  assert.equal((await restarted.prepareClipboardReference(reference)).filePath, prepared.filePath);
});
