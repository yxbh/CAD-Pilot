import assert from "node:assert/strict";
import test from "node:test";
import { observeGraphicsContext } from "../src/graphicsLifecycle.ts";

test("graphics events are observed while mounted and detached before renderer disposal", () => {
  const canvas = new EventTarget();
  let losses = 0;
  let restorations = 0;
  const dispose = observeGraphicsContext(canvas, () => losses++, () => restorations++);
  const loss = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(loss);
  assert.equal(losses, 1);
  assert.equal(loss.defaultPrevented, true);
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(restorations, 1);
  dispose();
  canvas.dispatchEvent(new Event("webglcontextlost"));
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(losses, 1, "Intentional teardown must not report an error after unmount");
  assert.equal(restorations, 1);
});
