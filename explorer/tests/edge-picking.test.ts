import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { EDGE_PICK_RADIUS, edgeScreenPoint, prioritizeEdges, visibleEdgeHits } from "../src/edgePicking.ts";
import { edgeSegments, type CadEdge } from "../src/model.ts";
import { edgeAtSegment } from "../src/resources.ts";

const edge: CadEdge = {
  id: "e1", positions: [-1, 0, 0, 0, 1, 0, 1, 0, 0], curveType: "circle", length: Math.PI,
  center: [0, 0.5, 0], bounds: { min: [-1, 0, 0], max: [1, 1, 0] },
};

test("edge segment mapping retains complete CAD edges without joining separate curves", () => {
  assert.deepEqual(edgeSegments(edge), [-1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0]);
  const other = { ...edge, id: "e2" };
  const ranges = [{ edge, start: 0, count: 2 }, { edge: other, start: 2, count: 2 }];
  for (const index of [0, 1]) assert.equal(edgeAtSegment(ranges, index), edge);
  for (const index of [2, 3]) assert.equal(edgeAtSegment(ranges, index), other);
  for (const index of [-1, 4, NaN, 1.5]) assert.equal(edgeAtSegment(ranges, index), null);
});

for (const projection of ["perspective", "orthographic"] as const) {
  test(`${projection} edge picking uses CSS pixels across zoom and window sizes`, () => {
    const geometry = new LineSegmentsGeometry().setPositions([-1, 0, 0, 1, 0, 0]);
    const material = new LineMaterial({ linewidth: 1 });
    const lines = new LineSegments2(geometry, material);
    lines.updateMatrixWorld(true);
    try {
      for (const size of [400, 1000]) for (const distance of [5, 50, 500]) {
        const camera = projection === "perspective"
          ? new PerspectiveCamera(42, 1, 0.1, 1000) : new OrthographicCamera(-2, 2, 2, -2, 0.1, 1000);
        camera.position.set(0, 0, distance);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        const raycaster = new Raycaster();
        const existing = { threshold: 7 };
        raycaster.params.Line2 = existing;
        raycaster.setFromCamera(new Vector2(0, (EDGE_PICK_RADIUS - 1) * 2 / size), camera);
        assert.equal(visibleEdgeHits(lines, raycaster, [], size, size, 1e-6).length, 1);
        assert.equal(raycaster.params.Line2, existing, "Do not leak edge tolerance into other picking");
        raycaster.setFromCamera(new Vector2(0, (EDGE_PICK_RADIUS + 1) * 2 / size), camera);
        assert.equal(visibleEdgeHits(lines, raycaster, [], size, size, 1e-6).length, 0);
      }
    } finally {
      geometry.dispose();
      material.dispose();
    }
  });
}

test("visible boundary edges win over faces, but edges behind an opaque part cannot be picked", () => {
  const camera = new PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const lines = new LineSegments2(new LineSegmentsGeometry().setPositions([-1, 0, 0, 1, 0, 0]), new LineMaterial({ linewidth: 1 }));
  lines.userData.cadEdges = true;
  lines.updateMatrixWorld(true);
  const occluder = new Mesh(new BoxGeometry(4, 4, 1), new MeshBasicMaterial());
  occluder.position.z = 2;
  occluder.updateMatrixWorld(true);
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(0, 0), camera);
  try {
    assert.equal(visibleEdgeHits(lines, raycaster, [occluder], 600, 600, 1e-6).length, 0);
    occluder.position.z = -0.5;
    occluder.updateMatrixWorld(true);
    const hits = visibleEdgeHits(lines, raycaster, [occluder], 600, 600, 1e-6);
    assert.equal(hits.length, 1, "An edge on its own surface is selectable");
    const faceHit = { ...hits[0], distance: 1, object: occluder };
    assert.equal(prioritizeEdges([faceHit, ...hits], camera, new Vector2(), 600, 600)[0].object, lines);
    lines.position.x = 10;
    lines.updateMatrixWorld(true);
    assert.equal(visibleEdgeHits(lines, raycaster, [], 600, 600, 1e-6).length, 0, "Moved occurrences must not retain old hit locations");
    const point = new Vector3(10, 0, 0).project(camera);
    raycaster.setFromCamera(new Vector2(point.x, point.y), camera);
    assert.equal(visibleEdgeHits(lines, raycaster, [], 600, 600, 1e-6).length, 1);
  } finally {
    lines.geometry.dispose();
    lines.material.dispose();
    occluder.geometry.dispose();
    occluder.material.dispose();
  }
});

test("edge report projects a point on the polyline using occurrence placement, not its empty-space center", () => {
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.z = 20;
  camera.updateMatrixWorld(true);
  const transform = new Matrix4().makeTranslation(3, 4, 0).toArray();
  assert.deepEqual(edgeScreenPoint([-1, 0, 0, 1, 0, 0], transform, [0, 0, 0], camera, 100, 100), [65, 30]);
  assert.equal(edgeScreenPoint([], transform, [0, 0, 0], camera, 100, 100), null);
});

test("rotated occurrences use their world transform and nearby edges rank by pointer proximity", () => {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  camera.position.z = 20;
  camera.updateMatrixWorld(true);
  const lines = new LineSegments2(new LineSegmentsGeometry().setPositions([-1, 0, 0, 1, 0, 0]), new LineMaterial({ linewidth: 1 }));
  lines.rotation.z = Math.PI / 2;
  lines.position.x = 2;
  lines.userData.cadEdges = true;
  lines.updateMatrixWorld(true);
  const raycaster = new Raycaster();
  try {
    raycaster.setFromCamera(new Vector2(0.4, 0.1), camera);
    const hits = visibleEdgeHits(lines, raycaster, [], 500, 500, 1e-6);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].faceIndex, 0);
    const fartherFromPointer = { ...hits[0], pointOnLine: new Vector3(2.05, 0.5, 5), distance: 15 };
    assert.equal(prioritizeEdges([fartherFromPointer, ...hits], camera, new Vector2(0.4, 0.1), 500, 500)[0], hits[0],
      "A closer screen-space edge should win even if a nearby edge is closer to the camera");
    raycaster.setFromCamera(new Vector2(0.2, 0), camera);
    assert.equal(visibleEdgeHits(lines, raycaster, [], 500, 500, 1e-6).length, 0);
  } finally {
    lines.geometry.dispose();
    lines.material.dispose();
  }
});
