import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateMeshGeometry, validateModel } from "../server/protocol.mjs";
import { readModelCache } from "../server/model-import.mjs";
import { pruneRuntime } from "../server/runtime-store.mjs";
import { arrangeView } from "../shared/arrangement.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

// A 10 x 20 x 30 mm box as a binary STL triangle soup; `skip` leaves triangles out to open it.
const corners = [[-5, -10, -15], [5, -10, -15], [5, 10, -15], [-5, 10, -15], [-5, -10, 15], [5, -10, 15], [5, 10, 15], [-5, 10, 15]];
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
function boxStl({ skip = 0, scale = 1 } = {}) {
  const used = triangles.slice(skip);
  const bytes = Buffer.alloc(84 + used.length * 50);
  bytes.writeUInt32LE(used.length, 80);
  used.forEach((triangle, index) => triangle.forEach((vertex, corner) => corners[vertex].forEach((value, axis) =>
    bytes.writeFloatLE(value * scale, 84 + index * 50 + 12 + corner * 12 + axis * 4))));
  return bytes;
}

async function project(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-mesh-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "box.stl"), boxStl());
  await writeFile(path.join(root, "open.stl"), boxStl({ skip: 1 }));
  return root;
}

async function get(service, route) {
  return fetch(`${service.url}${route}`);
}

test("mesh files open directly with their frame, faults, geometry file and exact point references", { timeout: 120_000 }, async (t) => {
  const root = await project(t);
  const { createService, runtimeRoot } = await createTestRuntime(t);
  const service = await createService({ projectRoot: root, viewId: "mesh", file: "open.stl", log: () => {} });
  await service.initialize();
  let state = service.getState();
  assert.equal(state.error, "");
  assert.deepEqual(state.documents.map(({ id, kind, format, style }) => ({ id, kind, format, style })), [{ id: "main", kind: "mesh", format: "stl", style: "solid" }]);
  assert.equal(state.documents[0].frame.units, "mm");
  assert.equal(state.selectionMode, "point");
  assert.deepEqual(state.parts, [{ id: "node:1", label: "open", partId: "mesh:1" }]);

  const model = await (await get(service, "api/model")).json();
  assert.equal(model.kind, "mesh");
  assert.equal(model.parts[0].positions, undefined, "Geometry stays out of the JSON manifest");
  assert.deepEqual(model.parts[0].faults, { openEdges: 3, oversharedEdges: 0, flippedEdges: 0, degenerateTriangles: 0 });
  assert.equal(model.parts[0].closed, false);
  const geometry = await get(service, `api/geometry/${model.topologyRevision}`);
  assert.equal((await geometry.arrayBuffer()).byteLength, model.geometry.bytes);
  assert.equal((await get(service, `api/geometry/${"0".repeat(64)}`)).status, 404);
  const cached = await readModelCache(path.join(runtimeRoot, "models"), `${model.topologyRevision}.json`);
  assert.equal(cached.parts[0].positions.length, 24, "The cache reads back with its geometry attached");

  // Open meshes are cut without a cap rather than refused.
  state = await service.execute("set_section", { enabled: true, axis: "z", position: 0 });
  assert.equal(state.section.enabled, true);
  state = await service.execute("set_section", { enabled: false });

  // Triangle 0 of the file is now the first of the open box's remaining triangles: [0, 3, 2] of the bottom face.
  const centre = [0, 3, 2].map((vertex) => corners[vertex]).reduce((sum, point) => sum.map((value, axis) => value + point[axis] / 3), [0, 0, 0]);
  await assert.rejects(service.execute("select_point", { id: "node:1", triangle: 0, point: [0, 0, 10], topologyRevision: state.topologyRevision }), { code: "bad_point" });
  await assert.rejects(service.execute("select_point", { id: "node:1", triangle: 11, point: centre, topologyRevision: state.topologyRevision }), { code: "bad_point" });
  state = await service.execute("select_point", { id: "node:1", triangle: 0, point: centre, topologyRevision: state.topologyRevision });
  assert.equal(state.selectedPoint.triangle, 0);
  const summary = await service.summary();
  assert.deepEqual(summary.view.selected, ["open point -1.667, 3.333, -15"]);
  assert.equal(summary.model.frame.units, "mm", "The summary says how the mesh was read");
  const { reference, text } = state.selectedReferences[0];
  assert.match(reference, /\/t0@-1\.667,3\.333,-15$/);
  assert.match(text, /Point on triangle 0/);
  const inspected = await service.execute("inspect_reference", { reference });
  assert.deepEqual(inspected.point.normal, [0, 0, -1]);
  assert.ok(inspected.point.distanceToTriangle < 1e-3);
  assert.deepEqual(inspected.point.world, inspected.point.local);
  assert.equal(inspected.mesh.faults.openEdges, 3);
  assert.equal(inspected.snapshotStatus, "available");
  assert.match(inspected.workbenchRelativeSnapshot, /\.stl$/);
  await assert.rejects(service.execute("inspect_reference", { reference: reference.replace("@-1.667", "@4.9") }), /not on its triangle/);

  // The same file read in metres is a different, 1000 times larger model.
  const metres = await service.execute("load_file", { file: "open.stl", units: "m" });
  assert.notEqual(metres.topologyRevision, state.topologyRevision);
  assert.equal(metres.documents[0].frame.units, "m");
  assert.equal(metres.viewKept, false, "Reading it in other units is not a regeneration, so the view starts afresh");
  await assert.rejects(service.execute("load_file", { file: "open.stl", up: "x" }), { code: "bad_up" });
});

test("several files share a view in their own frames and keep their own references", { timeout: 180_000 }, async (t) => {
  const root = await project(t);
  const { createService, runtimeRoot } = await createTestRuntime(t);
  const service = await createService({ projectRoot: root, viewId: "files", file: "box.stl", log: () => {} });
  await service.initialize();
  let state = service.getState();
  const mainRevision = state.topologyRevision;
  const select = (id) => service.execute("select_parts", { ids: [id] }).then((next) => next.selectedReferences[0].reference);
  const mainReference = await select("node:1");

  state = await service.execute("add_file", { file: "open.stl", units: "m" });
  assert.equal(state.modelName, "box.stl + open.stl");
  assert.deepEqual(state.documents.map(({ id, style }) => [id, style]), [["main", "solid"], ["ref1", "ghost"]]);
  assert.deepEqual(state.parts.map(({ id, document }) => [id, document]), [["node:1", "main"], ["ref1/node:1", "ref1"]]);
  assert.notEqual(state.topologyRevision, mainRevision);
  assert.equal(await select("node:1"), mainReference, "Adding a file does not change the main file's references");
  const added = await select("ref1/node:1");
  assert.ok(added.startsWith(`cadproto:v2:${state.documents[1].topologyRevision}/node%3A1/`), "Added files' references name their own file");
  assert.equal((await service.execute("inspect_reference", { reference: added })).occurrence.label, "open");

  const composed = await (await get(service, "api/model")).json();
  assert.deepEqual(composed.bounds, { min: [-5000, -10000, -15000], max: [5000, 10000, 15000] });
  // Arranging files is view state: the composed model, its identity and the page's geometry stay as they are.
  const composedRevision = state.topologyRevision;
  state = await service.execute("set_layout", { mode: "side" });
  assert.equal(state.topologyRevision, composedRevision);
  assert.deepEqual(await (await get(service, "api/model")).json(), composed);
  const arranged = arrangeView(composed, state.documents, state.layout);
  assert.ok(arranged.nodes.find((node) => node.id === "doc:ref1").matrix[12] > 5, "Side by side moves the added file clear along X");
  assert.ok(arranged.nodes.filter((node) => node.documentId === "ref1").every((node) => node.ghost));
  assert.deepEqual(arranged.sourceBounds, composed.bounds, "The scene origin stays where the files are, not where they are shown");
  state = await service.execute("set_file", { id: "ref1", style: "solid", offset: [0, 0, 100], rotate: [0, 0, 90] });
  assert.equal(state.topologyRevision, composedRevision);
  assert.deepEqual(state.documents[1].offset, [0, 0, 100]);
  assert.ok(!arrangeView(composed, state.documents, state.layout).nodes.some((node) => node.ghost));
  // The compact summary says how each file was read and where it sits.
  const { view } = await service.summary();
  assert.equal(view.layout, "side");
  assert.deepEqual(view.files[1], { id: "ref1", name: "open.stl", frame: state.documents[1].frame, offset: [0, 0, 100], rotate: [0, 0, 90] });
  assert.equal(view.files[1].frame.units, "m");
  await assert.rejects(service.execute("set_file", { id: "ref1", offset: [0, 0] }), { code: "bad_placement" });
  await assert.rejects(service.execute("set_file", { id: "nope", style: "ghost" }), { code: "unknown_file" });
  await assert.rejects(service.execute("remove_file", { id: "main" }), { code: "main_file" });

  // Opening the main file again, as after regenerating it, keeps the files added beside it.
  state = await service.execute("load_file", { file: "box.stl" });
  assert.deepEqual(state.documents.map(({ id }) => id), ["main", "ref1"]);
  assert.equal(state.layout, "side");
  assert.deepEqual(state.documents[1].offset, [0, 0, 100]);

  // Restarting restores every file, its placement and the composite identity.
  const before = service.getState();
  await service.close();
  const restarted = await createService({ projectRoot: root, viewId: "files", log: () => {} });
  await restarted.initialize();
  const after = restarted.getState();
  assert.equal(after.error, "");
  assert.equal(after.topologyRevision, before.topologyRevision);
  assert.deepEqual(after.documents, before.documents);

  // Starting the viewer again with the main file, as `explorer.mjs open box.stl` does once it has stopped, also
  // brings the saved added files back rather than dropping them from the setup.
  await restarted.close();
  const reopened = await createService({ projectRoot: root, viewId: "files", file: "box.stl", log: () => {} });
  await reopened.initialize();
  assert.equal(reopened.getState().error, "");
  assert.deepEqual(reopened.getState().documents.map(({ id, offset }) => [id, offset]), [["main", [0, 0, 0]], ["ref1", [0, 0, 100]]]);
  assert.equal(reopened.getState().topologyRevision, before.topologyRevision);
  await reopened.close();
  // Pruning everything no saved setup shows keeps each file of this one: manifests, geometry files and sources.
  const pruned = await pruneRuntime(runtimeRoot, { all: true, now: Date.now() + 60 * 60 * 1000 });
  assert.deepEqual([pruned.removed.models, pruned.removed.inputs], [0, 0]);
  const again = await createService({ projectRoot: root, viewId: "files", log: () => {} });
  await again.initialize();
  assert.equal(again.getState().error, "");
  assert.deepEqual(again.getState().documents.map(({ id }) => id), ["main", "ref1"], "and the saved setup still lists them");

  state = await again.execute("remove_file", { id: "ref1" });
  assert.equal(state.topologyRevision, mainRevision, "Back to one unmoved file, the view is that file again");
  assert.equal(state.documents.length, 1);
});

test("a collapsed facet keeps the mesh closed, and points far from it are refused", { timeout: 120_000 }, async (t) => {
  const root = await project(t);
  // The closed box plus one facet whose corners collapse onto an edge, as CAD exports often leave.
  const box = boxStl();
  const bytes = Buffer.concat([box.subarray(0, 84), box.subarray(84), Buffer.alloc(50)]);
  bytes.writeUInt32LE(13, 80);
  [0, 0, 1].forEach((vertex, corner) => corners[vertex].forEach((value, axis) =>
    bytes.writeFloatLE(value, 84 + 12 * 50 + 12 + corner * 12 + axis * 4)));
  await writeFile(path.join(root, "collapsed.stl"), bytes);
  const { createService } = await createTestRuntime(t);
  const service = await createService({ projectRoot: root, viewId: "collapsed", file: "collapsed.stl", log: () => {} });
  await service.initialize();
  const model = await (await get(service, "api/model")).json();
  assert.equal(model.parts[0].closed, true, "A facet with a repeated corner bounds nothing and opens nothing");
  assert.deepEqual(model.parts[0].faults, { openEdges: 0, oversharedEdges: 0, flippedEdges: 0, degenerateTriangles: 1 });
  const revision = service.getState().topologyRevision;
  await assert.rejects(service.execute("select_point", { id: "node:1", triangle: 12, point: [500, 0, 0], topologyRevision: revision }), { code: "bad_point" });
  const state = await service.execute("select_point", { id: "node:1", triangle: 12, point: [0, -10, -15], topologyRevision: revision });
  const inspected = await service.execute("inspect_reference", { reference: state.selectedReferences[0].reference });
  assert.ok(Number.isFinite(inspected.point.distanceToTriangle) && inspected.point.distanceToTriangle < 1e-6);
  await assert.rejects(service.execute("inspect_reference", { reference: state.selectedReferences[0].reference.replace("@0,-10,-15", "@500,-10,-15") }),
    /not on its triangle/);
});

test("mesh caches are checked against their geometry file before use", { timeout: 120_000 }, async (t) => {
  const root = await project(t);
  const { createService, runtimeRoot } = await createTestRuntime(t);
  const service = await createService({ projectRoot: root, viewId: "cache", file: "box.stl", log: () => {} });
  await service.initialize();
  const models = path.join(runtimeRoot, "models");
  const revision = service.getState().topologyRevision;
  const manifest = JSON.parse(await readFile(path.join(models, `${revision}.json`), "utf8"));
  const bytes = await readFile(path.join(models, `${revision}.bin`));
  assert.throws(() => validateMeshGeometry(validateModel(structuredClone(manifest)), Buffer.from(bytes).fill(0, 0, 4)), /does not match/);
  const shifted = structuredClone(manifest);
  shifted.parts[0].buffers.indices.offset += 2;
  assert.throws(() => validateModel(shifted, { requireRevision: false }), /indices buffer/);
  const counted = structuredClone(manifest);
  counted.parts[0].faults.openEdges = 1;
  assert.throws(() => validateModel(counted, { requireRevision: false }), /openEdges buffer/);
  assert.throws(() => validateModel({ ...structuredClone(manifest), frame: { ...manifest.frame, up: "x" } }), /frame/);
  assert.throws(() => validateModel({ ...structuredClone(manifest), nodes: manifest.nodes.map((node) => ({ ...node, label: "renamed" })) }), /reference identity/);
});
