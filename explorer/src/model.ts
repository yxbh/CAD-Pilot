import type { CameraState } from "../shared/view-settings.mjs";

export type Vec3 = [number, number, number];
export type Bounds = { min: Vec3; max: Vec3 };
export type CadFace = {
  id: string;
  triangleStart: number;
  triangleCount: number;
  surfaceType: string;
  area: number;
  center: Vec3;
  bounds: Bounds;
};
export type FaceSelection = { nodeId: string; faceId: string };
export type Part = {
  id: string;
  label: string;
  color: Vec3;
  positions: number[];
  normals: number[];
  indices: number[];
  bounds: Bounds;
  faces: CadFace[];
};
export type ModelNode = {
  id: string;
  label: string;
  parentId: string | null;
  partId: string | null;
  matrix: number[];
  color: Vec3;
};
export type Model = {
  schemaVersion: 2;
  topologyRevision: string;
  source: { name: string; sha256: string };
  units: "mm";
  parts: Part[];
  nodes: ModelNode[];
  bounds: Bounds;
  warnings: string[];
};
export type ViewState = {
  revision: number;
  documentRevision: string;
  topologyRevision: string;
  modelName: string;
  selectedIds: string[];
  selectedFace: FaceSelection | null;
  selectionMode: "face" | "part";
  autoCopy: boolean;
  hiddenIds: string[];
  explode: number;
  fixedId: string;
  direction: "radial" | "x" | "y" | "z";
  cameraPreset: "iso" | "top" | "bottom" | "front" | "back" | "right" | "left";
  projection: "perspective" | "orthographic";
  appearance: "inspect" | "studio";
  materialFinish: "plastic" | "satin" | "polished" | "rubber";
  showEdges: boolean;
  fitNonce: number;
  loading: boolean;
  error: string;
  activeReviewId: string | null;
  camera: CameraState | null;
};
export type Placement = { node: ModelNode; part: Part; matrix: number[]; bounds: Bounds };
export type HoverTarget = { nodeId: string; faceId: string | null };

export function faceAtTriangle(part: Part, triangle: number): CadFace | null {
  if (!Number.isInteger(triangle) || triangle < 0) return null;
  let low = 0;
  let high = part.faces.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const face = part.faces[middle];
    if (triangle < face.triangleStart) high = middle - 1;
    else if (triangle >= face.triangleStart + face.triangleCount) low = middle + 1;
    else return face;
  }
  return null;
}

export function hoverTarget(part: Part, nodeId: string, mode: ViewState["selectionMode"], triangle: number): HoverTarget | null {
  if (mode === "part") return { nodeId, faceId: null };
  const face = faceAtTriangle(part, triangle);
  return face ? { nodeId, faceId: face.id } : null;
}

export function facePositions(part: Part, face: CadFace): Float32Array {
  const result = new Float32Array(face.triangleCount * 9);
  const firstIndex = face.triangleStart * 3;
  for (let slot = 0; slot < face.triangleCount * 3; slot++) {
    const vertex = part.indices[firstIndex + slot] * 3;
    for (let axis = 0; axis < 3; axis++) result[slot * 3 + axis] = part.positions[vertex + axis];
  }
  return result;
}

export function center(bounds: Bounds): Vec3 {
  return bounds.min.map((value, i) => (value + bounds.max[i]) / 2) as Vec3;
}

export function diagonal(bounds: Bounds): number {
  return Math.hypot(...bounds.min.map((value, i) => bounds.max[i] - value));
}

export function newestState<T extends { revision: number }>(current: T | null, incoming: T): T {
  return current && current.revision > incoming.revision ? current : incoming;
}

export function transformBounds(bounds: Bounds, matrix: number[]): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = [0, 1, 2].map((axis) => (corner & (1 << axis) ? bounds.max : bounds.min)[axis]);
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

export function mergeBounds(bounds: Bounds[]): Bounds | null {
  if (!bounds.length) return null;
  return {
    min: [0, 1, 2].map((axis) => Math.min(...bounds.map((item) => item.min[axis]))) as Vec3,
    max: [0, 1, 2].map((axis) => Math.max(...bounds.map((item) => item.max[axis]))) as Vec3,
  };
}

export function placeParts(model: Model, amount: number, direction: ViewState["direction"], fixedId: string): Placement[] {
  const matrices = new Map<string, number[]>();
  const parts = new Map(model.parts.map((part) => [part.id, part]));
  const modelCenter = center(model.bounds);
  const distance = Math.max(diagonal(model.bounds) * 0.55, 1) * amount;
  const result: Placement[] = [];
  for (const node of model.nodes) {
    const parent = node.parentId ? matrices.get(node.parentId) : null;
    if (node.parentId && !parent) throw new Error(`Missing parent for ${node.id}`);
    const original = parent ? multiply(parent, node.matrix) : [...node.matrix];
    matrices.set(node.id, original);
    if (!node.partId) continue;
    const part = parts.get(node.partId);
    if (!part) throw new Error(`Missing geometry for ${node.id}`);
    const matrix = [...original];
    if (node.id !== fixedId && distance !== 0) {
      const partCenter = center(transformBounds(part.bounds, original));
      let vector: Vec3 = partCenter.map((value, i) => value - modelCenter[i]) as Vec3;
      if (direction !== "radial") {
        const axis = { x: 0, y: 1, z: 2 }[direction];
        const sign = vector[axis] < 0 ? -1 : 1;
        vector = [0, 0, 0];
        vector[axis] = sign * (0.6 + result.length * 0.18);
      } else {
        const length = Math.hypot(...vector);
        vector = length > 1e-9
          ? vector.map((value) => value / length) as Vec3
          : [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0]][result.length % 4] as Vec3;
      }
      for (let axis = 0; axis < 3; axis++) matrix[12 + axis] += vector[axis] * distance;
    }
    result.push({ node, part, matrix, bounds: transformBounds(part.bounds, matrix) });
  }
  return result;
}
import { multiply } from "../shared/matrix.mjs";
