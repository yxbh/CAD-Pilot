import { Vector2 } from "three";
import type { CameraController } from "./camera.ts";

// Pointer positions stay in CSS pixels: all rotation, pan and cursor zoom scale with the canvas, not its DPR.
export function bindOrbitInput(canvas: HTMLCanvasElement, rig: CameraController, changed: () => void, commit: () => void) {
  const pointers = new Map<number, Vector2>();
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let enabled = true, moved = false;
  let pointerType = "";
  let mode: "orbit" | "pan" | "zoom" = "orbit";
  // Upside down, a yaw about world Z moves the model's near side against the pointer, so the drag reverses it.
  // The way is chosen when the drag starts, so carrying the camera over a pole doesn't flip it partway.
  let turn = 1;
  const oldTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  function zoom(factor: number, x: number, y: number) {
    const b = canvas.getBoundingClientRect();
    return rig.zoomAt(factor, (x - b.left - b.width / 2) / b.height, (b.top + b.height / 2 - y) / b.height);
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (!enabled || e.button > 2) return;
    // Only fingers from the same touch gesture may share its pan/zoom state (e.g. a palm during pen input).
    if (pointers.size && (pointerType !== "touch" || e.pointerType !== "touch")) return;
    if (!pointers.size) turn = rig.upsideDown() ? -1 : 1;
    pointerType = e.pointerType;
    pointers.set(e.pointerId, new Vector2(e.clientX, e.clientY));
    canvas.setPointerCapture(e.pointerId);
    const modified = e.ctrlKey || e.metaKey || e.shiftKey;
    const pan = e.pointerType !== "touch" && (e.button === 2 ? !modified : modified);
    mode = e.button === 1 ? "zoom" : pan ? "pan" : "orbit";
  }, options);
  canvas.addEventListener("pointermove", (e) => {
    const previous = pointers.get(e.pointerId);
    if (!enabled || !previous) return;
    const dx = e.clientX - previous.x, dy = e.clientY - previous.y;
    if (!dx && !dy) return;
    const h = canvas.clientHeight;
    if (pointers.size === 2 && e.pointerType === "touch") {
      const other = [...pointers.values()].find(p => p !== previous)!;
      const before = previous.distanceTo(other);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before && after) zoom(before / after, (previous.x + other.x) / 2, (previous.y + other.y) / 2);
      previous.set(e.clientX, e.clientY);
      rig.pan(-dx / (2 * h), dy / (2 * h));
    } else {
      previous.set(e.clientX, e.clientY);
      if (pointers.size !== 1) return;
      if (mode === "pan") rig.pan(-dx / h, dy / h);
      else if (mode === "orbit") rig.orbit(-2 * Math.PI * turn * dx / h, -2 * Math.PI * dy / h);
      else if (!zoom(0.95 ** (-dy * 0.01), e.clientX, e.clientY)) return;
    }
    moved = true;
    changed();
  }, options);
  const finish = (e: PointerEvent) => {
    if (pointers.delete(e.pointerId) && !pointers.size && moved) {
      moved = false;
      if (enabled) commit();
    }
  };
  canvas.addEventListener("pointerup", finish, options);
  canvas.addEventListener("pointercancel", finish, options);
  canvas.addEventListener("lostpointercapture", finish, options);
  canvas.addEventListener("contextmenu", (e) => { if (enabled) e.preventDefault(); }, options);
  // Browsers report trackpad pinch as Ctrl+wheel, even though no Control key was pressed.
  let controlKeyDown = false;
  const win = canvas.ownerDocument.defaultView;
  win?.addEventListener("keydown", (e) => { if (e.key === "Control") controlKeyDown = true; }, options);
  win?.addEventListener("keyup", (e) => { if (e.key === "Control") controlKeyDown = false; }, options);
  win?.addEventListener("blur", () => {
    controlKeyDown = false;
    // The release may go to another window. Finish the drag here, before a buttonless move can orbit again.
    const save = enabled && moved;
    reset();
    if (save) commit();
  }, options);
  canvas.addEventListener("wheel", (e) => {
    if (!enabled || pointers.size) return;
    e.preventDefault();
    if (!e.deltaY) return;
    const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    const pinch = e.ctrlKey && !controlKeyDown;
    if (!zoom(0.95 ** (-pixels * (pinch ? 0.1 : 0.01)), e.clientX, e.clientY)) return;
    changed();
    commit();
  }, { ...options, passive: false });
  const reset = () => {
    for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    pointers.clear();
    moved = false;
  };
  return {
    set enabled(value: boolean) { enabled = value; if (!value) reset(); },
    dispose() { listeners.abort(); reset(); canvas.style.touchAction = oldTouchAction; },
  };
}
