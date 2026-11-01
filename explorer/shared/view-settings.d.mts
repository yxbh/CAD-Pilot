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
export const MATERIAL_FINISHES: readonly ["matte", "plastic", "satin", "polished", "rubber"];
export const APPEARANCES: readonly ["inspect", "studio", "raytraced"];
export function validateCamera(camera: unknown): CameraState;
export function viewAngle(azimuth: unknown, elevation: unknown): string;
export function angleView(preset: string): { direction: [number, number, number]; up: [number, number, number] } | null;
