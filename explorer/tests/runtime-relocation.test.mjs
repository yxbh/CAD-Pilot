import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { relocateRuntime } from "../scripts/relocate-runtime.mjs";
import { createInspectionService } from "../server/inspection.mjs";
import { initialState, topologyRevision, validateModel } from "../server/protocol.mjs";
import { ReviewStore } from "../server/reviews.mjs";
import { acquireViewOwner } from "../server/view-owner.mjs";
import { createReference } from "../shared/references.mjs";
import { inspectionModel } from "./inspection-fixtures.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const viewKey = "a".repeat(24);
async function fixture(t) {
  const scratch = path.resolve(import.meta.dirname, "..", ".local");
  await mkdir(scratch, { recursive: true });
  const workbench = await mkdtemp(path.join(scratch, "relocation-test-"));
  t.after(() => rm(workbench, { recursive: true, force: true }));
  const source = path.join(workbench, "previous", ".runtime");
  const destination = path.join(workbench, "current", ".runtime");
  await mkdir(path.dirname(destination));
  await Promise.all(["inputs", "models", "views", "references", "reviews", "captures"].map((name) =>
    mkdir(path.join(source, name), { recursive: true })));
  const bytes = Buffer.from(`Synthetic inspection snapshot ${randomUUID()}`);
  const sha256 = hash(bytes);
  const inputFile = path.join(source, "inputs", `${sha256}.step`);
  await writeFile(inputFile, bytes);
  const model = inspectionModel(sha256);
  model.parts[0].edges = [{
    id: "e2", positions: [0, 0, 0, 1.125, 0, 0], curveType: "line", length: 1.125,
    center: [0.5625, 0, 0], bounds: { min: [0, 0, 0], max: [1.125, 0, 0] },
  }];
  model.cleanup = { degenerateEdges: 2, zeroAreaTriangles: 2 };
  model.topologyRevision = topologyRevision(model);
  const modelName = path.join("models", `${model.topologyRevision}.json`);
  await writeFile(path.join(source, modelName), JSON.stringify(model));
  const state = {
    ...initialState(), revision: 4, documentRevision: sha256, topologyRevision: model.topologyRevision,
    modelName: "Test model.step", selectedIds: [model.nodes[0].id],
    selectedEdge: { nodeId: model.nodes[0].id, edgeId: "e2" }, selectionMode: "edge", explode: 0.5,
  };
  const measuredCleanup = { topologyRevision: model.topologyRevision, counts: model.cleanup };
  const viewName = path.join("views", `${viewKey}.json`);
  const savedView = { state, inputFile, inputName: state.modelName, modelCache: path.basename(modelName), measuredCleanup };
  await writeFile(path.join(source, viewName), JSON.stringify(savedView));
  const inspection = createInspectionService({ runtimeRoot: source, workbenchRoot: workbench });
  const references = [createReference(model, model.nodes[0].id), createReference(model, model.nodes[0].id, "f1"),
    createReference(model, model.nodes[0].id, null, "e2")];
  const descriptors = [];
  for (const reference of references) {
    const prepared = await inspection.prepareClipboardReference(reference);
    const descriptor = JSON.parse(await readFile(prepared.filePath, "utf8"));
    descriptor.inspectionTool = "cad_explorer_prototype_inspect";
    await writeFile(prepared.filePath, JSON.stringify(descriptor));
    descriptors.push({ file: path.relative(source, prepared.filePath), descriptor });
  }
  const store = new ReviewStore(path.join(source, "reviews", viewKey));
  const capture = {
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
    width: 1, height: 1, camera: { position: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 42 },
  };
  const review = await store.create(capture, state, state.revision);
  const drawing = { past: [[]], future: [], present: [
    { id: "mark", tool: "pen", color: "#ff0000", width: 3, points: [[0.1, 0.2], [0.8, 0.7]] },
  ] };
  const savedReview = await store.save(review.id, drawing, review.version);
  const image = await store.saveImage(review.id, savedReview.version, capture.dataUrl);
  return { source, destination, workbench, model, modelName, viewName, savedView, descriptors, references, review: savedReview,
    unchanged: [path.relative(source, inputFile), modelName, path.relative(source, store.file(review.id)),
      path.relative(source, image.path), path.relative(source, `${image.path}.json`)] };
}

test("relocation preserves exact snapshots and annotated reviews while updating view and descriptor paths", async (t) => {
  const f = await fixture(t);
  const hashes = new Map(await Promise.all(f.unchanged.map(async (name) => [name, hash(await readFile(path.join(f.source, name)))])));
  const result = await relocateRuntime(f);
  assert.ok(result.files >= hashes.size + f.descriptors.length + 1);
  await assert.rejects(lstat(f.source), { code: "ENOENT" });
  for (const [name, sha] of hashes) assert.equal(hash(await readFile(path.join(f.destination, name))), sha);
  const movedModel = JSON.parse(await readFile(path.join(f.destination, f.modelName), "utf8"));
  validateModel(movedModel);
  assert.deepEqual(movedModel, f.model);
  const movedView = JSON.parse(await readFile(path.join(f.destination, f.viewName), "utf8"));
  assert.deepEqual(movedView, { ...f.savedView, inputFile: path.join(f.destination, "inputs", `${f.model.source.sha256}.step`) });
  const store = new ReviewStore(path.join(f.destination, "reviews", viewKey));
  assert.deepEqual(await store.get(f.review.id), f.review);
  const service = createInspectionService({ runtimeRoot: f.destination, workbenchRoot: f.workbench });
  for (const { file, descriptor } of f.descriptors) {
    const moved = JSON.parse(await readFile(path.join(f.destination, file), "utf8"));
    assert.equal(moved.inspectionTool, "cad_explorer_inspect");
    assert.equal(moved.reference, descriptor.reference);
    assert.equal(moved.workbenchRelativeSnapshot, path.relative(f.workbench, movedView.inputFile));
    const inspected = await service.inspectReference(moved.reference);
    assert.equal(inspected.snapshotStatus, "available");
    assert.deepEqual(inspected.face, descriptor.face);
    assert.deepEqual(inspected.edge, descriptor.edge);
    assert.deepEqual(inspected.originalWorldMatrix, descriptor.originalWorldMatrix);
    const copied = await service.prepareClipboardReference(moved.reference);
    assert.equal(copied.filePath, path.join(f.destination, file));
    assert.ok(!copied.text.includes(f.source));
  }
  assert.deepEqual(await readdir(path.join(f.workbench, ".local")), []);
});

test("relocation never merges or overwrites an existing destination", async (t) => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(path.join(f.destination, "keep"), "user data");
  await assert.rejects(relocateRuntime(f), /Destination already exists/);
  assert.equal(await readFile(path.join(f.destination, "keep"), "utf8"), "user data");
  assert.ok((await lstat(f.source)).isDirectory());
});

test("open saved views block relocation before any copy or path updates", async (t) => {
  const f = await fixture(t);
  const release = await acquireViewOwner(f.source, viewKey);
  const before = await readFile(path.join(f.source, f.viewName), "utf8");
  try {
    await assert.rejects(relocateRuntime(f), { code: "view_in_use" });
    assert.equal(await readFile(path.join(f.source, f.viewName), "utf8"), before);
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  } finally { await release(); }
  await relocateRuntime(f);
});

test("malformed path metadata fails without altering the source", async (t) => {
  const f = await fixture(t);
  const view = path.join(f.source, f.viewName);
  await writeFile(view, JSON.stringify({ ...f.savedView, inputFile: 123 }));
  await assert.rejects(relocateRuntime(f), /Invalid inputFile/);
  assert.equal(JSON.parse(await readFile(view, "utf8")).inputFile, 123);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  await writeFile(view, JSON.stringify(f.savedView));
  const file = path.join(f.source, f.descriptors[0].file);
  await writeFile(file, "{");
  await assert.rejects(relocateRuntime(f), SyntaxError);
  assert.equal(await readFile(file, "utf8"), "{");
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("source bounds, nested destinations and links cannot redirect relocation outside its runtime", async (t) => {
  const f = await fixture(t);
  await assert.rejects(relocateRuntime({ ...f, source: f.workbench }), /distinct, non-nested/);
  await assert.rejects(relocateRuntime({ ...f, destination: f.source }), /distinct, non-nested/);
  await mkdir(path.join(f.source, "nested"));
  await assert.rejects(relocateRuntime({ ...f, destination: path.join(f.source, "nested", ".runtime") }), /distinct, non-nested/);
  const link = path.join(f.source, "linked-view");
  try { await symlink(path.join(f.source, f.viewName), link, "file"); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("Symlinks require Windows permission"); return; } throw error; }
  await assert.rejects(relocateRuntime(f), /symlink or special file/);
  assert.ok((await lstat(link)).isSymbolicLink());
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});
