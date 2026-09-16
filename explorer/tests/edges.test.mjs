import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { changeView, initialState, topologyRevision, validateModel } from "../server/protocol.mjs";
import { composerAttachment } from "../server/composer.mjs";
import { createReference, formatSelection, parseReference, referenceEntity } from "../shared/references.mjs";
import { nativeReferenceTitle } from "../shared/native-reference.mjs";
import { inspectionFixture, inspectionModel } from "./inspection-fixtures.mjs";

function withEdges(model = inspectionModel("a".repeat(64))) {
  model.parts[0].edges = [{
    id: "e1", positions: [0, 0, 0, 1.125, 0, 0], curveType: "line", length: 1.125,
    center: [0.5625, 0, 0], bounds: { min: [0, 0, 0], max: [1.125, 0, 0] },
  }];
  model.topologyRevision = topologyRevision(model);
  return model;
}

test("native edge references preserve face argument order and reject ambiguous or invalid entities", () => {
  const model = withEdges();
  const id = model.nodes[0].id;
  const reference = createReference(model, id, null, "e1");
  assert.deepEqual(parseReference(formatSelection(model, id, null, "e1")), {
    topologyRevision: model.topologyRevision, nodeId: id, faceId: null, edgeId: "e1",
  });
  assert.match(formatSelection(model, id, null, "e1"), /Edge e1 \(line, 1.13 mm\)/);
  assert.notEqual(reference, createReference(model, model.nodes[1].id, null, "e1"));
  assert.equal(referenceEntity(model, id, null, "e1").edge, model.parts[0].edges[0]);
  assert.equal(referenceEntity(model, id, null, "e1").face, null);
  assert.equal(parseReference(createReference(model, id, "f1")).edgeId, null);
  assert.equal(parseReference(createReference(model, id)).edgeId, null);
  for (const bad of ["e0", "e01", "e-1", "e1/part", "e1junk"]) {
    assert.throws(() => parseReference(reference.replace("/e1", `/${bad}`)), /format/);
  }
  for (const operation of [referenceEntity, createReference, formatSelection]) {
    assert.throws(() => operation(model, id, "f1", "e1"), /not both/);
    assert.throws(() => operation(model, id, null, "e99"), /edge is not present/);
  }
  const legacy = inspectionModel("a".repeat(64));
  validateModel(legacy);
  assert.equal(legacy.topologyRevision, createHash("sha256").update(JSON.stringify({
    schemaVersion: legacy.schemaVersion, sourceHash: legacy.source.sha256,
    units: legacy.units, parts: legacy.parts, nodes: legacy.nodes,
  })).digest("hex"), "Legacy topology hashes keep their original public addresses");
  assert.equal(referenceEntity(legacy, id, "f1").edge, null);
  assert.throws(() => createReference(legacy, id, null, "e1"), /edge is not present/);
  assert.equal(nativeReferenceTitle("Module/Cover", null, "e1"), "Module · Cover · Edge e1");
  assert.throws(() => nativeReferenceTitle("Part", "f1", "e1"), /not both/);
});

test("edge selection is exact, mutually exclusive and cleared with hidden or replaced targets", () => {
  const model = withEdges();
  const id = model.nodes[0].id;
  const input = { id, edgeId: "e1", topologyRevision: model.topologyRevision };
  const state = { ...initialState(), topologyRevision: model.topologyRevision };
  assert.equal(state.selectedEdge, null);
  const face = changeView(state, model, "select_face", { id, faceId: "f1", topologyRevision: model.topologyRevision });
  const edge = changeView(face, model, "select_edge", input);
  assert.deepEqual(edge.selectedIds, [id]);
  assert.deepEqual(edge.selectedEdge, { nodeId: id, edgeId: "e1" });
  assert.equal(edge.selectedFace, null);
  assert.equal(edge.selectionMode, "edge");
  assert.deepEqual(changeView(edge, model, "set_explode", { amount: 1 }).selectedEdge, edge.selectedEdge);
  assert.equal(changeView(edge, model, "select_face", { id, faceId: "f1", topologyRevision: model.topologyRevision }).selectedEdge, null);
  assert.equal(changeView(edge, model, "select_parts", { ids: [id] }).selectedEdge, null);
  for (const mode of ["face", "part", "edge"]) assert.equal(changeView(edge, model, "set_selection_mode", { mode }).selectedEdge, null);
  assert.equal(changeView(edge, model, "isolate", { id: model.nodes[1].id }).selectedEdge, null);
  assert.deepEqual(changeView(edge, model, "isolate", { id }).selectedEdge, edge.selectedEdge);
  const hidden = changeView(edge, model, "set_visibility", { ids: [id], visible: false });
  assert.equal(hidden.selectedEdge, null);
  assert.throws(() => changeView(hidden, model, "select_edge", input), { code: "hidden_edge" });
  assert.throws(() => changeView(state, model, "select_edge", { ...input, topologyRevision: undefined }), { code: "stale_topology" });
  assert.throws(() => changeView(state, model, "select_edge", { ...input, topologyRevision: "b".repeat(64) }), { code: "stale_topology" });
  assert.throws(() => changeView(state, model, "select_edge", { ...input, edgeId: "e99" }), { code: "unknown_edge" });
  const attached = composerAttachment(model, edge, edge.revision);
  assert.match(attached.title, /Edge e1$/);
  assert.equal(attached.payload.references[0].edgeId, "e1");
  assert.equal(attached.payload.references[0].faceId, null);
  assert.equal(attached.payload.references[0].curveType, "line");
});

test("edge data validates independently and participates in immutable topology identity", () => {
  const model = withEdges();
  validateModel(model);
  const changed = structuredClone(model);
  changed.parts[0].edges[0].length = 4;
  assert.notEqual(topologyRevision(changed), model.topologyRevision);
  assert.throws(() => validateModel(changed), /reference identity/);
  for (const patch of [
    { id: "e0" }, { positions: [0, 0, 0] }, { positions: [0, 0, 0, 0, 0, 0] },
    { positions: [0, 0, 0, NaN, 0, 0] }, { positions: [0, 0, 0, 99, 0, 0] },
    { length: 0 }, { length: Infinity }, { center: [0, 0] }, { curveType: "" },
    { bounds: { min: [2, 0, 0], max: [1, 0, 0] } },
  ]) {
    const invalid = structuredClone(model);
    Object.assign(invalid.parts[0].edges[0], patch);
    assert.throws(() => validateModel(invalid, { requireRevision: false }), { code: "invalid_model" });
  }
  const duplicate = structuredClone(model);
  duplicate.parts[0].edges.push(duplicate.parts[0].edges[0]);
  assert.throws(() => validateModel(duplicate, { requireRevision: false }), /edge mapping/);
});

test("edge inspection retains compact facts and native descriptors with nested original placement", async (t) => {
  const fixture = await inspectionFixture(t);
  const { service, runtimeRoot } = fixture;
  const model = withEdges(fixture.model);
  model.nodes[0].partId = null;
  model.nodes[0].matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
  model.nodes[1].parentId = model.nodes[0].id;
  model.nodes[1].matrix[12] = 3;
  model.nodes[1].matrix[13] = 4;
  model.nodes[1].matrix[14] = 5;
  model.parts[0].edges[0].positions = Array.from({ length: 120_000 }, (_, i) => [0, 0, 0, 1.125, 0, 0][i % 6]);
  model.topologyRevision = topologyRevision(model);
  const file = path.join(runtimeRoot, "models", `${model.topologyRevision}.json`);
  await writeFile(file, JSON.stringify(model));
  const reference = createReference(model, model.nodes[1].id, null, "e1");
  const result = await service.inspectReference(reference);
  assert.equal(result.face, null);
  assert.equal(result.edge.id, "e1");
  assert.equal(result.edge.length, 1.125);
  assert.equal("positions" in result.edge, false);
  assert.deepEqual(result.edge.center, [0.5625, 0, 0]);
  assert.deepEqual(result.worldEdge.center, [6, 23.5625, 35]);
  assert.deepEqual(result.worldEdge.bounds, { min: [6, 23, 35], max: [6, 24.125, 35] });
  assert.ok(service.cacheStats().models.retainedBytes < 20_000, "Polyline arrays are not retained");
  result.edge.center[0] = 999;
  result.worldEdge.center[0] = 999;
  assert.deepEqual((await service.inspectReference(reference)).edge.center, [0.5625, 0, 0]);
  const chip = await service.prepareClipboardReference(reference);
  assert.match(chip.title, /Edge e1$/);
  const descriptor = JSON.parse(await readFile(chip.filePath, "utf8"));
  assert.equal(descriptor.edge.id, "e1");
  assert.equal(descriptor.face, null);
  assert.deepEqual(descriptor.worldEdge.center, [6, 23.5625, 35]);
  assert.equal(service.cacheStats().modelValidations, 1);
  model.parts[0].edges[0].positions[3] = 1;
  await writeFile(file, JSON.stringify(model));
  await assert.rejects(service.inspectReference(reference), /reference identity/);
});

test("pre-versioning schema-2 edge references remain exact and inspectable without rewriting snapshots", async (t) => {
  const { model: original, runtimeRoot, service } = await inspectionFixture(t);
  const model = withEdges(original);
  const currentRevision = model.topologyRevision;
  model.topologyRevision = createHash("sha256").update(JSON.stringify({
    schemaVersion: model.schemaVersion, sourceHash: model.source.sha256,
    units: model.units, parts: model.parts, nodes: model.nodes,
  })).digest("hex");
  assert.notEqual(model.topologyRevision, currentRevision);
  validateModel(model);
  const file = path.join(runtimeRoot, "models", `${model.topologyRevision}.json`);
  const bytes = JSON.stringify(model);
  await writeFile(file, bytes);
  const reference = createReference(model, model.nodes[1].id, null, "e1");
  const result = await service.inspectReference(reference);
  assert.equal(result.reference, reference);
  assert.equal(result.edge.id, "e1");
  assert.equal(result.edge.length, 1.125);
  const prepared = await service.prepareClipboardReference(reference);
  const descriptor = JSON.parse(await readFile(prepared.filePath, "utf8"));
  assert.equal(descriptor.reference, reference);
  assert.equal(descriptor.topologyRevision, model.topologyRevision);
  assert.equal(await readFile(file, "utf8"), bytes);
  model.parts[0].edges[0].length = 99;
  await writeFile(file, JSON.stringify(model));
  await assert.rejects(service.inspectReference(reference), /reference identity/);
});
