import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createReference, parseReference, referenceEntity } from "../shared/references.mjs";
import { multiply } from "../shared/matrix.mjs";
import { nativeFileReference, nativeReferenceTitle } from "../shared/native-reference.mjs";
import { PrototypeError, validateModel } from "./protocol.mjs";
import { atomicJson } from "./storage.mjs";
import { createVerifiedFileCache, FileChangedError } from "./verified-file-cache.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const message = (error) => error instanceof Error ? error.message : String(error);

const modelLimit = 160 * 1024 * 1024;
const sourceLimit = 100 * 1024 * 1024;
const shortLabel = (value) => {
  const text = String(value);
  // Copy a truncated label so a V8 substring cannot keep the original, potentially huge label alive.
  return text.length > 240 ? `${Buffer.from(text.slice(0, 237), "utf16le").toString("utf16le")}...` : text;
};

/**
 * Private, fully validated inspection facts: 4 entries / 64 MiB accounted retention by default; source digests: 64 entries / 256 KiB.
 * Accounting charges eight times serialized fact bytes (minimum 4 KiB/entry); it excludes transient cold JSON parsing and hashing work, not subject to this retention bound.
 * Mesh arrays and STEP bytes are not retained. The 160 MiB JSON / 100 MiB STEP input limits still apply, and oversized fact entries inspect without being retained.
 * cacheLimits can lower/disable either LRU; cacheStats exposes deterministic local counters. These bounds and synthetic timings do not certify large assemblies or total process memory.
 */
export function createInspectionService({ runtimeRoot, workbenchRoot, cacheLimits = {}, io }) {
  const counts = { modelReads: 0, jsonParses: 0, modelValidations: 0, sourceHashes: 0, sourceBytesRead: 0 };
  const models = createVerifiedFileCache({
    maxEntries: cacheLimits.modelMaxEntries ?? 4,
    maxBytes: cacheLimits.modelMaxBytes ?? 64 * 1024 * 1024,
    io,
    check: (info) => {
      if (info.size > modelLimit) throw new PrototypeError("model_too_large", "Cached reference exceeds the prototype limit", 413);
    },
    load: async (handle) => {
      counts.modelReads++;
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > modelLimit) throw new PrototypeError("model_too_large", "Cached reference exceeds the prototype limit", 413);
      counts.jsonParses++;
      const parsed = JSON.parse(text);
      counts.modelValidations++;
      const model = validateModel(parsed);
      // Retain only private inspection facts after full mesh validation and topology hashing. The large render arrays are never cached here.
      const value = {
        topologyRevision: model.topologyRevision,
        source: { name: shortLabel(model.source.name), sha256: model.source.sha256 },
        parts: model.parts.map(({ id, bounds, faces, edges }) => ({
          id, bounds, faces,
          edges: edges?.map(({ id, curveType, length, center, bounds }) => ({ id, curveType, length, center, bounds })),
        })),
        nodes: model.nodes.map(({ id, label, parentId, partId, matrix }) => ({ id, label: shortLabel(label), parentId, partId, matrix })),
      };
      return { value, bytes: Math.max(4096, Buffer.byteLength(JSON.stringify(value)) * 8) };
    },
  });
  const sources = createVerifiedFileCache({
    maxEntries: cacheLimits.sourceMaxEntries ?? 64,
    maxBytes: cacheLimits.sourceMaxBytes ?? 256 * 1024,
    io,
    check: (info) => { if (info.size > sourceLimit) throw new FileChangedError(); },
    load: async (handle) => {
      counts.sourceHashes++;
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        counts.sourceBytesRead += chunk.length;
        if (bytes > sourceLimit) throw new FileChangedError();
        digest.update(chunk);
      }
      return { value: digest.digest("hex"), bytes: 4096 };
    },
  });

  function modelError(error) {
    if (error?.code === "ENOENT") return new PrototypeError("reference_unavailable", "This exact snapshot is no longer cached. Reopen the STEP and select the geometry again.", 404);
    if (error instanceof FileChangedError) return new PrototypeError("stale_reference", "Cached topology changed during inspection. Reopen the STEP and select the geometry again.", 409);
    return error;
  }

  function sourceStatus(error) {
    if (error?.code === "ENOENT") return "missing";
    if (error instanceof FileChangedError) return "changed";
    throw error;
  }

  async function inspectReference(text) {
    let reference;
    try { reference = parseReference(text); }
    catch (error) { throw new PrototypeError("invalid_reference", message(error)); }
    const file = path.join(runtimeRoot, "models", `${reference.topologyRevision}.json`);
    let modelRecord;
    try {
      modelRecord = await models.get(reference.topologyRevision, file);
    } catch (error) { throw modelError(error); }
    const cached = modelRecord.value;
    if (cached.topologyRevision !== reference.topologyRevision) throw new PrototypeError("stale_reference", "Cached topology identity does not match this reference", 409);
    let entity;
    try { entity = referenceEntity(cached, reference.nodeId, reference.faceId, reference.edgeId); }
    catch (error) { throw new PrototypeError("invalid_reference", message(error)); }
    const ancestors = [];
    for (let node = entity.node; node; node = cached.nodes.find((item) => item.id === node.parentId)) {
      if (ancestors.length >= 65) throw new PrototypeError("reference_too_complex", "Reference exceeds the supported assembly depth", 413);
      ancestors.unshift(node.matrix);
    }
    const originalWorldMatrix = ancestors.reduce(multiply, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const transformPoint = (point) => [0, 1, 2].map((axis) => originalWorldMatrix[12 + axis] +
      point.reduce((sum, value, index) => sum + value * originalWorldMatrix[index * 4 + axis], 0));
    let worldEdge = null;
    if (entity.edge) {
      const { min, max } = entity.edge.bounds;
      const corners = [min[0], max[0]].flatMap((x) => [min[1], max[1]].flatMap((y) =>
        [min[2], max[2]].map((z) => transformPoint([x, y, z]))));
      worldEdge = {
        center: transformPoint(entity.edge.center),
        bounds: {
          min: [0, 1, 2].map((axis) => Math.min(...corners.map((point) => point[axis]))),
          max: [0, 1, 2].map((axis) => Math.max(...corners.map((point) => point[axis]))),
        },
      };
    }
    let snapshotPath = path.join(runtimeRoot, "inputs", `${cached.source.sha256}.step`);
    let snapshotStatus = "available";
    let sourceRecord;
    try {
      sourceRecord = await sources.get(cached.source.sha256, snapshotPath);
      if (sourceRecord.value !== cached.source.sha256) {
        snapshotPath = null;
        snapshotStatus = "changed";
      }
    } catch (error) {
      snapshotPath = null;
      snapshotStatus = sourceStatus(error);
    }
    // The model can change while a cold source hash is running; never return old facts as a successful inspection.
    await Promise.all([
      models.verify(modelRecord).catch((error) => { throw modelError(error); }),
      sourceRecord ? sources.verify(sourceRecord).catch((error) => {
        snapshotPath = null;
        snapshotStatus = sourceStatus(error);
      }) : null,
    ]);
    return {
      reference: createReference(cached, reference.nodeId, reference.faceId, reference.edgeId),
      source: { name: shortLabel(cached.source.name), sha256: cached.source.sha256 },
      topologyRevision: cached.topologyRevision,
      workbenchRelativeSnapshot: snapshotPath ? path.relative(workbenchRoot, snapshotPath) : null,
      snapshotStatus,
      occurrence: { id: entity.node.id, label: shortLabel(entity.node.label), partId: entity.part.id },
      face: structuredClone(entity.face),
      edge: structuredClone(entity.edge),
      worldEdge,
      partBounds: structuredClone(entity.part.bounds),
      originalWorldMatrix,
      coordinateFrame: "Face and edge facts are part-local millimeters; originalWorldMatrix is the column-major assembled placement, without exploded offsets. worldEdge has the assembled center and a conservative transformed local bounding box, not a remeasured world curve bound. Display names are capped at 240 characters.",
      note: "This is the exact cached snapshot, not a claim that a current source file or Python generator is unchanged.",
    };
  }

  async function prepareClipboardReference(reference) {
    const entity = await inspectReference(reference);
    const directory = path.join(runtimeRoot, "references");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${hash(entity.reference)}.json`);
    const title = nativeReferenceTitle(entity.occurrence.label, entity.face?.id ?? null, entity.edge?.id ?? null);
    await atomicJson(filePath, {
      schemaVersion: 1, kind: "cad-prototype-selection", inspectionTool: "cad_explorer_prototype_inspect", ...entity,
    });
    return { text: nativeFileReference(filePath, title), title, filePath, reference: entity.reference };
  }
  return {
    inspectReference,
    prepareClipboardReference,
    cacheStats: () => ({ ...counts, models: models.stats(), sources: sources.stats() }),
  };
}
