import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { changeView, initialState, loadedView, sameAssemblyTree } from "../server/protocol.mjs";
import { stateSummary } from "../server/summary.mjs";
import { angleView } from "../shared/view-settings.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x, y, z) => [...identity.slice(0, 12), x, y, z, 1];
const box = { min: [0, 0, 0], max: [10, 10, 10] };
const modelFor = (sha256, labels = ["base", "lid"], width = 10) => ({
  source: { sha256 }, topologyRevision: sha256.replace(/./g, "b"),
  bounds: { min: [0, 0, 0], max: [width, 10, 20] },
  parts: [{ id: "shape", bounds: { ...box, max: [width, 10, 10] }, positions: [0, 0, 0], faces: [{ id: "f1" }], sectionCaps: true }],
  nodes: [
    { id: "root", label: "jig", partId: null, parentId: null, matrix: identity },
    { id: "base", label: labels[0], partId: "shape", parentId: "root", matrix: identity },
    { id: "lid", label: labels[1], partId: "shape", parentId: "root", matrix: at(0, 0, 10) },
  ],
});
const loaded = (model, file = "outputs/jig.step") => ({
  documentRevision: model.source.sha256, topologyRevision: model.topologyRevision, modelName: path.basename(file || "jig.step"),
  source: { file, generatedAt: "", size: 1 }, assembly: null, loading: false, error: "",
});

test("a regenerated STEP keeps the view when its assembly tree still matches, otherwise only display preferences", () => {
  const previous = modelFor("1".repeat(64));
  let state = { ...initialState(), ...loaded(previous), revision: 7, fitNonce: 3 };
  state = changeView(state, previous, "set_visibility", { ids: ["lid"], visible: false });
  state = changeView(state, previous, "set_explode", { amount: 0.5, direction: "z" });
  state = changeView(state, previous, "set_section", { enabled: true, axis: "x", position: 9 });
  state = changeView(state, previous, "set_appearance", { mode: "studio" });
  state = { ...state, camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], fov: 42 }, cameraPinned: true };

  // Narrower geometry under the same names keeps everything; the plane is clamped into the new extent.
  const regenerated = modelFor("2".repeat(64), ["base", "lid"], 6);
  assert.ok(sameAssemblyTree(previous, regenerated));
  const kept = loadedView(state, previous, regenerated, loaded(regenerated));
  assert.equal(kept.viewKept, true);
  assert.deepEqual([kept.hiddenIds, kept.explode, kept.direction, kept.camera, kept.cameraPinned, kept.fitNonce],
    [["lid"], 0.5, "z", state.camera, true, 3]);
  assert.equal(kept.section.enabled, true);
  assert.ok(kept.section.position <= 6, "the kept plane stays inside the regenerated parts");
  assert.equal(kept.appearance, "studio");

  // A camera nobody moved is the previous geometry's fit, so it is fitted again.
  const fitted = loadedView({ ...state, cameraPinned: false }, previous, regenerated, loaded(regenerated));
  assert.deepEqual([fitted.viewKept, fitted.camera, fitted.fitNonce, fitted.explode], [true, null, 4, 0.5]);

  const renamed = modelFor("3".repeat(64), ["base", "cover"]);
  assert.ok(!sameAssemblyTree(previous, renamed));
  const reset = loadedView(state, previous, renamed, loaded(renamed));
  assert.equal(reset.viewKept, false);
  assert.deepEqual([reset.hiddenIds, reset.explode, reset.camera, reset.cameraPinned, reset.section.enabled, reset.fitNonce],
    [[], 0, null, false, false, 4]);
  assert.equal(reset.appearance, "studio", "display preferences belong to the person and survive any reload");
  assert.equal(loadedView(initialState(), null, renamed, loaded(renamed)).viewKept, null, "a first load has nothing to keep");
  // Another file can share the node ids (positions in the file) and unnamed labels; it never inherits the view.
  const other = loadedView(state, previous, regenerated, loaded(regenerated, "outputs/clip.step"));
  assert.deepEqual([other.viewKept, other.camera, other.explode, other.section.enabled], [false, null, 0, false]);
  // Uploads have no project path: the same file name keeps the view, another name does not.
  const uploaded = { ...state, source: { file: "", generatedAt: "", size: 1 }, modelName: "jig.step" };
  assert.equal(loadedView(uploaded, previous, regenerated, loaded(regenerated, "")).viewKept, true);
  assert.equal(loadedView(uploaded, previous, regenerated, { ...loaded(regenerated, ""), modelName: "clip.step" }).viewKept, false);
  // The next view change clears the news.
  assert.equal(changeView(kept, regenerated, "fit_view").viewKept, null);
});

test("an unnamed single part, labelled after its changing snapshot, still counts as the same tree", () => {
  const single = (sha256) => ({ source: { sha256 }, nodes: [{ id: "node:0:1:1:1", label: sha256, partId: "part:1", parentId: null }] });
  assert.ok(sameAssemblyTree(single("4".repeat(64)), single("5".repeat(64))));
  assert.ok(!sameAssemblyTree(null, single("5".repeat(64))));
  // Beside other files the part is labelled after its own file's snapshot, which the view lists.
  const beside = (sha256) => ({
    source: { sha256: "c".repeat(64) }, documents: [{ id: "main", sha256 }, { id: "ref1", sha256: "d".repeat(64) }],
    nodes: [
      { id: "doc:main", label: "jig.step", partId: null, parentId: null }, { id: "node:0:1:1:1", label: sha256, partId: "part:1", parentId: "doc:main" },
      { id: "doc:ref1", label: "scan.stl", partId: null, parentId: null }, { id: "ref1/node:1", label: "scan", partId: "ref1/mesh:1", parentId: "doc:ref1" },
    ],
  });
  assert.ok(sameAssemblyTree(beside("4".repeat(64)), beside("5".repeat(64))));
});

test("views can be chosen by azimuth and elevation", () => {
  const model = modelFor("6".repeat(64));
  const state = { ...initialState(), ...loaded(model), cameraPinned: true, camera: { position: [1, 1, 1], target: [0, 0, 0], up: [0, 0, 1], fov: 42 } };
  const angled = changeView(state, model, "set_view", { azimuth: 45, elevation: 32.123 });
  assert.deepEqual([angled.cameraPreset, angled.camera, angled.cameraPinned], ["45:32.12", null, false]);
  assert.throws(() => changeView(state, model, "set_view", { azimuth: 45 }), /azimuth from -360 to 360 and an elevation/);
  assert.throws(() => changeView(state, model, "set_view", { preset: "top", azimuth: 0, elevation: 0 }), /not both/);
  const rounded = (vector) => vector.map((value) => Math.round(value * 1e9) / 1e9 + 0);
  assert.deepEqual(rounded(angleView("0:0").direction), [0, -1, 0]);
  assert.deepEqual(rounded(angleView("90:0").direction), [1, 0, 0]);
  assert.deepEqual(rounded(angleView("0:90").up), [0, 1, 0], "straight down keeps +Y up the screen, like the top view");
  assert.equal(angleView("top"), null);
});

test("the summary names the model's revision and says plainly when nobody has seen the view", () => {
  const model = modelFor("7".repeat(64));
  const base = {
    ...initialState(), ...loaded(model), revision: 4, modelName: "jig.step",
    source: { file: "outputs/jig.step", generatedAt: "2026-10-31T09:00:00.000Z", size: 10, sha256: "7".repeat(64) },
    parts: [{ id: "base", label: "base" }, { id: "lid", label: "lid" }], hiddenIds: ["lid"],
    selectedIds: ["base"], selectedFace: { nodeId: "base", faceId: "f1" }, rendered: null,
    renderers: { viewers: 0, seen: false, headless: true, drawn: "headless" },
  };
  const summary = stateSummary(base, { url: "http://127.0.0.1:1/token/" });
  assert.deepEqual(summary.model, { name: "jig.step", file: "outputs/jig.step", revision: "777777777777", generatedAt: "2026-10-31T09:00:00.000Z", parts: 2 });
  assert.deepEqual(summary.view.hidden, ["lid"]);
  assert.deepEqual(summary.view.selected, ["base face f1"]);
  assert.equal(summary.view.section, "off");
  assert.equal(summary.note, "No viewer page is open; the view was drawn in the background. Open http://127.0.0.1:1/token/ to see it.");
  const hidden = stateSummary({ ...base, renderers: { viewers: 1, seen: false, headless: true, drawn: "headless" } }, { url: "u" });
  assert.match(hidden.note, /has not drawn this revision yet; it may be hidden/);
  const seen = stateSummary({ ...base, renderers: { viewers: 1, seen: true, headless: false, drawn: "viewer" } }, { url: "u" });
  assert.equal(seen.note, undefined);
  const changed = stateSummary(base, { url: "u", changedOnDisk: true });
  assert.equal(changed.model.changedOnDisk, true);
  assert.match(changed.note, /^outputs\/jig\.step changed on disk after it was loaded; run open again/);
  const many = stateSummary({ ...base, hiddenIds: Array.from({ length: 30 }, (_, index) => `part-${index}`) }, { url: "u" });
  assert.equal(many.view.hidden.length, 21);
  assert.equal(many.view.hidden.at(-1), "+10 more");
  // A view of several files identifies itself by all of them, but the revision is the main file's own.
  const compared = stateSummary({ ...base, documentRevision: "c".repeat(64) }, { url: "u" });
  assert.equal(compared.model.revision, "777777777777");
  // A problem that already names the address does not repeat it.
  const timedOut = stateSummary({ ...base, renderers: { viewers: 1, seen: false, headless: false, drawn: null } },
    { url: "http://127.0.0.1:1/token/", problem: "No renderer drew the view within 90 s. Open http://127.0.0.1:1/token/ and retry." });
  assert.equal(timedOut.note, "The model loaded, but no renderer could draw it: No renderer drew the view within 90 s. Open http://127.0.0.1:1/token/ and retry.");
});
