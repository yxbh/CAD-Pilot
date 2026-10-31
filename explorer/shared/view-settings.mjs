export const VIEW_PRESETS = ["iso", "top", "bottom", "front", "back", "right", "left"];
export const PROJECTIONS = ["perspective", "orthographic"];
export const MATERIAL_FINISHES = ["plastic", "satin", "polished", "rubber"];

// A camera direction by angles: azimuth 0 looks from the front (-Y) and 90 from the right (+X); elevation 90 looks down from the top.
const anglePattern = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/;
export function viewAngle(azimuth, elevation) {
  if (![azimuth, elevation].every((value) => typeof value === "number" && Number.isFinite(value)) || Math.abs(azimuth) > 360 || Math.abs(elevation) > 90) {
    throw new Error("Choose an azimuth from -360 to 360 and an elevation from -90 to 90 degrees");
  }
  const round = (value) => Math.round(value * 100) / 100;
  return `${round(azimuth)}:${round(elevation)}`;
}
// The direction from the target to the camera, and the screen-up direction a view straight down or up keeps.
export function angleView(preset) {
  const match = anglePattern.exec(preset);
  if (!match) return null;
  const [azimuth, elevation] = [Number(match[1]), Number(match[2])].map((degrees) => degrees * Math.PI / 180);
  return {
    direction: [Math.sin(azimuth) * Math.cos(elevation), -Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation)],
    up: [-Math.sin(azimuth), Math.cos(azimuth), 0],
  };
}

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
