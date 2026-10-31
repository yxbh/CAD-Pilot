import { BufferAttribute, BufferGeometry, EdgesGeometry, Float32BufferAttribute } from "three";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { MeshBVH } from "three-mesh-bvh";
import { edgeSegments, type CadEdge, type MeshBuffers, type Model, type Part } from "./model.ts";
import type { TreeRequest, TreeResult } from "./bvhWorker.ts";

export type EdgeRange = { edge: CadEdge; start: number; count: number };
export type PartResources = { geometry: BufferGeometry; edges: BufferGeometry | null; cadEdges: LineSegmentsGeometry | null; edgeRanges: EdgeRange[] };
export type FaultResources = {
  open: LineSegmentsGeometry | null; overshared: LineSegmentsGeometry | null; flipped: LineSegmentsGeometry | null;
  degenerate: BufferGeometry | null; segments: number;
};
// Brute-force picking is fine for CAD previews; dense meshes get a bounding-volume tree so hovering stays quick.
const TREE_TRIANGLES = 20_000;

// One worker builds every tree, one part at a time; until a part's tree arrives it is picked brute force.
let treeWorker: Worker | null = null;
let nextRequest = 0;
const waiting = new Map<number, (result: TreeResult) => void>();
function buildTree(positions: Float32Array, indices: Uint32Array): Promise<TreeResult> {
  if (!treeWorker) {
    treeWorker = new Worker(new URL("./bvhWorker.ts", import.meta.url), { type: "module" });
    treeWorker.onmessage = ({ data }: MessageEvent<TreeResult>) => {
      waiting.get(data.id)?.(data);
      waiting.delete(data.id);
    };
  }
  const request: TreeRequest = { id: nextRequest++, positions: positions.slice(), indices: indices.slice() };
  const result = new Promise<TreeResult>((resolve) => waiting.set(request.id, resolve));
  treeWorker.postMessage(request, [request.positions.buffer, request.indices.buffer]);
  return result;
}

export function edgeAtSegment(ranges: EdgeRange[], segment: number): CadEdge | null {
  if (!Number.isInteger(segment) || segment < 0) return null;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (segment < range.start) high = middle - 1;
    else if (segment >= range.start + range.count) low = middle + 1;
    else return range.edge;
  }
  return null;
}

function segments(positions: Float32Array, pairs: Uint32Array): LineSegmentsGeometry | null {
  if (!pairs.length) return null;
  const result = new Float32Array(pairs.length * 3);
  for (let slot = 0; slot < pairs.length; slot++) result.set(positions.subarray(pairs[slot] * 3, pairs[slot] * 3 + 3), slot * 3);
  return new LineSegmentsGeometry().setPositions(result);
}

function triangleCentres({ positions, indices, degenerateTriangles }: MeshBuffers): BufferGeometry | null {
  if (!degenerateTriangles.length) return null;
  const centres = new Float32Array(degenerateTriangles.length * 3);
  degenerateTriangles.forEach((triangle, slot) => {
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) centres[slot * 3 + axis] += positions[indices[triangle * 3 + corner] * 3 + axis] / 3;
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(centres, 3));
  return geometry;
}

export class GeometryResources {
  private readonly cache = new Map<string, PartResources>();
  private readonly faultCache = new Map<string, FaultResources>();
  private readonly trees = new Set<string>();
  private disposed = false;
  private readonly model: Model;
  // Keyed by the model's parts, which arranging the files of a view leaves untouched.
  constructor(model: Model) { this.model = model; }

  get(part: Part): PartResources {
    if (this.disposed) throw new Error("This document's geometry has been released");
    const existing = this.cache.get(part.id);
    if (existing) return existing;
    if (!this.model.parts.includes(part)) throw new Error("Geometry does not belong to this document");
    const entry = part.mesh ? this.mesh(part.mesh) : this.preview(part);
    this.cache.set(part.id, entry);
    return entry;
  }

  // Mesh views are used in place: no copies, no normals (drawn with flat shading) and outlines that share the positions.
  private mesh(mesh: MeshBuffers): PartResources {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(mesh.positions, 3);
    geometry.setAttribute("position", position);
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    geometry.computeBoundingSphere();
    let edges: BufferGeometry | null = null;
    if (mesh.outlines.length) {
      edges = new BufferGeometry();
      edges.setAttribute("position", position);
      edges.setIndex(new BufferAttribute(mesh.outlines, 1));
    }
    return { geometry, edges, cadEdges: null, edgeRanges: [] };
  }

  private preview(part: Part): PartResources {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(part.positions), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(part.normals ?? []), 3));
    geometry.setIndex(Array.from(part.indices));
    geometry.computeBoundingSphere();
    const positions: number[] = [];
    const edgeRanges: EdgeRange[] = [];
    for (const edge of part.edges ?? []) {
      const lines = edgeSegments(edge);
      edgeRanges.push({ edge, start: positions.length / 6, count: lines.length / 6 });
      for (const coordinate of lines) positions.push(coordinate);
    }
    const cadEdges = positions.length ? new LineSegmentsGeometry().setPositions(positions) : null;
    return { geometry, edges: new EdgesGeometry(geometry, 22), cadEdges, edgeRanges };
  }

  // Asked for once per pickable dense part; the tree is attached when the worker returns it, never built in a raycast.
  requestTree(part: Part): void {
    if (!part.mesh || (part.triangleCount ?? 0) < TREE_TRIANGLES || this.trees.has(part.id) || typeof Worker === "undefined") return;
    this.trees.add(part.id);
    const { geometry } = this.get(part);
    void buildTree(part.mesh.positions, part.mesh.indices).then(({ tree }) => {
      if (this.disposed || !tree) return;
      geometry.boundsTree = MeshBVH.deserialize(tree, geometry, { setIndex: false });
    });
  }

  faults(part: Part): FaultResources | null {
    if (!part.mesh) return null;
    const existing = this.faultCache.get(part.id);
    if (existing) return existing;
    const { positions, openEdges, oversharedEdges, flippedEdges, degenerateTriangles } = part.mesh;
    const entry = {
      open: segments(positions, openEdges), overshared: segments(positions, oversharedEdges), flipped: segments(positions, flippedEdges),
      degenerate: triangleCentres(part.mesh),
      segments: (openEdges.length + oversharedEdges.length + flippedEdges.length) / 2 + degenerateTriangles.length,
    };
    this.faultCache.set(part.id, entry);
    return entry;
  }

  get size(): number { return this.cache.size; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { geometry, edges, cadEdges } of this.cache.values()) {
      geometry.boundsTree = undefined;
      geometry.dispose(); edges?.dispose(); cadEdges?.dispose();
    }
    for (const fault of this.faultCache.values()) {
      fault.open?.dispose(); fault.overshared?.dispose(); fault.flipped?.dispose(); fault.degenerate?.dispose();
    }
    this.cache.clear();
    this.faultCache.clear();
  }
}
