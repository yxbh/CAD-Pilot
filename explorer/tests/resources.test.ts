import assert from "node:assert/strict";
import test from "node:test";
import { GeometryResources } from "../src/resources.ts";
import type { Model, Part } from "../src/model.ts";

const part: Part = {
  id: "shape", label: "Repeated bracket", color: [1, 0, 0],
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2], bounds: { min: [0, 0, 0], max: [1, 1, 0] }, faces: [],
};
const model: Model = { schemaVersion: 2, topologyRevision: "x", source: { name: "sample", sha256: "a" }, units: "mm", parts: [part], nodes: [], bounds: part.bounds, warnings: [] };
test("repeated occurrences share actual geometry buffers with one document owner", () => {
  const owner = new GeometryResources(model);
  const first = owner.get(part);
  const second = owner.get(part);
  assert.equal(first.geometry, second.geometry);
  assert.equal(first.edges, second.edges);
  assert.equal(owner.size, 1);
  let disposals = 0;
  first.geometry.addEventListener("dispose", () => disposals++);
  owner.dispose();
  owner.dispose();
  assert.equal(disposals, 1);
  assert.throws(() => owner.get(part), /released/);
  const reopened = new GeometryResources(model);
  assert.notEqual(reopened.get(part).geometry, first.geometry);
  reopened.dispose();
});
