import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { importDiagnostics } from "../shared/diagnostics.mjs";
import { isInside } from "./paths.mjs";
import { PrototypeError, topologyRevision, validateMeasuredCleanup, validateModel } from "./protocol.mjs";
import { atomicJson } from "./storage.mjs";

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

export async function prepareModelSnapshot({ resolved, displayName, uploadDir, modelDir, python }) {
  const bytes = await readFile(resolved);
  if (bytes.length > maxStepBytes) throw new PrototypeError("too_large", "STEP file exceeds 100 MB", 413);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const snapshot = path.join(uploadDir, `${sourceHash}.step`);
  await writeFile(snapshot, bytes);
  const output = path.join(modelDir, `${sourceHash}.${randomUUID()}.json`);
  let failure;
  try {
    await python("convert.py", [snapshot, "--output", output]);
    if ((await stat(output)).size > maxJsonBytes) throw new PrototypeError("model_too_large", "Converted mesh exceeds the viewer's size limit", 413);
    const model = validateModel(JSON.parse(await readFile(output, "utf8")), { requireRevision: false });
    Object.assign(model, importDiagnostics(model));
    if (model.source.sha256 !== sourceHash) throw new PrototypeError("revision_mismatch", "Converted model does not match the STEP snapshot", 422);
    model.source.name = displayName || path.basename(resolved);
    model.topologyRevision = topologyRevision(model);
    const measuredCleanup = validateMeasuredCleanup({ topologyRevision: model.topologyRevision, counts: model.cleanup });
    const modelCache = `${model.topologyRevision}.json`;
    try {
      const cached = validateModel(JSON.parse(await readFile(path.join(modelDir, modelCache), "utf8")));
      if (cached.topologyRevision !== model.topologyRevision) throw new PrototypeError("cache_mismatch", "Cached geometry identity does not match", 422);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await atomicJson(path.join(modelDir, modelCache), model);
    }
    return { model, modelCache, inputFile: snapshot, inputName: model.source.name, measuredCleanup };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await rm(output, { force: true }); }
    catch (cleanup) {
      throw failure ? new AggregateError([failure, cleanup], "Model import and temporary-file cleanup failed") : cleanup;
    }
  }
}
