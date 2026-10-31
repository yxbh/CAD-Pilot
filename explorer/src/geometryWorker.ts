// Off the main thread, for one part at a time: a mesh part's picking tree, and the data an analysis view needs. It
// receives copies of the part's positions and triangles, so the page's shared geometry buffer is never transferred
// away, and sends back only what it made.
import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { AnalysisField } from "../shared/analysis.mjs";
import { computeField, type FieldResults } from "./analysis/fields.ts";

export type WorkerRequest = { id: number; job: "tree" | AnalysisField; positions: Float32Array; indices: Uint32Array };
// The serialized tree without the index, which the page already has.
export type SerializedTree = ReturnType<typeof MeshBVH.serialize>;
export type WorkerResult = { id: number; tree?: SerializedTree; field?: FieldResults[AnalysisField]; error?: string };

function tree(positions: Float32Array, indices: Uint32Array) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // Indirect trees leave the index alone, so picked triangle numbers stay the file's own.
  const serialized = { ...MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { cloneBuffers: false }), index: null as never };
  return { result: { tree: serialized }, transfer: [...serialized.roots, ...(serialized.indirectBuffer ? [serialized.indirectBuffer.buffer as ArrayBuffer] : [])] };
}

function analysis(job: AnalysisField, positions: Float32Array, indices: Uint32Array) {
  const field = computeField(job, positions, indices);
  return { result: { field }, transfer: Object.values(field).filter(ArrayBuffer.isView).map((array) => (array as Float32Array).buffer as ArrayBuffer) };
}

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const { result, transfer } = data.job === "tree" ? tree(data.positions, data.indices) : analysis(data.job, data.positions, data.indices);
    self.postMessage({ id: data.id, ...result } satisfies WorkerResult, { transfer });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResult);
  }
};
