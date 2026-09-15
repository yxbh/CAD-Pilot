export type CameraState = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  projection?: "perspective" | "orthographic";
  viewHeight?: number;
};
export const VIEW_PRESETS: readonly ["iso", "top", "bottom", "front", "back", "right", "left"];
export const PROJECTIONS: readonly ["perspective", "orthographic"];
export const MATERIAL_FINISHES: readonly ["plastic", "satin", "polished", "rubber"];
export function validateCamera(camera: unknown): CameraState;
