import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, BufferGeometry, IcosahedronGeometry, PlaneGeometry } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { curvatures, fittedCurvatureScale, NO_VALUE, normalArrows, triangleEdges, wallThickness, weldVertices } from "../src/analysis/fields.ts";
import { plateHeight } from "../src/analysis/useAnalysis.ts";
import { GeometryResources } from "../src/resources.ts";
import type { Model, Part, Placement } from "../src/model.ts";

// Positions and triangle corners, without three.js's normals and texture coordinates; welded joins equal corners as a
// mesh file's reader does, otherwise each face keeps its own corners as a STEP preview does.
function arrays(geometry: BufferGeometry, welded = true) {
  for (const name of ["normal", "uv"]) geometry.deleteAttribute(name);
  const shape = welded ? mergeVertices(geometry) : geometry;
  return { positions: Float32Array.from(shape.getAttribute("position").array), indices: Uint32Array.from(shape.index!.array) };
}
const average = (values: Float32Array) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("curvature of a sphere is 1/r (mean) and 1/r^2 (Gaussian), and undefined on an open border", () => {
  const sphere = arrays(new IcosahedronGeometry(10, 12));
  const { mean, gaussian } = curvatures(sphere.positions, sphere.indices);
  assert.ok(Math.abs(average(mean) - 0.1) < 0.002, `mean ${average(mean)}`);
  assert.ok(Math.abs(average(gaussian) - 0.01) < 0.0005, `gaussian ${average(gaussian)}`);
  // Inside out, a convex surface reads as concave.
  const inverted = Uint32Array.from(sphere.indices, (_, slot) => sphere.indices[slot - (slot % 3) + 2 - (slot % 3)]);
  assert.ok(average(curvatures(sphere.positions, inverted).mean) < -0.09);
  // A STEP preview repeats each corner per face; joining them gives the same answer as a welded mesh.
  const box = arrays(new BoxGeometry(10, 10, 10), false);
  const welded = arrays(new BoxGeometry(10, 10, 10));
  assert.equal(box.positions.length / 3, 24);
  assert.equal(new Set(weldVertices(box.positions)).size, 8);
  const at = ({ positions }: { positions: Float32Array }, values: Float32Array) =>
    new Map(Array.from(values, (value, vertex) => [Array.from(positions.subarray(vertex * 3, vertex * 3 + 3)).join(), value]));
  const repeated = at(box, curvatures(box.positions, box.indices).gaussian);
  const joined = at(welded, curvatures(welded.positions, welded.indices).gaussian);
  assert.deepEqual(repeated, joined);
  assert.ok([...joined.values()].every((value) => value > 0), "Each corner of a box is a point of positive curvature");
  const sheet = arrays(new PlaneGeometry(10, 10, 4, 4));
  const open = curvatures(sheet.positions, sheet.indices);
  assert.equal(open.mean[0], NO_VALUE, "A corner of an open sheet is on its border");
  assert.equal(open.mean[12], 0, "Its middle is flat");
});

test("wall thickness follows each triangle's inward ray, and shows the thinnest wall at each corner", () => {
  for (const welded of [true, false]) {
    const plate = arrays(new BoxGeometry(60, 40, 4, 6, 4, 1), welded);
    const { values, thinnest } = wallThickness(plate.positions, plate.indices);
    assert.equal(thinnest, 4);
    // The top face reads 4 mm. Along their inward normal the narrow sides read the plate's length, which a corner the
    // two share (welded, as in a mesh file) gives up for the thinner wall.
    const corners = [...plate.indices];
    const onTop = new Set(corners.filter((_, slot) => [0, 1, 2].every((corner) => plate.positions[corners[slot - (slot % 3) + corner] * 3 + 2] === 2)));
    assert.ok([...onTop].every((vertex) => Math.abs(values[vertex] - 4) < 1e-4));
    assert.equal(new Set(values).has(60), !welded);
  }
  // Inside out, every ray leaves the part through the front of a surface, which is no wall at all.
  const plate = arrays(new BoxGeometry(60, 40, 4));
  const inverted = Uint32Array.from(plate.indices, (_, slot) => plate.indices[slot - (slot % 3) + 2 - (slot % 3)]);
  assert.equal(wallThickness(plate.positions, inverted).thinnest, null);
  const sheet = arrays(new PlaneGeometry(10, 10));
  const open = wallThickness(sheet.positions, sheet.indices);
  assert.equal(open.thinnest, null, "A single sheet has no opposite wall");
  assert.ok(open.values.every((value) => value === NO_VALUE));
  const sphere = arrays(new IcosahedronGeometry(10, 8));
  assert.ok(Math.abs(wallThickness(sphere.positions, sphere.indices).thinnest! - 20) < 0.1, "Through a ball is its diameter");
});

test("triangle edges are listed once each, and normal arrows are sized to the part and thinned out", () => {
  const box = arrays(new BoxGeometry(10, 10, 10));
  assert.equal(triangleEdges(box.indices, box.positions.length / 3).length / 2, 18);
  const sphere = arrays(new IcosahedronGeometry(10, 40));
  const triangles = sphere.indices.length / 3;
  assert.equal(triangleEdges(sphere.indices, sphere.positions.length / 3).length / 2, triangles * 1.5, "A closed surface has 3/2 edges per triangle");
  const { segments } = normalArrows(sphere.positions, sphere.indices);
  const arrows = segments.length / 6;
  assert.ok(arrows > 100 && arrows < triangles / 10, `${arrows} arrows for ${triangles} triangles`);
  for (let start = 0; start < segments.length; start += 6) {
    const base = [segments[start], segments[start + 1], segments[start + 2]];
    const along = [0, 1, 2].map((axis) => segments[start + 3 + axis] - base[axis]);
    assert.ok(Math.abs(Math.hypot(...along) - Math.hypot(20, 20, 20) * 0.05) < 0.05, "One length, a twentieth of the part's diagonal");
    assert.ok(along.reduce((sum, value, axis) => sum + value * base[axis], 0) > 0, "pointing out of the ball");
  }
  const coarse = arrays(new BoxGeometry(10, 10, 10));
  assert.equal(normalArrows(coarse.positions, coarse.indices).segments.length / 6, 12, "Every triangle of a coarse part gets one");
});

test("a fitted curvature scale covers most vertices and reads cleanly; NO_VALUE is left out", () => {
  const values = Float32Array.from({ length: 1000 }, (_, index) => (index % 2 ? 1 : -1) * index / 1000 * 0.3);
  assert.equal(fittedCurvatureScale([values, Float32Array.of(NO_VALUE, NO_VALUE)]), 0.5);
  assert.equal(fittedCurvatureScale([]), 1);
});

test("the build plate is the lowest placed point along the build direction", () => {
  const part = { bounds: { min: [-5, -5, 0], max: [5, 5, 2] }, positions: [-5, -5, 0, 5, 5, 2, 5, -5, 0] } as unknown as Part;
  const at = (matrix: number[]) => ({ part, matrix }) as Placement;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const raised = [...identity.slice(0, 12), 0, 0, 10, 1];
  assert.equal(plateHeight([at(identity), at(raised)], [0, 0, 1], [0, 0, 0]), 0);
  assert.equal(plateHeight([at(raised)], [0, 0, 1], [0, 0, 4]), 6, "In scene coordinates, from the view's origin");
  assert.equal(plateHeight([at(identity)], [0, 0, -1], [0, 0, 0]), -2, "Building downward, the top rests on the plate");
  const diagonal = [Math.SQRT1_2, 0, Math.SQRT1_2];
  assert.ok(Math.abs(plateHeight([at(identity)], diagonal, [0, 0, 0]) - -5 * Math.SQRT1_2) < 1e-9, "Off the part's axes, its vertices decide");
});

test("analysis data is computed once per part and drawn from the part's own positions", async () => {
  const part: Part = {
    id: "box", label: "Box", color: [1, 1, 1], ...arrays(new BoxGeometry(10, 10, 10)), normals: [],
    bounds: { min: [-5, -5, -5], max: [5, 5, 5] }, faces: [],
  };
  part.normals = Array.from({ length: part.positions.length }, () => 0);
  const model = { parts: [part], nodes: [] } as unknown as Model;
  const owner = new GeometryResources(model);
  assert.equal(owner.analysisDone(part, "edges"), false);
  const first = owner.requestAnalysis(part, "edges");
  assert.equal(owner.requestAnalysis(part, "edges"), first, "A pending field is not asked for twice");
  await Promise.all([first, owner.requestAnalysis(part, "thickness"), owner.requestAnalysis(part, "normals")]);
  const data = owner.analysis(part);
  assert.equal(data.edges!.getAttribute("position"), owner.get(part).geometry.getAttribute("position"), "Edges share the surface's positions");
  assert.equal(data.edges!.index!.count, 36);
  assert.equal(data.thickness!.thinnest, 10);
  assert.equal(data.normals!.instanceCount, 12);
  owner.showValues(part, data.thickness!.values);
  const shown = owner.get(part).geometry.getAttribute("analysisValue");
  owner.showValues(part, Float32Array.from(data.thickness!.values, () => 3));
  assert.equal(owner.get(part).geometry.getAttribute("analysisValue"), shown, "Switching maps reuses the surface's value buffer");
  assert.equal(shown.getX(0), 3);
  let disposed = 0;
  data.edges!.addEventListener("dispose", () => disposed++);
  data.normals!.addEventListener("dispose", () => disposed++);
  owner.dispose();
  assert.equal(disposed, 2);
});
