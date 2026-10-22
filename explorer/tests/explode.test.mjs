import assert from "node:assert/strict";
import test from "node:test";
import { placeParts } from "../shared/placement.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x, y, z) => [...identity.slice(0, 12), x, y, z, 1];
const box = (min, max) => ({ min, max });
// The demo's structure (python/create_demo.py): a base plate, a "Four spacers" group of four spacers, and a cover.
const demo = {
  bounds: box([-50, -32.5, 0], [50, 32.5, 35]),
  parts: [
    { id: "base", bounds: box([-50, -32.5, 0], [50, 32.5, 4]) },
    { id: "spacer", bounds: box([-4, -4, 0], [4, 4, 27]) },
    { id: "cover", bounds: box([-45, -27.5, 0], [45, 27.5, 4]) },
  ],
  nodes: [
    { id: "root", parentId: null, partId: null, matrix: identity },
    { id: "base", parentId: "root", partId: "base", matrix: identity },
    { id: "spacers", parentId: "root", partId: null, matrix: at(0, 0, 4) },
    ...[[-38, -21], [38, -21], [-38, 21], [38, 21]].map(([x, y], index) => (
      { id: `spacer-${index + 1}`, parentId: "spacers", partId: "spacer", matrix: at(x, y, 0) })),
    { id: "cover", parentId: "root", partId: "cover", matrix: at(0, 0, 31) },
  ],
};
const spacers = ["spacer-1", "spacer-2", "spacer-3", "spacer-4"];
// Each occurrence's displacement from where it is assembled.
const offsets = (model, amount, direction = "radial", fixedId = "") => {
  const assembled = new Map(placeParts(model, 0, direction, "").map((item) => [item.node.id, item.matrix]));
  return Object.fromEntries(placeParts(model, amount, direction, fixedId)
    .map((item) => [item.node.id, item.matrix.slice(12, 15).map((value, axis) => value - assembled.get(item.node.id)[12 + axis])]));
};
const near = (actual, expected, message) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-9, `${message}: ${actual} vs ${expected}`));
const apart = (a, b) => [0, 1, 2].some((axis) => a.max[axis] <= b.min[axis] || b.max[axis] <= a.min[axis]);

test("the Four spacers group separates as a unit before its spacers spread apart", () => {
  for (const fixedId of ["", "base"]) {
    // The first level has the slider to itself until a third of the way.
    const early = offsets(demo, 0.3, "radial", fixedId);
    for (const id of spacers) near(early[id], early["spacer-1"], `${id} moves with its group early on`);
    assert.ok(early.cover[2] - early["spacer-1"][2] > 1, "the cover lifts off the group");
    assert.ok(early["spacer-1"][2] - early.base[2] > 1, "the group lifts off the base");
    const full = offsets(demo, 1, "radial", fixedId);
    for (const id of spacers) {
      // The group is centred on X and Y, so a spacer's own placement says which way is out.
      const assembled = demo.nodes.find((node) => node.id === id).matrix;
      assert.ok(Math.sign(full[id][0]) === Math.sign(assembled[12]) && Math.sign(full[id][1]) === Math.sign(assembled[13]),
        `${id} spreads away from the group's centre`);
      assert.ok(Math.abs(full[id][2] - full["spacer-1"][2]) < 1e-9, "the spacers spread level");
    }
  }
});

test("parts at the same height get matching offsets on an axis explode, stacked in the order they sit", () => {
  for (const amount of [0.3, 0.7, 1]) {
    const up = offsets(demo, amount, "z");
    for (const id of spacers) near(up[id], up["spacer-1"], `${id} at the spacers' height`);
    assert.ok(up.base[2] < up["spacer-1"][2] && up["spacer-1"][2] < up.cover[2], "the stack keeps its order");
    for (const offset of Object.values(up)) assert.ok(offset[0] === 0 && offset[1] === 0, "only along Z");
    const sideways = offsets(demo, amount, "x");
    near(sideways["spacer-1"], sideways["spacer-3"], "left spacers");
    near(sideways["spacer-2"], sideways["spacer-4"], "right spacers");
    assert.ok(sideways["spacer-1"][0] < 0 && sideways["spacer-2"][0] > 0);
    near(sideways.base, [0, 0, 0], "the base is centred on X");
  }
  // Layers follow position, not file order, and parts of different sizes in one layer still move together.
  const shape = (id, size) => ({ id, bounds: box([-size, -size, 0], [size, size, 2]) });
  const flat = {
    bounds: box([-30, -5, 0], [30, 5, 22]),
    parts: [shape("small", 2), shape("large", 5)],
    nodes: [
      { id: "root", parentId: null, partId: null, matrix: identity },
      { id: "top-left", parentId: "root", partId: "small", matrix: at(-25, 0, 20) },
      { id: "bottom", parentId: "root", partId: "large", matrix: at(0, 0, 0) },
      { id: "top-right", parentId: "root", partId: "large", matrix: at(25, 0, 20) },
      { id: "middle", parentId: "root", partId: "small", matrix: at(0, 0, 10) },
    ],
  };
  const stacked = offsets(flat, 1, "z");
  near(stacked["top-left"], stacked["top-right"], "one layer");
  assert.ok(stacked.bottom[2] < 0 && stacked["top-left"][2] > 0);
  assert.ok(Math.abs(stacked.middle[2]) < 1e-9, "the centre layer stays");
});

test("concentric parts telescope out along their long side, on an axis too", () => {
  const nested = {
    bounds: box([-10, -10, -10], [10, 10, 10]),
    parts: [{ id: "housing", bounds: box([-10, -10, -10], [10, 10, 10]) }, { id: "shaft", bounds: box([-1, -1, -9], [1, 1, 9]) }],
    nodes: [
      { id: "root", parentId: null, partId: null, matrix: identity },
      { id: "shaft", parentId: "root", partId: "shaft", matrix: identity },
      { id: "housing", parentId: "root", partId: "housing", matrix: identity },
    ],
  };
  for (const direction of ["radial", "z"]) {
    const moved = offsets(nested, 1, direction);
    near(moved.housing, [0, 0, 0], `${direction}: the housing stays`);
    assert.ok(Math.abs(moved.shaft[2]) > 19 && moved.shaft[0] === 0 && moved.shaft[1] === 0, `${direction}: the shaft clears it along Z`);
  }
  const across = offsets(nested, 1, "x");
  assert.ok(Math.abs(across.shaft[0]) > 11 && across.shaft[2] === 0, "an X explode pulls it out sideways");
});

test("flat plates centred on one axis separate along it in order, not across it", () => {
  // Like a turntable jig: wide discs stacked a few millimetres apart, all within the centred threshold.
  const disc = (id, radius, low, high) => ({ id, bounds: box([-radius, -radius, low], [radius, radius, high]) });
  const plates = [disc("frame", 150, 0, 18), disc("turntable", 140, 7, 14), disc("ring", 166, 14, 20), disc("sample", 100, 20, 26)];
  const model = {
    bounds: box([-166, -166, 0], [166, 166, 26]),
    parts: plates,
    nodes: [{ id: "root", parentId: null, partId: null, matrix: identity },
      ...plates.map((part) => ({ id: part.id, parentId: "root", partId: part.id, matrix: identity }))],
  };
  const moved = offsets(model, 1);
  for (const [id, offset] of Object.entries(moved)) assert.ok(offset[0] === 0 && offset[1] === 0, `${id} moves only along Z`);
  const placed = Object.fromEntries(placeParts(model, 1, "radial", "").map((item) => [item.node.id, item.bounds]));
  assert.ok(placed.frame.max[2] < placed.turntable.min[2] && placed.turntable.max[2] < placed.ring.min[2] && placed.ring.max[2] < placed.sample.min[2],
    "the stack keeps its order with gaps");
});

test("siblings clear each other at full explode, even with nearby centres", () => {
  const bodies = [box([-10, -10, -10], [8, 10, 10]), box([-8, -10, -10], [10, 10, 10]), box([-9, -8, -10], [9, 12, 10])];
  const model = {
    bounds: box([-10, -10, -10], [10, 12, 10]),
    parts: bodies.map((bounds, index) => ({ id: `p${index}`, bounds })),
    nodes: [{ id: "root", parentId: null, partId: null, matrix: identity },
      ...bodies.map((_, index) => ({ id: `n${index}`, parentId: "root", partId: `p${index}`, matrix: identity }))],
  };
  for (const direction of ["radial", "x", "y", "z"]) {
    const placed = placeParts(model, 1, direction, "");
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) assert.ok(apart(placed[i].bounds, placed[j].bounds), `${direction}: ${i} and ${j}`);
    }
  }
});

test("a fixed part stays put inside a subassembly while the rest keep their separation from it", () => {
  for (const direction of ["radial", "x", "y", "z"]) {
    for (const amount of [0.2, 0.6, 1]) {
      const free = offsets(demo, amount, direction);
      const fixed = offsets(demo, amount, direction, "spacer-2");
      near(fixed["spacer-2"], [0, 0, 0], `${direction} ${amount}`);
      for (const id of Object.keys(free)) {
        near(fixed[id], free[id].map((value, axis) => value - free["spacer-2"][axis]), `${direction} ${amount}: ${id} relative to the fixed spacer`);
      }
    }
  }
});

test("the slider moves parts steadily out and back to exactly where they were assembled", () => {
  const assembled = placeParts(demo, 0, "radial", "");
  let previous = -1;
  for (const amount of [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
    const travel = Object.values(offsets(demo, amount)).reduce((sum, offset) => sum + Math.hypot(...offset), 0);
    assert.ok(travel >= previous, `travel does not shrink at ${amount}`);
    previous = travel;
  }
  placeParts(demo, 1, "radial", "");
  assert.deepEqual(placeParts(demo, 0, "radial", ""), assembled);
  // Occurrences nested deeper than three levels move rigidly with their third-level ancestor.
  const deep = structuredClone(demo);
  deep.nodes = deep.nodes.flatMap((node) => node.id === "spacer-1"
    ? [{ id: "pair", parentId: "spacers", partId: null, matrix: identity }, { ...node, id: "spacer-1c", parentId: "pair", matrix: at(-30, -30, 0) },
      { id: "inner", parentId: "pair", partId: null, matrix: identity },
      { ...node, parentId: "inner" }, { ...node, id: "spacer-1b", parentId: "inner", matrix: at(-38, -21, 13) }]
    : [node]);
  const moved = offsets(deep, 1);
  assert.ok(Math.hypot(...moved["spacer-1"].map((value, axis) => value - moved["spacer-1c"][axis])) > 1, "the third level separates");
  near(moved["spacer-1"], moved["spacer-1b"], "below the third level");
});
