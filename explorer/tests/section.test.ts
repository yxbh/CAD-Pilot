import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { clipCadEdges, sceneSectionPlane, sectionMeshRaycast, sectionOutlineSegments } from "../src/section.ts";
import { sectionDistance, sectionPlacements } from "../shared/section.mjs";
import { displayedWorldBounds, mergeBounds, placeParts } from "../shared/placement.mjs";
import type { CadEdge, Part } from "../src/model.ts";

const identity = new Matrix4().identity().toArray();
const edge: CadEdge = {
  id: "e1", positions: [-2, 0, 0, 2, 0, 0], curveType: "line", length: 4,
  center: [0, 0, 0], bounds: { min: [-2, 0, 0], max: [2, 0, 0] },
};

test("edge clipping trims crossing segments at the model-world plane and preserves native edge identity", () => {
  const matrix = new Matrix4().makeTranslation(10, 20, 30).toArray();
  const low = clipCadEdges([edge], matrix, { enabled: true, axis: "x", position: 10, flipped: false });
  assert.deepEqual(low.positions, [-2, 0, 0, 0, 0, 0]);
  assert.equal(low.ranges[0].edge, edge);
  assert.deepEqual(clipCadEdges([edge], matrix, { enabled: true, axis: "x", position: 10, flipped: true }).positions,
    [0, 0, 0, 2, 0, 0]);
  assert.deepEqual(clipCadEdges([edge], matrix, { enabled: true, axis: "y", position: 19, flipped: false }).positions, []);
  assert.deepEqual(clipCadEdges([edge], matrix, { enabled: false, axis: "x", position: -100, flipped: false }).positions,
    [-2, 0, 0, 2, 0, 0]);
});

test("section planes account for scene recentering while occurrence and explosion transforms apply once", () => {
  const part = {
    id: "shape", bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, positions: [-1, 0, 0, 1, 0, 0],
  };
  const model = {
    bounds: { min: [9, 19, 29], max: [31, 21, 31] }, parts: [part],
    nodes: [
      { id: "root", parentId: null, partId: null, matrix: new Matrix4().makeTranslation(10, 20, 30).toArray() },
      { id: "a", parentId: "root", partId: "shape", matrix: identity },
      { id: "b", parentId: "root", partId: "shape", matrix: new Matrix4().makeTranslation(20, 0, 0).toArray() },
    ],
  };
  const state = { explode: 0, direction: "radial", fixedId: "", section: { enabled: true, axis: "x" as const, position: 10, flipped: false } };
  const placements = sectionPlacements(model, state);
  assert.deepEqual(placements[0].matrix.slice(12, 15), [10, 20, 30]);
  assert.deepEqual(placements[1].matrix.slice(12, 15), [30, 20, 30]);
  assert.equal(sectionDistance([0, 0, 0], placements[0].matrix, state.section), 0);
  const plane = sceneSectionPlane(state.section, [20, 20, 30]);
  assert.equal(plane?.distanceToPoint(new Vector3(-10, 0, 0)), 0);
  assert.ok(sectionPlacements(model, { ...state, explode: 0.5 }).some((placement, index) =>
    placement.matrix[12] !== placements[index].matrix[12]), "Explosion changes displayed placements without changing the world section coordinate");
});

test("displayed bounds use the exact transformed, repeated, fixed-part explosion placements on every axis", () => {
  const part = { id: "shape", bounds: { min: [-1, -2, -3], max: [1, 2, 3] }, positions: [-1, -2, -3, 1, 2, 3] };
  const model = {
    bounds: { min: [9, 18, 27], max: [29, 24, 35] }, parts: [part],
    nodes: [
      { id: "root", parentId: null, partId: null, matrix: new Matrix4().makeTranslation(10, 20, 30).toArray() },
      { id: "fixed", parentId: "root", partId: "shape", matrix: identity },
      { id: "repeat", parentId: "root", partId: "shape", matrix: new Matrix4().makeTranslation(18, 2, 2).toArray() },
    ],
  };
  for (const direction of ["x", "y", "z", "radial"] as const) {
    const state = { explode: 1, direction, fixedId: "fixed", hiddenIds: [] };
    const placements = placeParts(model, state.explode, state.direction, state.fixedId);
    const expected = mergeBounds(placements.map((placement) => placement.bounds));
    assert.deepEqual(displayedWorldBounds(model, state), expected);
    assert.deepEqual(placements.find((placement) => placement.node.id === "fixed")?.matrix.slice(12, 15), [10, 20, 30]);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Number.isFinite(expected!.min[axis]) && Number.isFinite(expected!.max[axis]));
      assert.ok(expected!.min[axis] <= expected!.max[axis]);
    }
    assert.deepEqual(displayedWorldBounds(model, { ...state, hiddenIds: ["repeat"] }), placements[0].bounds);
    assert.equal(displayedWorldBounds(model, { ...state, hiddenIds: ["fixed", "repeat"] }), null);
  }
});

test("cap-aware surface raycasting blocks click-through but leaves gaps outside the solid", () => {
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.updateMatrixWorld(true);
  const plane = sceneSectionPlane({ enabled: true, axis: "x", position: 0, flipped: false }, [0, 0, 0]);
  const raycaster = new Raycaster(new Vector3(5, 0, 0), new Vector3(-1, 0, 0));
  const hits: any[] = [];
  sectionMeshRaycast(mesh, raycaster, hits, plane);
  assert.equal(hits.sort((a, b) => a.distance - b.distance)[0].faceIndex, -1, "Derived cap blocks retained back faces");
  const gapHits: any[] = [];
  sectionMeshRaycast(mesh, new Raycaster(new Vector3(5, 3, 0), new Vector3(-1, 0, 0)), gapHits, plane);
  assert.deepEqual(gapHits, []);
  const flippedHits: any[] = [];
  sectionMeshRaycast(mesh, raycaster, flippedHits,
    sceneSectionPlane({ enabled: true, axis: "x", position: 0, flipped: true }, [0, 0, 0]));
  assert.notEqual(flippedHits.sort((a, b) => a.distance - b.distance)[0].faceIndex, -1);
  geometry.dispose();
  material.dispose();
});

test("cut outlines are derived without mutating source triangle buffers", () => {
  const geometry = new BoxGeometry(2, 2, 2).toNonIndexed();
  const positions = [...geometry.getAttribute("position").array] as number[];
  const part = {
    id: "box", positions, indices: Array.from({ length: positions.length / 3 }, (_, index) => index),
  } as Part;
  const before = JSON.stringify({ positions: part.positions, indices: part.indices });
  const segments = sectionOutlineSegments(part, identity, { enabled: true, axis: "x", position: 0, flipped: false });
  assert.ok(segments.length >= 24);
  assert.equal(JSON.stringify({ positions: part.positions, indices: part.indices }), before);
  geometry.dispose();
});
