import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three";
import { CameraController, type ViewDirection } from "../src/camera.ts";
import { bindOrbitInput } from "../src/orbitInput.ts";
import type { Bounds } from "../src/model.ts";

const bounds: Bounds = { min: [-50, -32.5, -17.5], max: [50, 32.5, 17.5] };
const height = 600;

// Just enough of a canvas for bindOrbitInput: pointer events, capture and a size.
function fakeCanvas() {
  const canvas = Object.assign(new EventTarget(), {
    style: { touchAction: "" },
    clientHeight: height,
    ownerDocument: { defaultView: null },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height }),
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
  });
  return canvas as unknown as HTMLCanvasElement;
}
function pointer(canvas: HTMLCanvasElement) {
  let x = 450, y = 300;
  const send = (type: string) => canvas.dispatchEvent(Object.assign(new Event(type), {
    pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y, ctrlKey: false, metaKey: false, shiftKey: false,
  }));
  return {
    down() { send("pointerdown"); },
    move(dx: number, dy: number) { x += dx; y += dy; send("pointermove"); },
    up() { send("pointerup"); },
  };
}
function setup(view: ViewDirection) {
  const rig = new CameraController();
  rig.resize(900, height);
  rig.fit(bounds, view, "perspective");
  const canvas = fakeCanvas();
  bindOrbitInput(canvas, rig, () => {}, () => {});
  return { rig, mouse: pointer(canvas) };
}
// A point on the model's near side: towards the camera, level with the target.
function nearSide(rig: CameraController) {
  const toward = rig.camera.position.clone().sub(rig.target).setZ(0).normalize();
  return rig.target.clone().addScaledVector(toward, 20);
}
const screenX = (rig: CameraController, point: Vector3) => point.clone().project(rig.camera).x;

test("a sideways drag moves the model's near side with the pointer, upright, upside down and from below", () => {
  // Elevation 75 or -75 dragged a twelfth of the height over its pole is upside down.
  for (const [view, crossing] of [["30:20", 0], ["30:-40", 0], ["0:75", 50], ["0:-75", -50]] as const) {
    for (const dx of [-40, 40]) {
      const { rig, mouse } = setup(view);
      if (crossing) { mouse.down(); mouse.move(0, crossing); mouse.up(); }
      assert.equal(rig.upsideDown(), crossing !== 0, view);
      const point = nearSide(rig), before = screenX(rig, point);
      mouse.down(); mouse.move(dx, 0); mouse.up();
      assert.ok(Math.sign(screenX(rig, point) - before) === Math.sign(dx), `${view} dx ${dx}`);
    }
  }
});

test("exact Top and Bottom views count as upright", () => {
  for (const view of ["top", "bottom"] as const) assert.equal(setup(view).rig.upsideDown(), false, view);
});

test("a drag that carries the camera over a pole keeps the sideways direction it started with", () => {
  for (const sign of [-1, 1]) {
    const { rig, mouse } = setup(`0:${sign * 75}`);
    const reference = new CameraController();
    reference.resize(900, height);
    reference.fit(bounds, `0:${sign * 75}`, "perspective");
    mouse.down();
    mouse.move(0, sign * 50);
    assert.ok(rig.upsideDown());
    mouse.move(40, 0);
    mouse.up();
    // Still the upright drag's yaw, not reversed partway through.
    reference.orbit(0, -2 * Math.PI * sign * 50 / height);
    reference.orbit(-2 * Math.PI * 40 / height, 0);
    assert.ok(rig.camera.position.distanceTo(reference.camera.position) < 1e-6);
    // The next drag starts upside down and turns the other way.
    mouse.down(); mouse.move(40, 0); mouse.up();
    reference.orbit(2 * Math.PI * 40 / height, 0);
    assert.ok(rig.camera.position.distanceTo(reference.camera.position) < 1e-6);
  }
});
