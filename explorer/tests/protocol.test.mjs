import assert from "node:assert/strict";
import test from "node:test";
import { changeView, initialState } from "../server/protocol.mjs";
import { VIEW_PRESETS, MATERIAL_FINISHES } from "../shared/view-settings.mjs";

const model = { nodes: [{ id: "a", partId: "shape" }, { id: "b", partId: "shape" }] };
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
