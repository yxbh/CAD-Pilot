import type { CameraState } from "../shared/view-settings.mjs";
import type { SectionSettings } from "../shared/section.mjs";
import {
  center as sharedCenter,
  diagonal as sharedDiagonal,
  mergeBounds as sharedMergeBounds,
  placeParts as sharedPlaceParts,
  transformBounds as sharedTransformBounds,
} from "../shared/placement.mjs";

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
export type CadEdge = {
  id: string;
  positions: number[];
  curveType: string;
  length: number;
  center: Vec3;
  bounds: Bounds;
};
export type EdgeSelection = { nodeId: string; edgeId: string };
export type Part = {
  id: string;
  label: string;
  color: Vec3;
  positions: number[];
  normals: number[];
  indices: number[];
  bounds: Bounds;
  faces: CadFace[];
  edges?: CadEdge[];
  sectionCaps?: boolean;
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
  cleanup?: { degenerateEdges: number | null; zeroAreaTriangles: number | null };
};
export type ViewState = {
  revision: number;
  documentRevision: string;
  topologyRevision: string;
  modelName: string;
  selectedIds: string[];
  selectedFace: FaceSelection | null;
  selectedEdge: EdgeSelection | null;
  selectionMode: "face" | "edge" | "part";
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
  section: SectionSettings;
  fitNonce: number;
  loading: boolean;
  error: string;
  activeReviewId: string | null;
  camera: CameraState | null;
};
export type Placement = { node: ModelNode; part: Part; matrix: number[]; bounds: Bounds };
export type HoverTarget = { nodeId: string; faceId: string | null; edgeId?: string };

export function center(bounds: Bounds): Vec3 {
  return sharedCenter(bounds);
}

export function diagonal(bounds: Bounds): number {
  return sharedDiagonal(bounds);
}

export function transformBounds(bounds: Bounds, matrix: number[]): Bounds {
  return sharedTransformBounds(bounds, matrix);
}

export function mergeBounds(bounds: Bounds[]): Bounds | null {
  return sharedMergeBounds(bounds);
}

export function placeParts(model: Model, amount: number, direction: ViewState["direction"], fixedId: string): Placement[] {
  return sharedPlaceParts(model, amount, direction, fixedId);
}

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
  if (mode === "edge") return null;
  if (mode === "part") return { nodeId, faceId: null };
  const face = faceAtTriangle(part, triangle);
  return face ? { nodeId, faceId: face.id } : null;
}

export function edgeSegments(edge: CadEdge): number[] {
  const segments: number[] = [];
  for (let offset = 0; offset + 5 < edge.positions.length; offset += 3) {
    segments.push(...edge.positions.slice(offset, offset + 6));
  }
  return segments;
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

export function newestState<T extends { revision: number }>(current: T | null, incoming: T): T {
  return current && current.revision > incoming.revision ? current : incoming;
}
