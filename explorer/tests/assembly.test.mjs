import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readSequence, resolveSequence, sequencePath } from "../server/assembly.mjs";
import { changeView, initialState } from "../server/protocol.mjs";
import { COMMANDS } from "../shared/commands.mjs";
import { displayedWorldBounds, placeParts, sequencePose } from "../shared/placement.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x, y, z) => [...identity.slice(0, 12), x, y, z, 1];
const box = { min: [0, 0, 0], max: [1, 1, 1] };
// Base with a two-pin group and a cap; the group's parts are only reachable through its label.
const model = {
  source: { sha256: "a".repeat(64) },
  bounds: { min: [0, 0, 0], max: [4, 1, 3] },
  parts: [{ id: "shape", bounds: box, positions: [0, 0, 0], faces: [{ id: "f1" }], sectionCaps: true }],
  nodes: [
    { id: "root", label: "jig", partId: null, parentId: null, matrix: identity },
    { id: "base", label: "base", partId: "shape", parentId: "root", matrix: identity },
    { id: "pins", label: "pins", partId: null, parentId: "root", matrix: at(0, 0, 1) },
    { id: "pin-1", label: "pin_1", partId: "shape", parentId: "pins", matrix: identity },
    { id: "pin-2", label: "pin_2", partId: "shape", parentId: "pins", matrix: at(2, 0, 0) },
    { id: "cap", label: "cap", partId: "shape", parentId: "root", matrix: at(0, 0, 2) },
  ],
};
const document = (steps, sha256 = model.source.sha256) => ({
  format: "cad-explorer-assembly", version: 1, units: "mm", step: { file: "jig.step", sha256 }, steps,
});
const sequenceSteps = [
  { title: "Drop in the pins", parts: ["pins"], from: [0, 0, 10] },
  { title: "Press on the cap", note: "Square it up", parts: ["cap", "pin_?"], from: [0, 0, 20],
    check: { status: "blocked", detail: "cap overlaps base after 1 mm" } },
];
const sequence = resolveSequence(document(sequenceSteps), model, "outputs/jig.assembly.json");
const placed = (state, position) => Object.fromEntries(placeParts(model, 0, "radial", "", sequencePose(state, position))
  .map((placement) => [placement.node.id, placement.matrix.slice(12, 15)]));

test("sequence labels resolve groups and wildcards to parts, and report what they cannot find", () => {
  assert.equal(sequence.stale, false);
  assert.match(sequence.digest, /^[a-f0-9]{64}$/);
  assert.equal(resolveSequence(document(structuredClone(sequenceSteps)), model, "outputs/jig.assembly.json").digest, sequence.digest,
    "the same file resolves to the same digest");
  assert.deepEqual(sequence.steps.map((step) => step.nodeIds), [["pin-1", "pin-2"], ["cap", "pin-1", "pin-2"]]);
  assert.deepEqual(sequence.steps[1].check, { status: "blocked", detail: "cap overlaps base after 1 mm" });
  const other = resolveSequence(document([{ title: "Lid", parts: ["lid", "cap"], from: [0, 0, 1] }], "b".repeat(64)), model, "x");
  assert.equal(other.stale, true);
  assert.notEqual(other.digest, sequence.digest);
  assert.deepEqual(other.steps[0].unresolved, ["lid"]);
  assert.deepEqual(other.steps[0].nodeIds, ["cap"]);
  // Only * and ? are wildcards, as in the exporter; brackets and dots are literal.
  const literal = resolveSequence(document([{ title: "Pins", parts: ["pin_[12]", "pin.1"], from: [0, 0, 1] }]), model, "x");
  assert.deepEqual(literal.steps[0].unresolved, ["pin_[12]", "pin.1"]);
  for (const steps of [[], [{ title: "", parts: ["cap"], from: [0, 0, 1] }], [{ title: "A", parts: [], from: [0, 0, 1] }],
    [{ title: "A", parts: ["cap"], from: [0, 1] }], [{ title: "A", parts: ["cap"], from: [0, 0, Infinity] }],
    [{ title: "A", parts: ["cap"], from: [0, 0, 1], check: { status: "fine" } }]]) {
    assert.throws(() => resolveSequence(document(steps), model, "x"), /Assembly sequence/);
  }
  assert.throws(() => resolveSequence({ ...document([{ title: "A", parts: ["cap"], from: [0, 0, 1] }]), format: "other" }, model, "x"), /format/);
  // The root "jig" and any wrapper holding every part never match, so a broad pattern cannot move the whole model.
  const wrapped = { ...model, nodes: [{ id: "wrapper", label: "jig v3", partId: null, parentId: null, matrix: identity },
    ...model.nodes.map((node) => node.parentId === null ? { ...node, parentId: "wrapper" } : node)] };
  const broad = resolveSequence(document([{ title: "All", parts: ["jig*", "p*"], from: [0, 0, 1] }]), wrapped, "x");
  assert.deepEqual(broad.steps[0].unresolved, ["jig*"]);
  assert.deepEqual(broad.steps[0].nodeIds, ["pin-1", "pin-2"], "subgroups and parts still match");
  // A pattern that resolves to every part, such as "*" or a prefix every label shares, is refused like the exporter does.
  assert.throws(() => resolveSequence(document([{ title: "All", parts: ["*"], from: [0, 0, 1] }]), model, "x"), /step 1 moves every part/);
  assert.throws(() => resolveSequence(document([{ title: "Some", parts: ["cap"], from: [0, 0, 1] }, { title: "All", parts: ["base", "p*", "cap"], from: [0, 0, 1] }]), model, "x"), /step 2 moves every part/);
});

test("a group nobody labelled never matches, as in the cad skill's matcher, while its parts still do", () => {
  // The converter names an unlabelled group after its parent ("jig 2"); only someone's own label is a group to match.
  const unnamed = { ...model, nodes: model.nodes.map((node) => node.id === "pins" ? { ...node, label: "jig 2", labelled: false } : node) };
  const steps = resolveSequence(document([{ title: "Pins", parts: ["jig 2", "pin_*"], from: [0, 0, 1] }]), unnamed, "x").steps;
  assert.deepEqual(steps[0].unresolved, ["jig 2"]);
  assert.deepEqual(steps[0].nodeIds, ["pin-1", "pin-2"]);
});

test("steps place parts from their offsets, carry earlier parts and animate fractional positions", () => {
  const state = { ...initialState(), assembly: sequence, step: 0 };
  assert.deepEqual(placed(state, 0), { base: [0, 0, 0], "pin-1": [0, 0, 31], "pin-2": [2, 0, 31], cap: [0, 0, 22] });
  assert.deepEqual(placed(state, 1), { base: [0, 0, 0], "pin-1": [0, 0, 21], "pin-2": [2, 0, 21], cap: [0, 0, 22] });
  assert.deepEqual(placed(state, 1.5), { base: [0, 0, 0], "pin-1": [0, 0, 11], "pin-2": [2, 0, 11], cap: [0, 0, 12] });
  assert.deepEqual(placed(state, 2), { base: [0, 0, 0], "pin-1": [0, 0, 1], "pin-2": [2, 0, 1], cap: [0, 0, 2] });
  assert.deepEqual(placed({ ...state, step: null }, null), placed(state, 2));
  const buildup = { ...state, stepMode: "buildup" };
  assert.deepEqual(Object.keys(placed(buildup, 0)), ["base"]);
  assert.deepEqual(Object.keys(placed(buildup, 0.25)), ["base", "pin-1", "pin-2"]);
  assert.deepEqual(Object.keys(placed(buildup, 1)), ["base", "pin-1", "pin-2"]);
  assert.deepEqual(displayedWorldBounds(model, { ...buildup, step: 0 }), box);
  const trail = placeParts(model, 0, "radial", "", sequencePose(state, 1)).find((item) => item.node.id === "cap");
  assert.deepEqual(trail.offset, [0, 0, 20]);
});

test("set_step validates the range, switches off automatic explosion and is cleared by explosion or reassembly", () => {
  const base = { ...initialState(), explode: 0.4, assembly: sequence, selectedFace: { nodeId: "cap", faceId: "f1" }, selectedIds: ["cap"] };
  const first = changeView(base, model, "set_step", { step: 0, mode: "buildup" });
  assert.equal(first.step, 0);
  assert.equal(first.stepMode, "buildup");
  assert.equal(first.explode, 0);
  assert.equal(first.selectedFace, null, "a part hidden until its step cannot keep a face selection");
  assert.throws(() => changeView(first, model, "select_face", { id: "cap", faceId: "f1", topologyRevision: undefined }), /Show this part/);
  assert.equal(changeView(first, model, "set_step", { mode: "exploded" }).step, 0);
  for (const input of [{ step: 3 }, { step: -1 }, { step: 1.5 }, { mode: "sideways" }, {}]) {
    assert.throws(() => changeView(first, model, "set_step", input));
  }
  assert.throws(() => changeView(initialState(), model, "set_step", { step: 0 }), /no assembly sequence/);
  assert.equal(changeView(first, model, "set_step", { step: null }).step, null);
  assert.equal(changeView(first, model, "set_step", { off: true }).step, null);
  assert.throws(() => changeView(first, model, "set_step", { off: true, step: 1 }), /not both/);
  assert.throws(() => changeView(first, model, "set_step", { off: "yes" }), /off must be/);
  assert.equal(changeView(first, model, "set_explode", { amount: 0.5 }).step, null);
  assert.equal(changeView(first, model, "set_explode", { direction: "z" }).step, 0);
  assert.equal(changeView(first, model, "reset_view").step, null);
  // Canvas hosts get plain JSON-schema types; no union for "number or null".
  assert.deepEqual(COMMANDS.set_step.inputSchema.properties.step, { type: "integer", minimum: 0, maximum: 200 });
  assert.equal(COMMANDS.set_step.inputSchema.properties.off.type, "boolean");
});

test("the sequence file is read from beside its STEP and is optional", async (t) => {
  // The server passes canonical roots; macOS temporary folders are reached through a symlink.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cad-explorer-sequence-")));
  try {
    const step = path.join(root, "outputs", "jig.step");
    assert.equal(sequencePath(step), path.join(root, "outputs", "jig.assembly.json"));
    assert.equal(await readSequence(step, model, root), null);
    await mkdir(path.dirname(step));
    await writeFile(sequencePath(step), JSON.stringify(document([{ title: "Cap", parts: ["cap"], from: [0, 0, 5] }])));
    const loaded = await readSequence(step, model, root);
    assert.equal(loaded.file, "outputs/jig.assembly.json");
    assert.deepEqual(loaded.steps[0].nodeIds, ["cap"]);
    await writeFile(sequencePath(step), "{");
    await assert.rejects(readSequence(step, model, root), /not valid JSON/);
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cad-explorer-outside-")));
    try {
      await writeFile(path.join(outside, "elsewhere.json"), JSON.stringify(document([{ title: "Cap", parts: ["cap"], from: [0, 0, 5] }])));
      await rm(sequencePath(step));
      try { await symlink(path.join(outside, "elsewhere.json"), sequencePath(step), "file"); }
      catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("Symlinks require Windows permission"); return; } throw error; }
      await assert.rejects(readSequence(step, model, root), /inside the selected project root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
