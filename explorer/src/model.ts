import type { CameraState } from "../shared/view-settings.mjs";
import type { SectionSettings } from "../shared/section.mjs";
import type { AssemblySequence, SequencePose, StepMode } from "../shared/placement.mjs";
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
export type PointSelection = { nodeId: string; triangle: number; point: number[] };
export type MeshFaults = { openEdges: number; oversharedEdges: number; flippedEdges: number; degenerateTriangles: number };
export type MeshBuffers = {
  positions: Float32Array; indices: Uint32Array; outlines: Uint32Array; openEdges: Uint32Array;
  oversharedEdges: Uint32Array; flippedEdges: Uint32Array; degenerateTriangles: Uint32Array;
};
// STEP previews carry JSON arrays and CAD faces; mesh parts carry typed views of their geometry file and no faces.
export type Part = {
  id: string;
  label: string;
  color: Vec3;
  positions: ArrayLike<number>;
  normals?: number[];
  indices: ArrayLike<number>;
  bounds: Bounds;
  faces: CadFace[];
  edges?: CadEdge[];
  sectionCaps?: boolean;
  documentId?: string;
  buffers?: Record<keyof MeshBuffers, { offset: number; count: number }>;
  mesh?: MeshBuffers;
  vertexCount?: number;
  triangleCount?: number;
  closed?: boolean;
  faults?: MeshFaults;
  area?: number;
  volume?: number | null;
};
export type ModelNode = {
  id: string;
  label: string;
  /** False for a STEP part or group nobody named, whose label is made up after its group. */
  labelled?: boolean;
  parentId: string | null;
  partId: string | null;
  matrix: number[];
  color: Vec3;
  documentId?: string;
  sourceId?: string;
  ghost?: boolean;
};
export type MeshFrame = { units: string; up: "z" | "y"; note: string };
export type ViewDocument = {
  id: string; name: string; kind: "step" | "mesh"; format: string; topologyRevision: string;
  frame: MeshFrame | null; style: "solid" | "ghost"; offset: number[]; rotate: number[];
};
export type Model = {
  schemaVersion: 2;
  kind?: "mesh" | "view";
  topologyRevision: string;
  source: { name: string; sha256: string; format?: string };
  documents?: { id: string; name: string; kind: string; sha256: string; topologyRevision: string; bounds: Bounds }[];
  frame?: MeshFrame;
  units: "mm";
  parts: Part[];
  nodes: ModelNode[];
  bounds: Bounds;
  sourceBounds?: Bounds;
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
  selectedPoint: PointSelection | null;
  selectionMode: "face" | "edge" | "point" | "part";
  autoCopy: boolean;
  hiddenIds: string[];
  documents: ViewDocument[];
  layout: "overlay" | "side";
  showFaults: boolean;
  explode: number;
  fixedId: string;
  direction: "radial" | "x" | "y" | "z";
  assembly: AssemblySequence | null;
  step: number | null;
  stepMode: StepMode;
  // A named view, or "azimuth:elevation" in degrees.
  cameraPreset: "iso" | "top" | "bottom" | "front" | "back" | "right" | "left" | `${number}:${number}`;
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
  // True once the person moved the camera; otherwise the view is fitted from cameraPreset.
  cameraPinned: boolean;
  source: { file: string; generatedAt: string; size: number; sha256: string };
  viewKept: boolean | null;
};
export type Placement = { node: ModelNode; part: Part; matrix: number[]; bounds: Bounds; offset: number[] | null };
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

export function placeParts(model: Model, amount: number, direction: ViewState["direction"], fixedId: string, sequence: SequencePose | null = null): Placement[] {
  return sharedPlaceParts(model, amount, direction, fixedId, sequence);
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

export const isMesh = (part: Part) => !!part.buffers;

// The scene is drawn relative to the files' own centre, not where the view arranges them, so moving a file in the
// view moves only that file and the camera stays put.
export function sceneOrigin(model: Model): Vec3 {
  return center(model.sourceBounds ?? model.bounds);
}

export function hoverTarget(part: Part, nodeId: string, mode: ViewState["selectionMode"], triangle: number): HoverTarget | null {
  // Meshes have no CAD faces or edges, so every mode picks their whole part.
  if (mode === "part" || mode === "point" || isMesh(part)) return { nodeId, faceId: null };
  if (mode === "edge") return null;
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
