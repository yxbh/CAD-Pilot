import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { importDiagnostics } from "../shared/diagnostics.mjs";
import { isInside } from "./paths.mjs";
import { PrototypeError, topologyRevision, validateMeasuredCleanup, validateModel } from "./protocol.mjs";

export const maxStepBytes = 100 * 1024 * 1024;
const maxJsonBytes = 160 * 1024 * 1024;

export async function validateStepPath(target, root) {
  const resolved = await realpath(target);
  if (!isInside(root, resolved)) throw new PrototypeError("outside_project", "STEP must be inside the selected project root", 403);
  if (![".step", ".stp"].includes(path.extname(resolved).toLowerCase())) throw new PrototypeError("not_step", "Choose a .step or .stp file");
  const info = await stat(resolved);
  if (!info.isFile() || info.size > maxStepBytes) throw new PrototypeError("too_large", "Choose a STEP file smaller than 100 MB", 413);
  return resolved;
}

async function publish(temporary, destination, verify) {
  try { await link(temporary, destination); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    await verify();
  }
}

export async function prepareModelSnapshot({ resolved, bytes: suppliedBytes, displayName, uploadDir, modelDir, python }, { remove = rm } = {}) {
  const bytes = suppliedBytes ?? await readFile(resolved);
  if (bytes.length > maxStepBytes) throw new PrototypeError("too_large", "STEP file exceeds 100 MB", 413);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const snapshot = path.join(uploadDir, `${sourceHash}.step`);
  const attempt = await mkdtemp(path.join(modelDir, ".import-"));
  const stagedSource = path.join(attempt, `${sourceHash}.step`);
  const output = path.join(attempt, "model.json");
  let failure;
  try {
    await writeFile(stagedSource, bytes, { flag: "wx" });
    await python("convert.py", [stagedSource, "--output", output]);
    if ((await stat(output)).size > maxJsonBytes) throw new PrototypeError("model_too_large", "Converted mesh exceeds the viewer's size limit", 413);
    const model = validateModel(JSON.parse(await readFile(output, "utf8")), { requireRevision: false });
    Object.assign(model, importDiagnostics(model));
    if (model.source.sha256 !== sourceHash) throw new PrototypeError("revision_mismatch", "Converted model does not match the STEP snapshot", 422);
    model.source.name = displayName || path.basename(resolved);
    model.topologyRevision = topologyRevision(model);
    const measuredCleanup = validateMeasuredCleanup({ topologyRevision: model.topologyRevision, counts: model.cleanup });
    const modelCache = `${model.topologyRevision}.json`;
    const verifyCache = async () => {
      const cached = validateModel(JSON.parse(await readFile(path.join(modelDir, modelCache), "utf8")));
      if (cached.topologyRevision !== model.topologyRevision) throw new PrototypeError("cache_mismatch", "Cached geometry identity does not match", 422);
    };
    try { await verifyCache(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const verifySource = async () => {
      if ((await stat(snapshot)).size > maxStepBytes || !bytes.equals(await readFile(snapshot))) {
        throw new PrototypeError("snapshot_mismatch", "Cached STEP bytes do not match the source identity", 422);
      }
    };
    try { await verifySource(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(output, JSON.stringify(model));
    // Hard links publish complete immutable files without replacing a concurrent winner.
    await publish(stagedSource, snapshot, verifySource);
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
