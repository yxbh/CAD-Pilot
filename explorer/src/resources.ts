import { BufferAttribute, BufferGeometry, Color, EdgesGeometry, Float32BufferAttribute } from "three";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { MeshBVH } from "three-mesh-bvh";
import { edgeSegments, type CadEdge, type MeshBuffers, type Model, type Part } from "./model.ts";
import type { WorkerRequest, WorkerResult } from "./geometryWorker.ts";
import { computeField, type FieldResults } from "./analysis/fields.ts";
import { ANALYSIS_COLORS, type AnalysisField } from "../shared/analysis.mjs";

export type EdgeRange = { edge: CadEdge; start: number; count: number };
export type PartResources = { geometry: BufferGeometry; edges: BufferGeometry | null; cadEdges: LineSegmentsGeometry | null; edgeRanges: EdgeRange[] };
export type FaultResources = {
  open: LineSegmentsGeometry | null; overshared: LineSegmentsGeometry | null; flipped: LineSegmentsGeometry | null;
  degenerate: BufferGeometry | null; segments: number;
};
// Brute-force picking is fine for CAD previews; dense meshes get a bounding-volume tree so hovering stays quick.
const TREE_TRIANGLES = 20_000;

// Drawable analysis data for one part: edges and normals as lines, thickness and curvature as values per vertex.
export type AnalysisResources = {
  edges?: BufferGeometry; normals?: LineSegmentsGeometry;
  thickness?: FieldResults["thickness"]; curvature?: FieldResults["curvature"];
};

// One worker builds every picking tree and analysis field, one part at a time; until a part's tree arrives it is
// picked brute force.
let worker: Worker | null = null;
let nextRequest = 0;
const waiting = new Map<number, (result: WorkerResult) => void>();
const copy = <T extends Float32Array | Uint32Array>(values: ArrayLike<number>, type: { from(values: ArrayLike<number>): T }): T =>
  values instanceof Float32Array || values instanceof Uint32Array ? values.slice() as T : type.from(values);
function inWorker(job: WorkerRequest["job"], part: Part): Promise<WorkerResult> {
  const positions = copy(part.mesh?.positions ?? part.positions, Float32Array);
  const indices = copy(part.mesh?.indices ?? part.indices, Uint32Array);
  // Where workers are unavailable (Node's tests), analysis runs in place.
  if (typeof Worker === "undefined") {
    if (job === "tree") return Promise.resolve({ id: -1 });
    try { return Promise.resolve({ id: -1, field: computeField(job, positions, indices) }); }
    catch (error) { return Promise.resolve({ id: -1, error: error instanceof Error ? error.message : String(error) }); }
  }
  if (!worker) {
    worker = new Worker(new URL("./geometryWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
      waiting.get(data.id)?.(data);
      waiting.delete(data.id);
    };
    // A worker that fails to start or crashes answers everything it was asked with its error.
    worker.onerror = (event) => {
      for (const resolve of waiting.values()) resolve({ id: -1, error: event.message || "The geometry worker failed" });
      waiting.clear();
      worker = null;
    };
  }
  const request: WorkerRequest = { id: nextRequest++, job, positions, indices };
  const result = new Promise<WorkerResult>((resolve) => waiting.set(request.id, resolve));
  worker.postMessage(request, [request.positions.buffer, request.indices.buffer]);
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
  private readonly analysisCache = new Map<string, AnalysisResources>();
  private readonly analysisRequests = new Map<string, Promise<void>>();
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
    void inWorker("tree", part).then(({ tree }) => {
      if (this.disposed || !tree) return;
      geometry.boundsTree = MeshBVH.deserialize(tree, geometry, { setIndex: false });
    });
  }

  /** A part's analysis data computed so far; a field that failed is absent but counts as done. */
  analysis(part: Part): AnalysisResources {
    return this.analysisCache.get(part.id) ?? {};
  }

  analysisDone(part: Part, field: AnalysisField): boolean {
    return field in this.analysis(part);
  }

  /** Computes a field in the worker once per part; resolves when it is in place, or rejects with the worker's error. */
  requestAnalysis(part: Part, field: AnalysisField): Promise<void> {
    const key = `${part.id}:${field}`;
    const pending = this.analysisRequests.get(key);
    if (pending) return pending;
    const { geometry } = this.get(part);
    const request = inWorker(field, part).then(({ field: result, error }) => {
      if (this.disposed) return;
      const entry = { ...this.analysisCache.get(part.id) };
      this.analysisCache.set(part.id, entry);
      if (!result) {
        entry[field] = undefined;
        throw new Error(`Could not compute ${field} for ${part.label}: ${error ?? "no result"}`);
      }
      if (field === "edges") {
        // Each edge once, over the surface's own positions.
        const lines = new BufferGeometry();
        lines.setAttribute("position", geometry.getAttribute("position"));
        lines.setIndex(new BufferAttribute((result as FieldResults["edges"]).pairs, 1));
        entry.edges = lines;
      } else if (field === "normals") {
        // Each arrow shades from its base on the surface to its tip.
        const { segments } = result as FieldResults["normals"];
        const colors = new Float32Array(segments.length);
        const [base, tip] = [new Color(ANALYSIS_COLORS.normalBase), new Color(ANALYSIS_COLORS.normalTip)];
        for (let start = 0; start < colors.length; start += 6) { base.toArray(colors, start); tip.toArray(colors, start + 3); }
        entry.normals = new LineSegmentsGeometry().setPositions(segments).setColors(colors);
      } else if (field === "thickness") entry.thickness = result as FieldResults["thickness"];
      else entry.curvature = result as FieldResults["curvature"];
    });
    this.analysisRequests.set(key, request);
    return request;
  }

  /** Puts per-vertex values on a part's surface for a colour map to read, in one buffer reused across maps. */
  showValues(part: Part, values: Float32Array): void {
    const { geometry } = this.get(part);
    if (geometry.userData.analysisValues === values) return;
    geometry.userData.analysisValues = values;
    const current = geometry.getAttribute("analysisValue") as BufferAttribute | undefined;
    if (current) {
      (current.array as Float32Array).set(values);
      current.needsUpdate = true;
    } else geometry.setAttribute("analysisValue", new BufferAttribute(values.slice(), 1));
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
    for (const { edges, normals } of this.analysisCache.values()) { edges?.dispose(); normals?.dispose(); }
    this.cache.clear();
    this.faultCache.clear();
    this.analysisCache.clear();
  }
}
