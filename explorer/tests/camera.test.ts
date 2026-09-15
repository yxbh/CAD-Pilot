import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three";
import { CameraController, axisViews, viewHeight } from "../src/camera.ts";
import { validateCamera } from "../shared/view-settings.mjs";
import type { Bounds } from "../src/model.ts";

const bounds: Bounds = { min: [-50, -32.5, -17.5], max: [50, 32.5, 17.5] };
const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
test("both controller cameras explicitly retain projection ownership in R3F", () => {
  const rig = new CameraController();
  assert.equal(rig.perspective.manual, true);
  assert.equal(rig.orthographic.manual, true);
});
test("resizing only changes horizontal coverage for both projections, including zoomed orthographic views", () => {
  const rig = new CameraController();
  rig.resize(1100, 750);
  for (const projection of ["perspective", "orthographic"] as const) {
    rig.setProjection(projection);
    rig.fit(bounds, "iso");
    rig.target.add(new Vector3(11, -8, 4));
    rig.camera.position.add(new Vector3(7, 2, -6));
    rig.camera.zoom = 2.7;
    rig.update();
    const snapshot = rig.snapshot();
    const direction = rig.camera.getWorldDirection(new Vector3());
    const matrix = rig.camera.projectionMatrix.elements.slice();
    for (const [width, height] of [[1200, 700], [400, 900], [400, 600], [1100, 750]]) {
      rig.resize(width, height);
      assert.deepEqual(rig.snapshot(), snapshot);
      close(rig.camera.zoom, 2.7);
      close(rig.camera.getWorldDirection(new Vector3()).distanceTo(direction), 0);
      close(rig.camera.projectionMatrix.elements[5], matrix[5]);
      close(rig.camera.projectionMatrix.elements[5] / rig.camera.projectionMatrix.elements[0], width / height);
    }
    const restored = new CameraController();
    restored.resize(500, 700);
    if (projection === "orthographic") {
      restored.restore(snapshot);
      close(restored.camera.zoom, 1);
      close(restored.snapshot().viewHeight!, snapshot.viewHeight!);
    }
  }
});
test("all six axis views look straight at the correct signed world axis", () => {
  const rig = new CameraController();
  rig.resize(1000, 700);
  for (const axis of axisViews) {
    rig.fit(bounds, axis.id);
    const facing = rig.camera.position.clone().sub(rig.target).normalize();
    close(facing.distanceTo(new Vector3(...axis.direction)), 0);
    close(rig.camera.getWorldDirection(new Vector3()).dot(facing), -1);
    close(rig.camera.up.dot(facing), 0);
    assert.ok(rig.camera.matrixWorld.elements.every(Number.isFinite));
  }
});
test("projection round trips preserve target, orientation and target-plane image size, including ortho zoom", () => {
  const rig = new CameraController();
  rig.resize(1100, 750);
  rig.fit(bounds, "iso");
  rig.target.add(new Vector3(10, -5, 3));
  rig.update();
  const first = rig.snapshot();
  for (let i = 0; i < 50; i++) {
    const height = viewHeight(rig.camera, rig.target);
    const direction = rig.camera.getWorldDirection(new Vector3());
    rig.setProjection("orthographic");
    close(viewHeight(rig.camera, rig.target), height);
    close(rig.camera.getWorldDirection(new Vector3()).distanceTo(direction), 0);
    rig.setProjection("perspective");
    close(viewHeight(rig.camera, rig.target), height);
  }
  close(new Vector3(...rig.snapshot().position).distanceTo(new Vector3(...first.position)), 0);
  assert.deepEqual(rig.snapshot().target, first.target);
  rig.setProjection("orthographic");
  rig.camera.zoom = 3.7;
  rig.update();
  const zoomed = viewHeight(rig.camera, rig.target);
  rig.setProjection("perspective");
  close(viewHeight(rig.camera, rig.target), zoomed);
});
test("orthographic projection has equal scale at different depths; perspective does not", () => {
  const rig = new CameraController();
  rig.resize(900, 600);
  rig.fit(bounds, "front");
  const projectedWidth = (depth: number) => {
    const a = new Vector3(-10, depth, 0).project(rig.camera);
    const b = new Vector3(10, depth, 0).project(rig.camera);
    return b.x - a.x;
  };
  assert.ok(Math.abs(projectedWidth(-30) - projectedWidth(30)) > 0.005);
  rig.setProjection("orthographic");
  close(projectedWidth(-30), projectedWidth(30));
});
test("fit includes all bbox corners for both projections, tiny/large models and portrait/landscape views", () => {
  for (const scale of [0.01, 1, 100]) for (const [width, height] of [[1000, 700], [350, 800]]) {
    const rig = new CameraController();
    rig.resize(width, height);
    const box: Bounds = { min: bounds.min.map((n) => n * scale) as Bounds["min"], max: bounds.max.map((n) => n * scale) as Bounds["max"] };
    for (const projection of ["perspective", "orthographic"] as const) for (const preset of ["iso", ...axisViews.map((axis) => axis.id)] as const) {
      rig.setProjection(projection);
      rig.fit(box, preset);
      for (let corner = 0; corner < 8; corner++) {
        const p = new Vector3(...[0, 1, 2].map((axis) => (corner & (1 << axis) ? box.max : box.min)[axis]) as Bounds["min"]).project(rig.camera);
        assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1, `${projection}/${preset}: ${p.toArray()}`);
      }
    }
  }
});
test("legacy perspective snapshots and ortho zoom/pan restore without changing their view footprint", () => {
  const rig = new CameraController();
  rig.resize(1000, 700);
  rig.restore({ position: [220, -120, 90], target: [15, 2, 4], up: [0, 0, 1], fov: 50 });
  assert.equal(rig.projection, "perspective");
  rig.setProjection("orthographic");
  rig.camera.zoom = 2.2;
  rig.update();
  const snapshot = rig.snapshot();
  const restored = new CameraController();
  restored.resize(1000, 700);
  restored.restore(snapshot);
  close(viewHeight(restored.camera, restored.target), snapshot.viewHeight!);
  assert.deepEqual(restored.snapshot().position, snapshot.position);
  assert.deepEqual(restored.snapshot().target, snapshot.target);
  restored.resize(500, 700);
  close(viewHeight(restored.camera, restored.target), snapshot.viewHeight!);
});
test("camera validation accepts old snapshots and rejects incomplete or invalid projections", () => {
  const legacy = { position: [10, -20, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 42 };
  assert.equal(validateCamera(legacy), legacy);
  assert.throws(() => validateCamera({ ...legacy, projection: "orthographic" }), /view height/);
  assert.throws(() => validateCamera({ ...legacy, projection: "fish-eye" }), /projection/);
  for (const viewHeight of [0, -1, NaN, Infinity]) assert.throws(() => validateCamera({ ...legacy, projection: "orthographic", viewHeight }), /height/);
  assert.throws(() => validateCamera({ ...legacy, position: legacy.target }), /different/);
});
