import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { center, diagonal, type Bounds, type Vec3 } from "./model.ts";
import type { CameraState } from "./host.ts";
import { angleView } from "../shared/view-settings.mjs";

export type Projection = "perspective" | "orthographic";
export type ViewPreset = "iso" | "top" | "bottom" | "front" | "back" | "right" | "left";
// A named view or "azimuth:elevation" in degrees.
export type ViewDirection = ViewPreset | `${number}:${number}`;
export type ViewCamera = PerspectiveCamera | OrthographicCamera;
export const axisViews: { id: ViewPreset; axis: string; label: string; color: string; direction: Vec3; up: Vec3 }[] = [
  { id: "right", axis: "+X", label: "Right view (+X)", color: "#f17b7b", direction: [1, 0, 0], up: [0, 0, 1] },
  { id: "left", axis: "-X", label: "Left view (-X)", color: "#f17b7b", direction: [-1, 0, 0], up: [0, 0, 1] },
  { id: "back", axis: "+Y", label: "Back view (+Y)", color: "#92d789", direction: [0, 1, 0], up: [0, 0, 1] },
  { id: "front", axis: "-Y", label: "Front view (-Y)", color: "#92d789", direction: [0, -1, 0], up: [0, 0, 1] },
  { id: "top", axis: "+Z", label: "Top view (+Z)", color: "#82b5ff", direction: [0, 0, 1], up: [0, 1, 0] },
  { id: "bottom", axis: "-Z", label: "Bottom view (-Z)", color: "#82b5ff", direction: [0, 0, -1], up: [0, 1, 0] },
];
// OrbitControls keeps the camera at least 1e-6 rad from its poles; stay clear of that clamp.
const poleTilt = 1e-5;

export function viewHeight(camera: ViewCamera, target: Vector3): number {
  return camera instanceof OrthographicCamera
    ? (camera.top - camera.bottom) / camera.zoom
    : 2 * camera.position.distanceTo(target) * Math.tan(camera.fov * Math.PI / 360) / camera.zoom;
}

export class CameraController {
  // R3F must not replace controller-owned world-space frusta on size/DPR changes.
  readonly perspective = Object.assign(new PerspectiveCamera(42, 1, 0.01, 10000), { manual: true });
  readonly orthographic = Object.assign(new OrthographicCamera(-1, 1, 1, -1, 0.01, 10000), { manual: true });
  readonly target = new Vector3();
  camera: ViewCamera = this.perspective;
  private aspect = 1;

  constructor() {
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -180, 120);
    this.camera.lookAt(this.target);
  }
  get projection(): Projection { return this.camera instanceof OrthographicCamera ? "orthographic" : "perspective"; }
  resize(width: number, height: number) {
    this.aspect = Math.max(width / Math.max(height, 1), 0.05);
    this.perspective.aspect = this.aspect;
    const halfHeight = (this.orthographic.top - this.orthographic.bottom) / 2;
    this.orthographic.left = -halfHeight * this.aspect;
    this.orthographic.right = halfHeight * this.aspect;
    this.perspective.updateProjectionMatrix();
    this.orthographic.updateProjectionMatrix();
  }
  private setOrthoHeight(height: number) {
    this.orthographic.top = height / 2;
    this.orthographic.bottom = -height / 2;
    this.orthographic.left = -height * this.aspect / 2;
    this.orthographic.right = height * this.aspect / 2;
    this.orthographic.zoom = 1;
    this.orthographic.updateProjectionMatrix();
  }
  setProjection(projection: Projection) {
    if (this.projection === projection) return;
    const old = this.camera;
    const height = viewHeight(old, this.target);
    const next = projection === "orthographic" ? this.orthographic : this.perspective;
    next.position.copy(old.position);
    next.up.copy(old.up);
    next.near = old.near;
    next.far = old.far;
    if (projection === "orthographic") this.setOrthoHeight(height);
    else {
      const direction = old.position.clone().sub(this.target).normalize();
      next.zoom = 1;
      next.position.copy(this.target).addScaledVector(direction, height / (2 * Math.tan(this.perspective.fov * Math.PI / 360)));
    }
    this.camera = next;
    this.update();
  }
  // A fit is made in the projection that draws it: switching projection afterwards keeps the earlier one's scale.
  fit(bounds: Bounds, preset: ViewDirection, projection: Projection) {
    this.camera = projection === "orthographic" ? this.orthographic : this.perspective;
    const radius = Math.max(diagonal(bounds) / 2, 0.01);
    const axis = axisViews.find((item) => item.id === preset) ?? angleView(preset);
    const direction = new Vector3(...(axis?.direction ?? [1.35, -1.8, 1.3] as Vec3)).normalize();
    this.target.set(...center(bounds));
    const distance = radius / Math.sin(Math.atan(Math.tan(this.perspective.fov * Math.PI / 360) * Math.min(this.aspect, 1))) * 1.18;
    this.camera.position.copy(this.target).addScaledVector(direction, distance);
    this.level(new Vector3(...(axis?.up ?? [0, 0, 1] as Vec3)));
    this.camera.near = Math.max(radius / 2000, 0.0001);
    this.camera.far = Math.max(radius * 100, distance * 4);
    this.camera.zoom = 1;
    if (projection === "orthographic") this.setOrthoHeight(radius * 2 * 1.18 / Math.min(this.aspect, 1));
    this.update();
  }
  restore(snapshot: CameraState) {
    this.perspective.fov = snapshot.fov;
    this.camera = snapshot.projection === "orthographic" ? this.orthographic : this.perspective;
    this.camera.position.set(...snapshot.position);
    this.target.set(...snapshot.target);
    this.level(new Vector3(...snapshot.up));
    this.camera.zoom = 1;
    if (snapshot.projection === "orthographic" && snapshot.viewHeight) this.setOrthoHeight(snapshot.viewHeight);
    const distance = this.camera.position.distanceTo(this.target);
    this.camera.near = Math.max(distance / 10000, 0.0001);
    this.camera.far = Math.max(distance * 100, 2000);
    this.update();
  }
  // OrbitControls turns around camera.up, so world Z stays up and drags spin the model like a turntable.
  // A view straight along Z tilts imperceptibly toward its screen bottom to keep the requested screen orientation.
  private level(screenUp: Vector3) {
    const offset = this.camera.position.clone().sub(this.target);
    const distance = offset.length();
    const horizontal = new Vector3(screenUp.x, screenUp.y, 0);
    if (Math.hypot(offset.x, offset.y) < distance * poleTilt && horizontal.lengthSq() > 0) {
      const side = Math.sign(offset.z);
      offset.copy(horizontal.setLength(-side * Math.sin(poleTilt))).setZ(side * Math.cos(poleTilt));
      this.camera.position.copy(this.target).addScaledVector(offset, distance);
    }
    this.camera.up.set(0, 0, 1);
  }
  update() {
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
  }
  snapshot(): CameraState {
    return {
      position: this.camera.position.toArray(), target: this.target.toArray(), up: this.camera.up.toArray(),
      fov: this.perspective.fov, projection: this.projection, viewHeight: viewHeight(this.camera, this.target),
    };
  }
}
