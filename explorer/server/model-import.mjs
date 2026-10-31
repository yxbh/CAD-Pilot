import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { importDiagnostics } from "../shared/diagnostics.mjs";
import { MESH_UNITS, MESH_UP_AXES, modelFormat } from "../shared/mesh.mjs";
import { isInside } from "./paths.mjs";
import { PrototypeError, topologyRevision, validateMeasuredCleanup, validateMeshGeometry, validateModel } from "./protocol.mjs";
import { markUsed } from "./runtime-store.mjs";

export const maxStepBytes = 100 * 1024 * 1024;
export const maxMeshBytes = 300 * 1024 * 1024;
const maxJsonBytes = 160 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const maxSourceBytes = (format) => format === "step" ? maxStepBytes : maxMeshBytes;
const sizeLimit = (format) => format === "step" ? "a STEP file smaller than 100 MB" : "a mesh file smaller than 300 MB";

export function sourceFormat(file) {
  const format = modelFormat(file);
  if (!format) throw new PrototypeError("unsupported_file", "Choose a STEP, STL, OBJ, 3MF, PLY or GLB file");
  return format;
}

// Units and up axis say how to read a mesh file; STEP declares its own and ignores them.
export function meshOptions({ units = "auto", up = "auto" } = {}) {
  if (!MESH_UNITS.includes(units)) throw new PrototypeError("bad_units", `Units must be one of ${MESH_UNITS.join(", ")}`);
  if (!MESH_UP_AXES.includes(up)) throw new PrototypeError("bad_up", `Up must be one of ${MESH_UP_AXES.join(", ")}`);
  return { units, up };
}

export async function validateModelPath(target, root) {
  let resolved;
  try { resolved = await realpath(target); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    const shown = isInside(root, target) ? path.relative(root, target) : target;
    // A Windows-style path names one file with backslashes in its name on macOS and Linux.
    const hint = path.sep === "/" && shown.includes("\\") ? " Separate folders with / here." : "";
    throw new PrototypeError("file_not_found", `There is no file ${shown} in the project.${hint}`, 404);
  }
  if (!isInside(root, resolved)) throw new PrototypeError("outside_project", "The file must be inside the selected project root", 403);
  const format = sourceFormat(resolved);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > maxSourceBytes(format)) throw new PrototypeError("too_large", `Choose ${sizeLimit(format)}`, 413);
  return resolved;
}

export const meshGeometryFile = (modelDir, revision) => path.join(modelDir, `${revision}.bin`);

// A STEP preview cached before exact edge selection: still a valid snapshot, but it must be converted again.
export class StaleCacheError extends PrototypeError {
  constructor(sha256) {
    super("stale_cache", "This preview was cached before exact face and edge selection; open its STEP again", 409);
    this.sha256 = sha256;
  }
}

// A published cache: a STEP model's JSON, or a mesh manifest whose geometry file must match it exactly. Verifying a
// cache before publishing over it allows a stale one: it is immutable and still identifies the same snapshot.
export async function readModelCache(modelDir, cacheName, { allowStale = false } = {}) {
  if (typeof cacheName !== "string" || !/^[a-f0-9]{64}\.json$/.test(cacheName)) throw new PrototypeError("invalid_cache_name", "Saved geometry has an invalid cache name", 422);
  const parsed = JSON.parse(await readFile(path.join(modelDir, cacheName), "utf8"));
  if (parsed?.schemaVersion === 1) throw new StaleCacheError(parsed.source?.sha256);
  const model = validateModel(parsed);
  if (`${model.topologyRevision}.json` !== cacheName) throw new PrototypeError("cache_mismatch", "Saved geometry identity does not match its cache filename", 422);
  if (model.kind === "mesh") validateMeshGeometry(model, await readFile(meshGeometryFile(modelDir, model.topologyRevision)));
  else if (!allowStale && model.parts.some((part) => part.edges === undefined)) throw new StaleCacheError(model.source.sha256);
  return model;
}

async function publish(temporary, destination, verify) {
  try { await link(temporary, destination); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    await verify();
  }
}

async function convertStep(source, attempt, python, sourceHash) {
  const output = path.join(attempt, "model.json");
  await python("convert.py", [source, "--output", output]);
  if ((await stat(output)).size > maxJsonBytes) throw new PrototypeError("model_too_large", "Converted mesh exceeds the viewer's size limit", 413);
  const model = validateModel(JSON.parse(await readFile(output, "utf8")), { requireRevision: false });
  Object.assign(model, importDiagnostics(model));
  if (model.source.sha256 !== sourceHash) throw new PrototypeError("revision_mismatch", "Converted model does not match the STEP snapshot", 422);
  return { model, output, geometry: null };
}

async function convertMesh(source, attempt, python, sourceHash, format, options, name) {
  const output = path.join(attempt, "model.json");
  const geometry = path.join(attempt, "geometry.bin");
  await python("mesh.py", [source, "--output-dir", attempt, "--units", options.units, "--up", options.up, `--name=${name}`]);
  const model = validateModel(JSON.parse(await readFile(output, "utf8")), { requireRevision: false });
  if (model.source.sha256 !== sourceHash || model.source.format !== format) {
    throw new PrototypeError("revision_mismatch", "Converted mesh does not match the source snapshot", 422);
  }
  validateMeshGeometry(model, await readFile(geometry));
  return { model, output, geometry };
}

export async function prepareModelSnapshot({ resolved, bytes: suppliedBytes, displayName, uploadDir, modelDir, python, options }, { remove = rm } = {}) {
  const format = sourceFormat(resolved ?? displayName);
  const bytes = suppliedBytes ?? await readFile(resolved);
  if (bytes.length > maxSourceBytes(format)) throw new PrototypeError("too_large", `Choose ${sizeLimit(format)}`, 413);
  const sourceHash = sha256(bytes);
  const extension = format === "step" ? "step" : format;
  const snapshot = path.join(uploadDir, `${sourceHash}.${extension}`);
  const attempt = await mkdtemp(path.join(modelDir, ".import-"));
  const stagedSource = path.join(attempt, `${sourceHash}.${extension}`);
  let failure;
  try {
    await writeFile(stagedSource, bytes, { flag: "wx" });
    const name = displayName || path.basename(resolved);
    const { model, output, geometry } = format === "step"
      ? await convertStep(stagedSource, attempt, python, sourceHash)
      : await convertMesh(stagedSource, attempt, python, sourceHash, format, meshOptions(options), name);
    model.source.name = name;
    model.topologyRevision = topologyRevision(model);
    const measuredCleanup = model.cleanup ? validateMeasuredCleanup({ topologyRevision: model.topologyRevision, counts: model.cleanup }) : undefined;
    const modelCache = `${model.topologyRevision}.json`;
    // An identical snapshot already in the store is reused. Refreshing its time before checking it means a prune in
    // another process, which keeps whatever was touched after it listed the store, leaves it in place.
    await markUsed(snapshot, path.join(modelDir, modelCache), meshGeometryFile(modelDir, model.topologyRevision));
    const verifyCache = async () => {
      const cached = await readModelCache(modelDir, modelCache, { allowStale: true });
      if (cached.topologyRevision !== model.topologyRevision) throw new PrototypeError("cache_mismatch", "Cached geometry identity does not match", 422);
    };
    try { await verifyCache(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const verifySource = async () => {
      if ((await stat(snapshot)).size > maxSourceBytes(format) || !bytes.equals(await readFile(snapshot))) {
        throw new PrototypeError("snapshot_mismatch", "Cached source bytes do not match the source identity", 422);
      }
    };
    try { await verifySource(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(output, JSON.stringify(model));
    // Hard links publish complete immutable files without replacing a concurrent winner. A mesh's geometry
    // is published before its manifest, so a manifest is never visible without the file it describes.
    await publish(stagedSource, snapshot, verifySource);
    if (geometry) {
      const destination = meshGeometryFile(modelDir, model.topologyRevision);
      await publish(geometry, destination, async () => {
        if (sha256(await readFile(destination)) !== model.geometry.sha256) throw new PrototypeError("cache_mismatch", "Cached mesh geometry does not match", 422);
      });
    }
    await publish(output, path.join(modelDir, modelCache), verifyCache);
    return { model, modelCache, inputFile: snapshot, inputName: model.source.name, measuredCleanup };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await remove(attempt, { recursive: true, force: true }); }
    catch (cleanup) {
      const message = (error) => error instanceof Error ? error.message : String(error);
      const error = new PrototypeError(
        failure?.code ?? "import_cleanup_failed",
        `${failure ? `${message(failure)}; ` : ""}Temporary import cleanup failed: ${message(cleanup)}`,
        failure instanceof PrototypeError ? failure.status : 500,
      );
      error.cause = failure ? new AggregateError([failure, cleanup], error.message) : cleanup;
      throw error;
    }
  }
}
