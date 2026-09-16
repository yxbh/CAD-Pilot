import { BufferAttribute, BufferGeometry, EdgesGeometry } from "three";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { edgeSegments, type CadEdge, type Model, type Part } from "./model.ts";

export type EdgeRange = { edge: CadEdge; start: number; count: number };
export type PartResources = { geometry: BufferGeometry; edges: EdgesGeometry; cadEdges: LineSegmentsGeometry | null; edgeRanges: EdgeRange[] };

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

export class GeometryResources {
  private readonly cache = new Map<string, PartResources>();
  private disposed = false;
  private readonly model: Model;
  constructor(model: Model) { this.model = model; }

  get(part: Part): PartResources {
    if (this.disposed) throw new Error("This document's geometry has been released");
    const existing = this.cache.get(part.id);
    if (existing) return existing;
    if (!this.model.parts.includes(part)) throw new Error("Geometry does not belong to this document");
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(part.positions), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(part.normals), 3));
    geometry.setIndex(part.indices);
    geometry.computeBoundingSphere();
    const positions: number[] = [];
    const edgeRanges: EdgeRange[] = [];
    for (const edge of part.edges ?? []) {
      const segments = edgeSegments(edge);
      edgeRanges.push({ edge, start: positions.length / 6, count: segments.length / 6 });
      for (const coordinate of segments) positions.push(coordinate);
    }
    const cadEdges = positions.length ? new LineSegmentsGeometry().setPositions(positions) : null;
    const entry = { geometry, edges: new EdgesGeometry(geometry, 22), cadEdges, edgeRanges };
    this.cache.set(part.id, entry);
    return entry;
  }

  get size(): number { return this.cache.size; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { geometry, edges, cadEdges } of this.cache.values()) { geometry.dispose(); edges.dispose(); cadEdges?.dispose(); }
    this.cache.clear();
  }
}
