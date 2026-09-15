export const VIEW_PRESETS = ["iso", "top", "bottom", "front", "back", "right", "left"];
export const PROJECTIONS = ["perspective", "orthographic"];
export const MATERIAL_FINISHES = ["plastic", "satin", "polished", "rubber"];

export function validateCamera(camera) {
  const vector = (value) => Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e12);
  if (!camera || !vector(camera.position) || !vector(camera.target) || !vector(camera.up) ||
      Math.hypot(...camera.up) < 0.01 || !Number.isFinite(camera.fov) || camera.fov < 1 || camera.fov > 160) throw new Error("Invalid camera");
  if (Math.hypot(...camera.position.map((value, i) => value - camera.target[i])) < 1e-8) throw new Error("Camera position and target must be different");
  if (camera.projection !== undefined && !PROJECTIONS.includes(camera.projection)) throw new Error("Invalid camera projection");
  if (camera.viewHeight !== undefined && (!Number.isFinite(camera.viewHeight) || camera.viewHeight <= 0 || camera.viewHeight > 1e12)) throw new Error("Invalid camera view height");
  if (camera.projection === "orthographic" && camera.viewHeight === undefined) throw new Error("Orthographic camera requires a view height");
  return camera;
}
