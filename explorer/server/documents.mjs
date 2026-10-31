import { createHash } from "node:crypto";
import { DOCUMENT_STYLES, MAIN_DOCUMENT, placementMatrix } from "../shared/arrangement.mjs";
import { copyMeshPart } from "../shared/mesh.mjs";
import { mergeBounds } from "../shared/placement.mjs";
import { PrototypeError } from "./protocol.mjs";

export { LAYOUTS, MAIN_DOCUMENT } from "../shared/arrangement.mjs";

// A view shows one main file and, optionally, other files beside or over it: a scan, the original model or
// an earlier revision. Each file keeps its own frame and its own references; the view only places them.
export const MAX_DOCUMENTS = 8;
const zero = Object.freeze([0, 0, 0]);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The public description of a loaded file, kept in view state.
export function documentEntry(id, loaded, { style = "solid", offset = zero, rotate = zero } = {}) {
  const { model } = loaded;
  return {
    id, name: loaded.inputName, kind: model.kind === "mesh" ? "mesh" : "step", format: model.source.format ?? "step",
    topologyRevision: model.topologyRevision,
    frame: model.frame ? { units: model.frame.units, up: model.frame.up, note: model.frame.note } : null,
    style, offset: [...offset], rotate: [...rotate],
  };
}

export function nextDocumentId(entries) {
  const used = new Set(entries.map((entry) => entry.id));
  for (let number = 1; ; number++) if (!used.has(`ref${number}`)) return `ref${number}`;
}

export function updateDocumentEntry(entry, input) {
  const vector = (value, name, limit) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= limit)) {
      throw new PrototypeError("bad_placement", `${name} must be three numbers no larger than ${limit}`);
    }
    return [...value];
  };
  if (input.style !== undefined && !DOCUMENT_STYLES.includes(input.style)) throw new PrototypeError("bad_style", "Style must be solid or ghost");
  return {
    ...entry,
    style: input.style ?? entry.style,
    offset: vector(input.offset, "offset (mm)", 1e6) ?? entry.offset,
    rotate: vector(input.rotate, "rotate (degrees about X, Y and Z)", 3600) ?? entry.rotate,
  };
}

// One model for the page: the main file as converted when it is shown alone, otherwise every file under its own
// top-level node. Added files' ids are prefixed with their document id; the main file's are not, so its references
// and sequence keep working. Nodes remember their file so references name that file's own topology revision, never
// this composite one. Placement is not part of it: arrangeView applies that from view state.
export function composeView(loaded, entries) {
  if (loaded.length !== entries.length || !loaded.length) throw new Error("Every view document needs a loaded model");
  if (loaded.length === 1) return loaded[0].model;
  const parts = [];
  const nodes = [];
  const warnings = [];
  const cleanup = { degenerateEdges: 0, zeroAreaTriangles: 0 };
  const identity = placementMatrix([0, 0, 0], [0, 0, 0]);
  loaded.forEach(({ model }, index) => {
    const entry = entries[index];
    const prefix = entry.id === MAIN_DOCUMENT ? "" : `${entry.id}/`;
    const root = `doc:${entry.id}`;
    nodes.push({ id: root, label: entry.name, parentId: null, partId: null, matrix: identity, color: [0.65, 0.69, 0.75], documentId: entry.id });
    for (const part of model.parts) parts.push(copyMeshPart(part, { id: prefix + part.id, documentId: entry.id }));
    for (const node of model.nodes) {
      nodes.push({
        ...node, id: prefix + node.id, parentId: node.parentId === null ? root : prefix + node.parentId,
        partId: node.partId === null ? null : prefix + node.partId, documentId: entry.id, sourceId: node.id,
      });
    }
    warnings.push(...model.warnings.map((warning) => `${entry.name}: ${warning}`));
    for (const key of Object.keys(cleanup)) {
      const value = model.cleanup?.[key] ?? 0;
      cleanup[key] = value === null || cleanup[key] === null ? null : cleanup[key] + value;
    }
  });
  const identityKey = { view: "documents-v2", documents: entries.map(({ id }, index) => ({ id, topologyRevision: loaded[index].model.topologyRevision })) };
  return {
    schemaVersion: 2, kind: "view",
    topologyRevision: hash(identityKey),
    source: { name: entries.map((entry) => entry.name).join(" + "), sha256: hash({ sources: loaded.map(({ model }) => model.source.sha256), identityKey }) },
    units: "mm",
    documents: entries.map(({ id, name, kind }, index) => {
      const { model } = loaded[index];
      return { id, name, kind, sha256: model.source.sha256, topologyRevision: model.topologyRevision, bounds: model.bounds };
    }),
    parts, nodes,
    bounds: mergeBounds(loaded.map(({ model }) => model.bounds)),
    warnings, cleanup,
  };
}
