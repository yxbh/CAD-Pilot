import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createReference, describeSelection, parseReference, referenceEntity } from "../shared/references.mjs";
import { multiply } from "../shared/matrix.mjs";
import { nativeFileReference, nativeReferenceTitle } from "../shared/native-reference.mjs";
import { pointOnTriangle, pointTolerance } from "../shared/mesh.mjs";
import { meshGeometryFile } from "./model-import.mjs";
import { PrototypeError, validateModel } from "./protocol.mjs";
import { atomicJson } from "./storage.mjs";
import { workbenchRoot as checkout } from "./paths.mjs";
import { createVerifiedFileCache, FileChangedError } from "./verified-file-cache.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const REFERENCE_FORMATS = Object.freeze(["copilot-ref", "text"]);
const message = (error) => error instanceof Error ? error.message : String(error);

const modelLimit = 160 * 1024 * 1024;
const sourceLimits = { step: 100 * 1024 * 1024, mesh: 300 * 1024 * 1024 };
const geometryLimit = 1024 * 1024 * 1024;
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
const meshFacts = (cached, part) => ({
  format: cached.format, frame: cached.frame, vertexCount: part.vertexCount, triangleCount: part.triangleCount,
  closed: part.closed, faults: part.faults, area: part.area, volume: part.volume,
  note: "A mesh reference: triangles as read from the file, not CAD faces. Measure it with explorer/python/measure.py using the same units and up options.",
});

// Services and hosts sharing a runtime share one bounded inspection cache.
const shared = new Map();
export function inspectionFor(runtimeRoot, workbenchRoot = checkout) {
  if (!shared.has(runtimeRoot)) shared.set(runtimeRoot, createInspectionService({ runtimeRoot, workbenchRoot }));
  return shared.get(runtimeRoot);
}

// The Copilot canvas and the design-project viewer keep separate stores, and a reference can be pasted into either
// host: look in each store in turn, the host's own first.
export function inspectAcross(roots) {
  const services = [...new Set(roots)].map((root) => inspectionFor(root));
  return async (reference) => {
    let missing;
    for (const service of services) {
      try { return await service.inspectReference(reference); }
      catch (error) {
        if (error?.code !== "reference_unavailable") throw error;
        missing ??= error;
      }
    }
    throw missing;
  };
}

export function createInspectionService({ runtimeRoot, workbenchRoot, cacheLimits = {}, io }) {
  const counts = { modelReads: 0, jsonParses: 0, modelValidations: 0, sourceHashes: 0, sourceBytesRead: 0 };
  const models = createVerifiedFileCache({
    maxEntries: cacheLimits.modelMaxEntries ?? 4,
    maxBytes: cacheLimits.modelMaxBytes ?? 64 * 1024 * 1024,
    io,
    check: (info) => {
      if (info.size > modelLimit) throw new PrototypeError("model_too_large", "Cached reference exceeds the Explorer limit", 413);
    },
    load: async (handle) => {
      counts.modelReads++;
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > modelLimit) throw new PrototypeError("model_too_large", "Cached reference exceeds the Explorer limit", 413);
      counts.jsonParses++;
      const parsed = JSON.parse(text);
      counts.modelValidations++;
      const model = validateModel(parsed);
      // Retain only private inspection facts after full mesh validation and topology hashing. The large render arrays are never cached here.
      const value = {
        topologyRevision: model.topologyRevision,
        source: { name: shortLabel(model.source.name), sha256: model.source.sha256 },
        kind: model.kind ?? "step", format: model.source.format ?? "step", frame: model.frame, geometry: model.geometry,
        parts: model.parts.map(({ id, bounds, faces, edges, buffers, vertexCount, triangleCount, closed, faults, area, volume }) => ({
          id, bounds, faces,
          edges: edges?.map(({ id, curveType, length, center, bounds }) => ({ id, curveType, length, center, bounds })),
          ...(buffers ? { buffers, vertexCount, triangleCount, closed, faults, area, volume } : {}),
        })),
        nodes: model.nodes.map(({ id, label, parentId, partId, matrix }) => ({ id, label: shortLabel(label), parentId, partId, matrix })),
      };
      return { value, bytes: Math.max(4096, Buffer.byteLength(JSON.stringify(value)) * 8) };
    },
  });
  // Streamed digests of a file, retained by file identity: source snapshots, and mesh geometry before a point is read from it.
  const digests = (limit, maxEntries) => createVerifiedFileCache({
    maxEntries, maxBytes: cacheLimits.sourceMaxBytes ?? 256 * 1024, io,
    check: (info) => { if (info.size > limit) throw new FileChangedError(); },
    load: async (handle) => {
      counts.sourceHashes++;
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        counts.sourceBytesRead += chunk.length;
        if (bytes > limit) throw new FileChangedError();
        digest.update(chunk);
      }
      return { value: digest.digest("hex"), bytes: 4096 };
    },
  });
  const sources = Object.fromEntries(Object.entries(sourceLimits).map(([kind, limit]) => [kind, digests(limit, cacheLimits.sourceMaxEntries ?? 64)]));
  const geometries = digests(geometryLimit, cacheLimits.sourceMaxEntries ?? 64);

  // The picked triangle's corners, read straight from the mesh's verified geometry file.
  async function meshTriangle(cached, part, triangle) {
    const file = meshGeometryFile(path.join(runtimeRoot, "models"), cached.topologyRevision);
    let record;
    try { record = await geometries.get(cached.topologyRevision, file); }
    catch (error) { throw modelError(error); }
    if (record.value !== cached.geometry.sha256) throw new PrototypeError("stale_reference", "Cached mesh geometry does not match this reference. Reopen the file and pick the point again.", 409);
    const handle = await open(file, "r");
    try {
      const read = async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) throw new PrototypeError("stale_reference", "Cached mesh geometry is truncated", 409);
        return buffer;
      };
      const indices = await read(part.buffers.indices.offset + triangle * 12, 12);
      const corners = [];
      for (let slot = 0; slot < 3; slot++) {
        const vertex = indices.readUInt32LE(slot * 4);
        if (vertex >= part.vertexCount) throw new PrototypeError("stale_reference", "Cached mesh geometry is inconsistent", 409);
        const position = await read(part.buffers.positions.offset + vertex * 12, 12);
        corners.push([0, 1, 2].map((axis) => position.readFloatLE(axis * 4)));
      }
      await geometries.verify(record).catch((error) => { throw modelError(error); });
      return corners;
    } finally { await handle.close(); }
  }

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
    try { entity = referenceEntity(cached, reference.nodeId, reference.faceId, reference.edgeId, reference.point); }
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
    let point = null;
    if (entity.point) {
      const { triangle, point: local } = entity.point;
      point = { triangle, local, world: transformPoint(local) };
      if (entity.part.buffers) {
        const corners = await meshTriangle(cached, entity.part, triangle);
        const distance = pointOnTriangle(corners, local, entity.part.bounds);
        if (distance === null) throw new PrototypeError("invalid_reference", "The reference point is not on its triangle in this mesh");
        const [a, b, c] = corners;
        const cross = [0, 1, 2].map((axis) => {
          const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
          return (b[u] - a[u]) * (c[v] - a[v]) - (b[v] - a[v]) * (c[u] - a[u]);
        });
        const length = Math.hypot(...cross);
        point.normal = length ? cross.map((value) => value / length) : null;
        point.distanceToTriangle = distance;
      } else {
        // STEP previews keep no triangle corners in their inspection facts: report the CAD face the triangle belongs to.
        const face = entity.part.faces.find((item) => triangle >= item.triangleStart && triangle < item.triangleStart + item.triangleCount);
        const tolerance = pointTolerance(entity.part.bounds);
        if (!face || local.some((value, axis) => value < face.bounds.min[axis] - tolerance || value > face.bounds.max[axis] + tolerance)) {
          throw new PrototypeError("invalid_reference", "The reference point is not on its CAD face");
        }
        point.face = face.id;
      }
    }
    const extension = cached.format === "step" ? "step" : cached.format;
    const sourceCache = sources[cached.kind === "mesh" ? "mesh" : "step"];
    let snapshotPath = path.join(runtimeRoot, "inputs", `${cached.source.sha256}.${extension}`);
    let snapshotStatus = "available";
    let sourceRecord;
    try {
      sourceRecord = await sourceCache.get(cached.source.sha256, snapshotPath);
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
      sourceRecord ? sourceCache.verify(sourceRecord).catch((error) => {
        snapshotPath = null;
        snapshotStatus = sourceStatus(error);
      }) : null,
    ]);
    return {
      reference: createReference(cached, reference.nodeId, reference.faceId, reference.edgeId, reference.point),
      source: { name: shortLabel(cached.source.name), sha256: cached.source.sha256 },
      topologyRevision: cached.topologyRevision,
      workbenchRelativeSnapshot: snapshotPath ? path.relative(workbenchRoot, snapshotPath) : null,
      snapshotStatus,
      occurrence: { id: entity.node.id, label: shortLabel(entity.node.label), partId: entity.part.id },
      face: structuredClone(entity.face),
      edge: structuredClone(entity.edge),
      worldEdge,
      point,
      ...(cached.kind === "mesh" ? { mesh: meshFacts(cached, entity.part) } : {}),
      partBounds: structuredClone(entity.part.bounds),
      originalWorldMatrix,
      coordinateFrame: "Face, edge and point facts are part-local millimeters; originalWorldMatrix is the column-major assembled placement, without exploded offsets or a view's placement of the file. worldEdge has the assembled center and a conservative transformed local bounding box, not a remeasured world curve bound. A point's world value uses the same placement. Meshes use the frame they were read with (mesh.frame). Display names are capped at 240 characters.",
      note: "This is the exact cached snapshot, not a claim that a current source file or Python generator is unchanged.",
    };
  }

  // "copilot-ref" is the Copilot desktop's native file-reference chip; "text" is readable in any chat host.
  async function prepareClipboardReference(reference, format = "copilot-ref") {
    if (!REFERENCE_FORMATS.includes(format)) throw new PrototypeError("bad_reference_format", `Unknown reference format: ${format}`);
    const entity = await inspectReference(reference);
    const directory = path.join(runtimeRoot, "references");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${hash(entity.reference)}.json`);
    const title = nativeReferenceTitle(entity.occurrence.label, entity.face?.id ?? null, entity.edge?.id ?? null, entity.point?.triangle ?? null);
    await atomicJson(filePath, {
      schemaVersion: 1, kind: "cad-prototype-selection", inspectionTool: "cad_explorer_inspect", ...entity,
    });
    const text = format === "text"
      ? describeSelection(entity.source.name, entity.occurrence.label, entity.face, entity.edge, entity.reference, entity.point && { triangle: entity.point.triangle, point: entity.point.local })
      : nativeFileReference(filePath, title);
    return { text, title, filePath, reference: entity.reference };
  }
  return {
    inspectReference,
    prepareClipboardReference,
    cacheStats: () => ({ ...counts, models: models.stats(), sources: sources.step.stats(), meshSources: sources.mesh.stats(), geometries: geometries.stats() }),
  };
}
