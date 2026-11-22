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
    rig.fit(bounds, "iso", projection);
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
const screenUp = (rig: CameraController) => new Vector3().setFromMatrixColumn(rig.camera.matrixWorld, 1);
test("all six axis views look along the correct signed world axis with their requested screen orientation", () => {
  const rig = new CameraController();
  rig.resize(1000, 700);
  for (const axis of axisViews) {
    rig.fit(bounds, axis.id, "perspective");
    const facing = rig.camera.position.clone().sub(rig.target).normalize();
    close(facing.distanceTo(new Vector3(...axis.direction)), 0);
    close(rig.camera.getWorldDirection(new Vector3()).dot(facing), -1);
    close(screenUp(rig).distanceTo(new Vector3(...axis.up)), 0);
    assert.ok(rig.camera.matrixWorld.elements.every(Number.isFinite));
  }
});
test("dragging sideways from any view spins the model about world Z", () => {
  const rig = new CameraController();
  rig.resize(1000, 700);
  for (const preset of ["iso", ...axisViews.map((axis) => axis.id)] as const) {
    rig.fit(bounds, preset, "perspective");
    const offset = rig.camera.position.clone().sub(rig.target);
    const up = screenUp(rig);
    rig.orbit(-0.5, 0);
    const spin = (v: Vector3) => v.clone().applyAxisAngle(new Vector3(0, 0, 1), -0.5);
    close(rig.camera.position.clone().sub(rig.target).distanceTo(spin(offset)), 0, 1e-9 * offset.length());
    close(screenUp(rig).distanceTo(spin(up)), 0, 1e-4);
  }
});
test("restoring an older camera at a pole uses its saved heading", () => {
  const rig = new CameraController();
  rig.resize(1000, 700);
  for (const [z, up] of [[180, [0, 1, 0]], [-180, [0, 1, 0]], [180, [1, 0, 0]]] as const) {
    rig.restore({ position: [3, 4, z], target: [3, 4, 0], up: [...up], fov: 42 });
    close(rig.camera.getWorldDirection(new Vector3()).distanceTo(new Vector3(0, 0, -Math.sign(z))), 0, 1e-4);
    close(screenUp(rig).distanceTo(new Vector3(...up)), 0, 1e-4);
  }
});
test("orbit crosses both poles, spins inverted about Z, and retraces its path", () => {
  const rig = new CameraController();
  for (const sign of [-1, 1]) {
    rig.fit(bounds, `0:${sign * 75}`, "orthographic");
    const back = () => rig.camera.getWorldDirection(new Vector3()).negate();
    const before = back(), upright = screenUp(rig);
    const radius = rig.camera.position.distanceTo(rig.target);
    rig.orbit(0, -sign * Math.PI / 6);
    close(back().z, before.z);
    close(back().y, -before.y);
    assert.ok(screenUp(rig).z < 0 && screenUp(rig).dot(upright) > 0.8);
    const inverted = back(), up = screenUp(rig);
    rig.orbit(Math.PI / 3, 0);
    const spin = (v: Vector3) => v.clone().applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 3);
    close(back().distanceTo(spin(inverted)), 0);
    close(screenUp(rig).distanceTo(spin(up)), 0);
    rig.restore(rig.snapshot());
    rig.setProjection("perspective");
    rig.setProjection("orthographic");
    close(screenUp(rig).distanceTo(spin(up)), 0);
    // Projection conversion preserves view height rather than eye distance.
    rig.orbit(-Math.PI / 3, sign * Math.PI / 6);
    close(back().distanceTo(before), 0);
    close(screenUp(rig).distanceTo(upright), 0);
    rig.fit(bounds, `0:${sign * 75}`, "orthographic");
    rig.orbit(0, 2 * Math.PI);
    close(rig.camera.position.distanceTo(rig.target), radius);
    close(back().distanceTo(before), 0);
  }
});
test("projection round trips preserve target, orientation and target-plane image size, including ortho zoom", () => {
  const rig = new CameraController();
  rig.resize(1100, 750);
  rig.fit(bounds, "iso", "perspective");
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
test("zooming an inverted, panned view keeps the point under an off-centre cursor", () => {
  const rig = new CameraController();
  rig.resize(1000, 700);
  for (const projection of ["perspective", "orthographic"] as const) {
    rig.fit(bounds, "top", projection);
    rig.orbit(0.6, -0.5);
    rig.pan(0.2, -0.1);
    const height = viewHeight(rig.camera, rig.target);
    const anchor = new Vector3(0.35, -0.27, 0).multiplyScalar(height).applyQuaternion(rig.camera.quaternion).add(rig.target);
    const before = anchor.clone().project(rig.camera);
    rig.zoomAt(0.65, 0.35, -0.27);
    const after = anchor.clone().project(rig.camera);
    close(after.x, before.x);
    close(after.y, before.y);
    close(viewHeight(rig.camera, rig.target), height * 0.65);
  }
});
test("orthographic projection has equal scale at different depths; perspective does not", () => {
  const rig = new CameraController();
  rig.resize(900, 600);
  rig.fit(bounds, "front", "perspective");
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
      rig.fit(box, preset, projection);
      for (let corner = 0; corner < 8; corner++) {
        const p = new Vector3(...[0, 1, 2].map((axis) => (corner & (1 << axis) ? box.max : box.min)[axis]) as Bounds["min"]).project(rig.camera);
        assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1, `${projection}/${preset}: ${p.toArray()}`);
      }
    }
  }
});
test("a fit frames the view the same whichever projection the camera had before", () => {
  for (const projection of ["perspective", "orthographic"] as const) {
    const heights = (["perspective", "orthographic"] as const).map((before) => {
      const rig = new CameraController();
      rig.resize(1280, 800);
      rig.setProjection(before);
      rig.fit(bounds, "iso", projection);
      assert.equal(rig.projection, projection);
      return viewHeight(rig.camera, rig.target);
    });
    close(heights[0], heights[1]);
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
