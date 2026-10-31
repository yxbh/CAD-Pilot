import { multiply } from "./matrix.mjs";
import { diagonal, mergeBounds, transformBounds } from "./placement.mjs";

// Where each file of a view is shown: its style, its own turn and move, and the side-by-side layout. This is view
// state, applied to the composed model by the server and the page alike, so arranging files never changes the
// model's identity or makes the page fetch and rebuild its geometry.
export const MAIN_DOCUMENT = "main";
export const DOCUMENT_STYLES = Object.freeze(["solid", "ghost"]);
export const LAYOUTS = Object.freeze(["overlay", "side"]);

// Turn about X, then Y, then Z (degrees), then move: a column-major placement.
export function placementMatrix(rotate, offset) {
  const [x, y, z] = rotate.map((degrees) => degrees * Math.PI / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  const rows = [
    [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
    [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
    [-sy, sx * cy, cx * cy],
  ];
  const snap = (value) => Math.abs(value) < 1e-12 ? 0 : value;
  return [0, 1, 2].flatMap((col) => [...rows.map((row) => snap(row[col])), 0]).concat([...offset, 1]);
}

const plain = (entry) => entry.style === "solid" && entry.offset.every((value) => value === 0) && entry.rotate.every((value) => value === 0);

// The composed model as the view shows it. Root nodes of each file take that file's placement; a ghost file's nodes
// are marked. Parts are shared with the composed model, and `sourceBounds` keeps its unplaced bounds so the scene
// origin, and with it the camera, stays put when a file moves.
export function arrangeView(model, documents = [], layout = "overlay") {
  if (!documents.length || (documents.every(plain) && (layout !== "side" || documents.length < 2))) return model;
  const own = new Map((model.documents ?? [{ id: documents[0].id, bounds: model.bounds }]).map((document) => [document.id, document.bounds]));
  const matrices = new Map(documents.map((entry) => [entry.id, placementMatrix(entry.rotate, entry.offset)]));
  if (layout === "side") {
    const placed = documents.filter((entry) => own.has(entry.id)).map((entry) => [entry.id, transformBounds(own.get(entry.id), matrices.get(entry.id))]);
    const gap = Math.max(10, 0.1 * Math.max(...placed.map(([, bounds]) => diagonal(bounds))));
    let cursor = placed[0][1].max[0] + gap;
    for (const [id, bounds] of placed.slice(1)) {
      const shift = cursor - bounds.min[0];
      matrices.get(id)[12] += shift;
      cursor = bounds.max[0] + shift + gap;
    }
  }
  const styles = new Map(documents.map((entry) => [entry.id, entry.style]));
  const nodes = model.nodes.map((node) => {
    const id = node.documentId ?? documents[0].id;
    const ghost = styles.get(id) === "ghost";
    if (node.parentId !== null && !ghost) return node;
    return { ...node, ...(node.parentId === null ? { matrix: multiply(matrices.get(id), node.matrix) } : {}), ...(ghost ? { ghost: true } : {}) };
  });
  const bounds = mergeBounds([...own].map(([id, documentBounds]) => transformBounds(documentBounds, matrices.get(id) ?? placementMatrix([0, 0, 0], [0, 0, 0]))));
  return { ...model, nodes, bounds, sourceBounds: model.sourceBounds ?? model.bounds };
}
