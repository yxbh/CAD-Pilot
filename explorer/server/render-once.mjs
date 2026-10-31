import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { partResolver } from "./assembly.mjs";
import { MAX_PART_IDS } from "../shared/commands.mjs";
import { isInside } from "./paths.mjs";
import { PrototypeError } from "./protocol.mjs";
import { createExplorerServer } from "./server.mjs";
import { cameraSummary, revisionLabel } from "./summary.mjs";
import { pruneIfDue } from "./runtime-store.mjs";

// An output must land in the project even when a folder on the way is a symlink, and never write through one.
export async function projectOutput(project, out) {
  const target = path.resolve(project, out);
  if (!isInside(project, target) || path.extname(target).toLowerCase() !== ".png") throw new PrototypeError("bad_output", "Choose a .png path inside the project");
  let existing = path.dirname(target);
  while (!(await lstat(existing).catch(() => null))) existing = path.dirname(existing);
  if (!isInside(project, await realpath(existing))) throw new PrototypeError("bad_output", "Choose a .png path inside the project");
  return target;
}

export async function saveCopy(project, source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const folder = await realpath(path.dirname(target));
  const current = await lstat(target).catch(() => null);
  if (!isInside(project, folder) || (current && !current.isFile())) throw new PrototypeError("bad_output", "Choose a .png path inside the project that is not a link or folder");
  await copyFile(source, path.join(folder, path.basename(target)));
  return path.relative(project, target).split(path.sep).join("/");
}

/**
 * Render one STEP or mesh file to a PNG without touching any saved setup: a private, transient viewer loads it, applies the
 * requested view and draws it in the background renderer. The view actions are the same ones `do` accepts. The answer's
 * camera is the one that drew the image, in the shape every answer reports (summary.mjs cameraSummary).
 * options: { units, up (how to read a mesh), width, height, background, view (preset or "azimuth:elevation"), projection, appearance, finish,
 * outlines, section: { axis, position, flipped }, explode: { amount, direction }, step: { step, mode }, hide: [label patterns],
 * analysis: a set_analysis input }.
 */
export async function renderOnce({ project, file, output, runtimeRoot, options = {}, log = () => {} }) {
  const target = await projectOutput(project, output);
  const service = await createExplorerServer({
    projectRoot: project, viewId: `render-${randomUUID()}`, file, fileOptions: { units: options.units, up: options.up },
    runtimeRoot, transient: true, referenceFormat: "text", log,
  });
  try {
    await service.initialize();
    const loaded = service.getState();
    if (loaded.error) throw new PrototypeError("load_failed", loaded.error, 422);
    const run = (name, input) => service.execute(name, input);
    if (options.hide?.length) {
      // Hidden parts are named as anywhere else: part or group labels, with * and ? wildcards.
      const resolve = partResolver(service.getModel());
      const { nodeIds, unresolved } = resolve(options.hide);
      if (unresolved.length) throw new PrototypeError("bad_render", `No part or group label matches ${unresolved.join(", ")}`);
      if (nodeIds.length === resolve.partCount) throw new PrototypeError("bad_render", `--hide ${options.hide.join(",")} would hide every part`);
      for (let start = 0; start < nodeIds.length; start += MAX_PART_IDS) await run("set_visibility", { ids: nodeIds.slice(start, start + MAX_PART_IDS), visible: false });
    }
    if (options.explode) await run("set_explode", options.explode);
    if (options.step) await run("set_step", options.step);
    if (options.section) await run("set_section", { enabled: true, ...options.section });
    if (options.projection) await run("set_projection", { projection: options.projection });
    if (options.appearance || options.finish || options.outlines !== undefined) {
      await run("set_appearance", {
        ...(options.appearance ? { mode: options.appearance } : {}), ...(options.finish ? { finish: options.finish } : {}),
        ...(options.outlines !== undefined ? { showEdges: options.outlines } : {}),
      });
    }
    if (options.analysis) await run("set_analysis", options.analysis);
    if (options.view) {
      const angle = /^(-?[\d.]+):(-?[\d.]+)$/.exec(options.view);
      await run("set_view", angle ? { azimuth: Number(angle[1]), elevation: Number(angle[2]) } : { preset: options.view });
    }
    const captured = await service.captureImage({ width: options.width, height: options.height, background: options.background });
    const state = service.getState();
    return {
      saved: await saveCopy(project, captured.path, target), width: captured.width, height: captured.height,
      model: state.modelName, file: state.source.file, revision: revisionLabel(state.source.sha256), generatedAt: state.source.generatedAt,
      camera: cameraSummary(state, captured.camera),
      ...(state.section.enabled ? { section: state.section } : {}),
      ...(captured.analysis ? { analysis: captured.analysis } : {}),
    };
  } finally {
    await service.close();
    // The transient viewer saves no setup, but its snapshots join the shared store, so prune it here.
    await pruneIfDue(runtimeRoot, { log });
  }
}
