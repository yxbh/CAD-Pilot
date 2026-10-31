// Builds a mesh part's picking tree off the main thread. It receives copies of the part's positions and triangles,
// so the page's shared geometry buffer is never transferred away, and sends back only the serialized tree.
import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH } from "three-mesh-bvh";

export type TreeRequest = { id: number; positions: Float32Array; indices: Uint32Array };
// The serialized tree without the index, which the page already has.
export type TreeResult = { id: number; tree?: ReturnType<typeof MeshBVH.serialize>; error?: string };

self.onmessage = ({ data }: MessageEvent<TreeRequest>) => {
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
    geometry.setIndex(new BufferAttribute(data.indices, 1));
    // Indirect trees leave the index alone, so picked triangle numbers stay the file's own.
    const tree = { ...MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { cloneBuffers: false }), index: null as never };
    const transfer = [...tree.roots, ...(tree.indirectBuffer ? [tree.indirectBuffer.buffer as ArrayBuffer] : [])];
    self.postMessage({ id: data.id, tree } satisfies TreeResult, { transfer });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) } satisfies TreeResult);
  }
};
