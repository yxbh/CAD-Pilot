import { BufferAttribute, BufferGeometry, EdgesGeometry } from "three";
import type { Model, Part } from "./model.ts";

export type PartResources = { geometry: BufferGeometry; edges: EdgesGeometry };

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
    const entry = { geometry, edges: new EdgesGeometry(geometry, 22) };
    this.cache.set(part.id, entry);
    return entry;
  }

  get size(): number { return this.cache.size; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { geometry, edges } of this.cache.values()) { geometry.dispose(); edges.dispose(); }
    this.cache.clear();
  }
}
