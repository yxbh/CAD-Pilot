import assert from "node:assert/strict";
import test from "node:test";
import { faceAtTriangle, facePositions, hoverTarget, newestState, placeParts, type Model } from "../src/model.ts";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const model: Model = {
  schemaVersion: 2, topologyRevision: "a".repeat(64), source: { name: "fixture.step", sha256: "abc" }, units: "mm", warnings: [],
  bounds: { min: [10, 20, 0], max: [21, 21, 1] },
  parts: [{ id: "shape", label: "Part", color: [1, 0, 0], positions: [], normals: [], indices: [], faces: [], bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
  nodes: [
    { id: "root", label: "Root", parentId: null, partId: null, matrix: [...identity.slice(0, 12), 10, 20, 0, 1], color: [1, 0, 0] },
    { id: "a", label: "A", parentId: "root", partId: "shape", matrix: identity, color: [1, 0, 0] },
    { id: "b", label: "B", parentId: "root", partId: "shape", matrix: [...identity.slice(0, 12), 10, 0, 0, 1], color: [1, 0, 0] },
  ],
};
test("local parent transforms are composed once", () => {
  const parts = placeParts(model, 0, "radial", "");
  assert.deepEqual(parts[0].matrix.slice(12, 15), [10, 20, 0]);
  assert.deepEqual(parts[1].matrix.slice(12, 15), [20, 20, 0]);
});
test("explosion keeps fixed occurrence and reset is drift-free", () => {
  const original = JSON.stringify(model);
  const before = placeParts(model, 0, "radial", "");
  for (let i = 0; i < 100; i++) {
    const exploded = placeParts(model, 0.8, "radial", "a");
    assert.deepEqual(exploded[0].matrix, before[0].matrix);
    assert.notDeepEqual(exploded[1].matrix, before[1].matrix);
    assert.deepEqual(placeParts(model, 0, "z", "a"), before);
  }
  assert.equal(JSON.stringify(model), original);
});
test("a rotated parent rotates a child's local translation and bounds", () => {
  const rotated = structuredClone(model);
  rotated.nodes[0].matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1];
  const parts = placeParts(rotated, 0, "radial", "");
  assert.deepEqual(parts[1].matrix.slice(12, 15), [10, 30, 0]);
  assert.deepEqual(parts[1].bounds, { min: [9, 30, 0], max: [10, 31, 1] });
});
test("triangle picking resolves a whole face and builds all its highlight triangles", () => {
  const part = structuredClone(model.parts[0]);
  part.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 2, 2];
  part.indices = [0, 1, 2, 0, 2, 3, 1, 2, 4];
  part.faces = [
    { id: "f1", triangleStart: 0, triangleCount: 2, surfaceType: "plane", area: 1, center: [0.5, 0.5, 0], bounds: part.bounds },
    { id: "f2", triangleStart: 2, triangleCount: 1, surfaceType: "plane", area: 1, center: [1, 1, 1], bounds: part.bounds },
  ];
  assert.equal(faceAtTriangle(part, 0)?.id, "f1");
  assert.equal(faceAtTriangle(part, 1)?.id, "f1");
  assert.equal(faceAtTriangle(part, 2)?.id, "f2");
  assert.equal(faceAtTriangle(part, 3), null);
  assert.equal(faceAtTriangle(part, -1), null);
  assert.deepEqual(hoverTarget(part, "node-a", "face", 1), { nodeId: "node-a", faceId: "f1" });
  assert.deepEqual(hoverTarget(part, "node-a", "part", -1), { nodeId: "node-a", faceId: null });
  assert.equal(hoverTarget(part, "node-a", "face", -1), null);
  assert.equal(hoverTarget(part, "node-a", "edge", 1), null);
  assert.equal(facePositions(part, part.faces[0]).length, 18);
  assert.deepEqual([...facePositions(part, part.faces[0])], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
});
test("late bootstrap, response and SSE snapshots cannot roll selection back", () => {
  const latest = { revision: 7, selected: "new-face" };
  assert.equal(newestState(latest, { revision: 6, selected: "old-face" }), latest);
  assert.deepEqual(newestState(latest, { revision: 8, selected: "next-face" }), { revision: 8, selected: "next-face" });
  assert.equal(newestState(null, latest), latest);
});
