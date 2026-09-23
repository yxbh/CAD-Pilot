import assert from "node:assert/strict";
import test from "node:test";
import { changeView, initialState, topologyRevision } from "../server/protocol.mjs";
import { VIEW_PRESETS, MATERIAL_FINISHES } from "../shared/view-settings.mjs";
import { displayedWorldBounds } from "../shared/placement.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const model = {
  bounds: { min: [0, 0, 0], max: [3, 1, 1] },
  parts: [{ id: "shape", bounds: { min: [0, 0, 0], max: [1, 1, 1] }, positions: [0, 0, 0], faces: [], sectionCaps: true }],
  nodes: [
    { id: "a", partId: "shape", parentId: null, matrix: identity },
    { id: "b", partId: "shape", parentId: null, matrix: [...identity.slice(0, 12), 2, 0, 0, 1] },
  ],
};
test("axis cameras, projection and appearance settings validate without changing CAD state", () => {
  const original = { ...initialState(), selectedIds: ["b"], selectedFace: { nodeId: "b", faceId: "f2" }, explode: 0.7,
    camera: { position: [12, -10, 20], target: [1, 2, 3], up: [0, 0, 1], fov: 42 } };
  for (const preset of VIEW_PRESETS) assert.equal(changeView(original, model, "set_view", { preset }).cameraPreset, preset);
  const ortho = changeView(original, model, "set_projection", { projection: "orthographic" });
  assert.equal(ortho.projection, "orthographic");
  assert.equal(ortho.camera, original.camera);
  assert.equal(ortho.fitNonce, original.fitNonce);
  const studio = changeView(ortho, model, "set_appearance", { mode: "studio" });
  assert.equal(studio.showEdges, false);
  assert.equal(studio.camera, original.camera);
  assert.equal(studio.selectedFace, original.selectedFace);
  assert.equal(studio.explode, original.explode);
  assert.deepEqual(studio.selectedIds, original.selectedIds);
  assert.equal(changeView(studio, model, "set_appearance", { mode: "inspect" }).showEdges, true);
  for (const finish of MATERIAL_FINISHES) assert.equal(changeView(studio, model, "set_appearance", { finish }).materialFinish, finish);
  for (const [command, input] of [["set_projection", { projection: "fish" }], ["set_appearance", {}], ["set_appearance", { mode: "x" }],
    ["set_appearance", { finish: "x" }], ["set_appearance", { showEdges: 1 }], ["set_view", { preset: "up-ish" }]]) {
    assert.throws(() => changeView(original, model, command, input));
  }
});
test("commands preserve unrelated state and reject invalid IDs", () => {
  const selected = changeView(initialState(), model, "select_parts", { ids: ["a"] });
  const exploded = changeView(selected, model, "set_explode", { amount: 0.75, fixedId: "a", expectedRevision: selected.revision });
  assert.deepEqual(exploded.selectedIds, ["a"]);
  assert.equal(exploded.explode, 0.75);
  assert.equal(exploded.fixedId, "a");
  assert.throws(() => changeView(exploded, model, "select_parts", { ids: ["missing"] }), /Unknown part/);
  assert.throws(() => changeView(exploded, model, "set_explode", { amount: 2 }), /between/);
  assert.throws(() => changeView(exploded, model, "set_explode", { amount: NaN }), /between/);
  assert.throws(() => changeView(exploded, model, "fit_view", { expectedRevision: 0 }), /changed/);
});
test("visibility and reset are independent", () => {
  const hidden = changeView(initialState(), model, "set_visibility", { ids: ["b"], visible: false });
  const exploded = changeView(hidden, model, "set_explode", { amount: 1 });
  const reset = changeView(exploded, model, "reset_view", {});
  assert.deepEqual(reset.hiddenIds, ["b"]);
  assert.equal(reset.explode, 0);
  assert.deepEqual(changeView(reset, model, "show_all").hiddenIds, []);
});
test("explosion controls preserve the current camera until an explicit fit or view command", () => {
  for (const projection of ["perspective", "orthographic"]) {
    const camera = { position: [-123, -157, 94], target: [8, -3, 2], up: [0, 0, 1], fov: 42, projection, viewHeight: 137 };
    let state = { ...initialState(), camera, projection, cameraPreset: "front", fitNonce: 17, selectedIds: ["a"] };
    for (const input of [{ amount: 0.2 }, { amount: 1 }, { direction: "z" }, { fixedId: "a" }, { direction: "x" },
      { fixedId: "" }, { amount: 0 }]) {
      state = changeView(state, model, "set_explode", input);
      assert.equal(state.camera, camera, "Explosion must not discard a user-adjusted camera");
      assert.equal(state.fitNonce, 17, "Explosion must not request a camera fit");
      assert.equal(state.cameraPreset, "front");
      assert.equal(state.projection, projection);
    }
    state = changeView(state, model, "reset_view");
    assert.equal(state.camera, camera);
    assert.equal(state.fitNonce, 17);
    assert.deepEqual(state.selectedIds, ["a"]);
    for (const [name, input] of [["fit_view", {}], ["set_view", { preset: "top" }]]) {
      const fitted = changeView(state, model, name, input);
      assert.equal(fitted.fitNonce, 18);
      assert.equal(fitted.camera, null);
    }
  }
});
test("a fused single part cannot be exploded through agent commands", () => {
  assert.throws(() => changeView(initialState(), { nodes: [model.nodes[0]] }, "set_explode", { amount: 0.5 }), /no separate parts/);
});

test("auto-copy is independent of selection and never creates draft attachments", () => {
  const original = { ...initialState(), selectedIds: ["a"], explode: 0.7 };
  assert.equal(original.autoCopy, true);
  const disabled = changeView(original, model, "set_auto_copy", { enabled: false });
  assert.equal(disabled.autoCopy, false);
  assert.deepEqual(disabled.selectedIds, original.selectedIds);
  assert.equal(disabled.explode, 0.7);
  assert.equal(changeView(disabled, model, "reset_view").autoCopy, false);
  assert.equal(changeView(disabled, null, "set_auto_copy", { enabled: true }).autoCopy, true);
  assert.throws(() => changeView(original, model, "set_auto_copy", { enabled: "false" }), /enabled or disabled/);
  assert.throws(() => changeView(disabled, model, "set_auto_copy", { enabled: true, expectedRevision: 0 }), /view changed/);
});

test("section settings use original model-world millimeters, preserve the camera and reject unsupported input", () => {
  const bounds = { min: [10, -20, 30], max: [50, 20, 70] };
  const part = {
    id: "shape", sectionCaps: true, bounds,
    positions: [40, -1, 40, 45, -1, 40, 50, -1, 40],
    indices: [0, 1, 2], faces: [{ id: "f1", triangleStart: 0, triangleCount: 1 }],
    edges: [{ id: "e1", positions: [40, -1, 40, 50, -1, 40] }],
  };
  const sectionModel = {
    bounds, parts: [part],
    nodes: [{ id: "a", partId: "shape", parentId: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
  const camera = { position: [100, -80, 60], target: [20, 0, 40], up: [0, 0, 1], fov: 42 };
  let state = { ...initialState(), camera, fitNonce: 9, selectedIds: ["a"], selectedEdge: { nodeId: "a", edgeId: "e1" },
    section: { enabled: false, axis: "x", position: 30, flipped: false } };
  state = changeView(state, sectionModel, "set_section", { enabled: true });
  assert.deepEqual(state.section, { enabled: true, axis: "x", position: 30, flipped: false });
  assert.equal(state.camera, camera);
  assert.equal(state.fitNonce, 9);
  assert.equal(state.selectedEdge, null, "A selection fully outside the retained half is cleared");
  state = changeView(state, sectionModel, "set_section", { axis: "y" });
  assert.equal(state.section.position, 0, "Changing axes centers the plane in the new model bound");
  state = changeView(state, sectionModel, "set_section", { position: 5, flipped: true });
  assert.deepEqual(state.section, { enabled: true, axis: "y", position: 5, flipped: true });
  assert.equal(state.camera, camera);
  assert.throws(() => changeView(state, sectionModel, "set_section", { position: Infinity }), /finite/);
  assert.throws(() => changeView(state, sectionModel, "set_section", { position: 21 }), /between/);
  assert.throws(() => changeView(state, sectionModel, "set_section", { axis: "q" }), /X, Y or Z/);
  assert.throws(() => changeView(state, { ...sectionModel, parts: [{ ...part, sectionCaps: false }] }, "set_section", { enabled: true }),
    { code: "section_unsupported", message: /closed solid/ });
  const { sectionCaps, ...unknown } = part;
  assert.throws(() => changeView({ ...state, section: { ...state.section, enabled: false } }, { ...sectionModel, parts: [unknown] },
    "set_section", { enabled: true }), { code: "section_unsupported", message: /Reopen the STEP/ });
});

test("visible selections retain exact topology identity while section and explosion prune only discarded entities", () => {
  const bounds = { min: [-2, -1, -1], max: [2, 1, 1] };
  const part = {
    id: "shape", sectionCaps: true, bounds,
    positions: [-2, 0, 0, 0, 0, 0, 2, 0, 0], indices: [0, 1, 2],
    faces: [{ id: "f1", triangleStart: 0, triangleCount: 1 }],
    edges: [{ id: "e1", positions: [-2, 0, 0, 2, 0, 0] }],
  };
  const sectionModel = {
    bounds, parts: [part],
    nodes: [{ id: "a", partId: "shape", parentId: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
  let state = { ...initialState(), section: { enabled: true, axis: "x", position: 0, flipped: false } };
  state = changeView(state, sectionModel, "select_edge", { id: "a", edgeId: "e1", topologyRevision: undefined });
  assert.deepEqual(state.selectedEdge, { nodeId: "a", edgeId: "e1" });
  const retained = changeView(state, sectionModel, "set_section", { position: -1 });
  assert.equal(retained.selectedEdge, state.selectedEdge);
  const discarded = changeView(retained, sectionModel, "set_section", { position: -2, flipped: true });
  assert.equal(discarded.selectedEdge, retained.selectedEdge, "The boundary point remains a visible exact edge");
});

test("closed-solid metadata gives new caches their own identity while caches without it keep theirs", () => {
  const referenceModel = {
    schemaVersion: 2, source: { sha256: "a".repeat(64) }, units: "mm",
    parts: [{ id: "shape", positions: [0, 0, 0], normals: [1, 0, 0], indices: [0, 0, 0], bounds: { min: [0, 0, 0], max: [0, 0, 0] }, faces: [] }],
    nodes: [],
  };
  const before = topologyRevision(referenceModel);
  const solid = { ...referenceModel, parts: referenceModel.parts.map((part) => ({ ...part, sectionCaps: true })) };
  assert.notEqual(topologyRevision(solid), before, "Immutable caches cannot gain metadata under an existing identity");
  assert.notEqual(topologyRevision({ ...solid, parts: solid.parts.map((part) => ({ ...part, sectionCaps: false })) }), topologyRevision(solid));
  assert.equal(topologyRevision(structuredClone(referenceModel)), before);
});

test("section action bounds follow exploded visible occurrences and clamp only when the display contracts", () => {
  const bounds = { min: [10, 20, 30], max: [31, 24, 36] };
  const part = {
    id: "shape", sectionCaps: true, bounds: { min: [-1, -2, -3], max: [1, 2, 3] },
    positions: [-1, -2, -3, 1, 2, 3], indices: [0, 1, 1],
    faces: [{ id: "f1", triangleStart: 0, triangleCount: 1 }], edges: [],
  };
  const transformed = {
    bounds, parts: [part], topologyRevision: "t",
    nodes: [
      { id: "root", parentId: null, partId: null, matrix: [...identity.slice(0, 12), 11, 22, 33, 1] },
      { id: "fixed", parentId: "root", partId: "shape", matrix: identity },
      { id: "repeat", parentId: "root", partId: "shape", matrix: [...identity.slice(0, 12), 18, 0, 0, 1] },
    ],
  };
  const camera = { position: [100, -80, 60], target: [20, 0, 40], up: [0, 0, 1], fov: 42 };
  let state = {
    ...initialState(), camera, explode: 1, direction: "x", fixedId: "fixed",
    section: { enabled: true, axis: "x", position: 11, flipped: false },
  };
  const exploded = displayedWorldBounds(transformed, state);
  assert.ok(exploded.max[0] > transformed.bounds.max[0]);
  for (const [axis, index] of [["x", 0], ["y", 1], ["z", 2]]) {
    for (const position of [exploded.min[index], exploded.max[index]]) {
      state = changeView(state, transformed, "set_section", { axis, position });
      assert.equal(state.section.position, position);
      assert.equal(state.camera, camera);
    }
  }
  state = changeView(state, transformed, "set_section", { axis: "x", position: exploded.max[0], enabled: false });
  assert.equal(state.section.enabled, false);
  state = changeView(state, transformed, "set_section", { enabled: true });
  assert.equal(state.section.position, exploded.max[0]);
  const reassembled = changeView(state, transformed, "reset_view");
  const assembled = displayedWorldBounds(transformed, reassembled);
  assert.equal(reassembled.section.position, assembled.max[0]);
  assert.equal(reassembled.camera, camera);

  const reexploded = changeView(reassembled, transformed, "set_explode", { amount: 1, direction: "x", fixedId: "fixed" });
  const expanded = displayedWorldBounds(transformed, reexploded);
  state = changeView(reexploded, transformed, "set_section", { position: expanded.max[0] });
  const hiddenOutlier = changeView(state, transformed, "set_visibility", { ids: ["repeat"], visible: false });
  assert.equal(hiddenOutlier.section.position, displayedWorldBounds(transformed, hiddenOutlier).max[0]);
  const hiddenAll = changeView(hiddenOutlier, transformed, "set_visibility", { ids: ["fixed"], visible: false });
  assert.equal(hiddenAll.section.position, hiddenOutlier.section.position, "No visible parts preserves the last plane");
  assert.throws(() => changeView(hiddenAll, transformed, "set_section", { position: 0 }), /Show a part/);
  const shown = changeView(hiddenAll, transformed, "show_all");
  const shownBounds = displayedWorldBounds(transformed, shown);
  assert.ok(shown.section.position >= shownBounds.min[0] && shown.section.position <= shownBounds.max[0]);
});
