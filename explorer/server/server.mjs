import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changeView, initialState, loadedView, PrototypeError, validateCommandRevision, validateMeasuredCleanup, validateModel } from "./protocol.mjs";
import { commandDefinition } from "../shared/commands.mjs";
import { createReference, formatSelection } from "../shared/references.mjs";
import { composerAttachment } from "./composer.mjs";
import { importDiagnostics } from "../shared/diagnostics.mjs";
import { ReviewStore, validateCamera } from "./reviews.mjs";
import { atomicJson } from "./storage.mjs";
import { inspectionFor, REFERENCE_FORMATS } from "./inspection.mjs";
import { explorerRoot, workbenchRoot, workbenchPython, runtimeRoot as defaultRuntimeRoot, canonicalProjectRoot, isInside } from "./paths.mjs";
import { acquireViewOwner } from "./view-owner.mjs";
import { maxStepBytes, prepareModelSnapshot, validateStepPath } from "./model-import.mjs";
import { readSequence, sequencePath } from "./assembly.mjs";
import { defaultSection, pruneSectionSelection, reconcileSectionWithDisplay, sameSection, sectionSupport, validateSection } from "../shared/section.mjs";
import { displayedWorldBounds } from "../shared/placement.mjs";
import { createHeadlessRenderer } from "./renderer.mjs";
import { markUsed, pruneRuntime } from "./runtime-store.mjs";
import { stateSummary } from "./summary.mjs";

export { explorerRoot, workbenchRoot, runtimeRoot } from "./paths.mjs";
const maxImageBytes = 40 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicError = (error) => error instanceof Error ? error.message : String(error);
// An open viewer page usually draws within a frame or two; it gets this long before the background renderer starts.
const viewerGraceMs = 1500;
const renderTimeoutMs = 90_000;
const pruneIntervalMs = 10 * 60 * 1000;

async function readOptionalJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new PrototypeError("state_read_failed", `Cannot read saved Explorer state: ${publicError(error)}`, 500);
  }
}

async function body(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new PrototypeError("too_large", "Request exceeds the viewer's size limit", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req, limit = 100_000, { optional = false } = {}) {
  try {
    const text = (await body(req, limit)).toString("utf8");
    return optional && !text.trim() ? {} : JSON.parse(text);
  }
  catch (error) {
    if (error instanceof PrototypeError) throw error;
    throw new PrototypeError("invalid_json", "Expected a JSON request");
  }
}

// Capture options apply to one image; they never change the saved view.
function captureOptions({ width, height, background } = {}) {
  const size = (value, name) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 16 || value > 4096)) throw new PrototypeError("bad_capture", `${name} must be a whole number of pixels from 16 to 4096`);
    return value;
  };
  if (background !== undefined && (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background))) throw new PrototypeError("bad_capture", "background must be a colour such as #ffffff");
  return { width: size(width, "width"), height: size(height, "height"), background };
}

export const viewKeyFor = (project, viewId) => hash(`${project}\n${viewId}`).slice(0, 24);

// port/token let a launcher keep one address per setup across restarts; onShutdown enables POST api/shutdown for that host.
// renderer starts the background page that draws views when no visible tab does (null leaves rendering to open pages).
// A transient service (a one-shot render) saves no setup and keeps its captures in a private temporary folder.
export async function createExplorerServer({
  projectRoot = workbenchRoot, viewId = "default", file, runtimeRoot = defaultRuntimeRoot,
  addReferenceToChat, log = (message) => process.stderr.write(`${message}\n`),
  referenceFormat = "copilot-ref", port = 0, token, onShutdown, renderer = createHeadlessRenderer, transient = false,
} = {}) {
  if (!REFERENCE_FORMATS.includes(referenceFormat)) throw new PrototypeError("bad_reference_format", `Unknown reference format: ${referenceFormat}`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PrototypeError("bad_port", "port must be an integer from 0 to 65535");
  if (token !== undefined && !/^[a-f0-9]{48}$/.test(token)) throw new PrototypeError("bad_token", "token must be 48 lowercase hexadecimal characters");
  const project = await canonicalProjectRoot(projectRoot);
  if (typeof viewId !== "string" || !viewId.length || viewId.length > 80) throw new PrototypeError("bad_view_id", "viewId must contain 1 to 80 characters");
  await mkdir(runtimeRoot, { recursive: true });
  runtimeRoot = await realpath(runtimeRoot);
  const inspection = inspectionFor(runtimeRoot);
  const viewKey = viewKeyFor(project, viewId);
  const releaseOwner = transient ? async () => {} : await acquireViewOwner(runtimeRoot, viewKey);
  try {
    return await startOwnedService({
      project, viewKey, file, runtimeRoot, inspection, addReferenceToChat, log, releaseOwner, referenceFormat, port, token, onShutdown, renderer, transient,
    });
  } catch (error) {
    await releaseOwner();
    throw error;
  }
}

async function startOwnedService({
  project, viewKey, file, runtimeRoot, inspection, addReferenceToChat, log, releaseOwner, referenceFormat, port, token: requestedToken, onShutdown, renderer, transient,
}) {
  const { inspectReference, prepareClipboardReference } = inspection;
  const viewDir = path.join(runtimeRoot, "views");
  const modelDir = path.join(runtimeRoot, "models");
  const uploadDir = path.join(runtimeRoot, "inputs");
  await Promise.all([viewDir, modelDir, uploadDir].map((dir) => mkdir(dir, { recursive: true })));
  const captureDir = transient ? await mkdtemp(path.join(os.tmpdir(), "cad-explorer-render-")) : path.join(runtimeRoot, "captures");
  await mkdir(captureDir, { recursive: true });
  const stateFile = path.join(viewDir, `${viewKey}.json`);
  const reviews = new ReviewStore(path.join(runtimeRoot, "reviews", viewKey));
  const saved = transient ? null : await readOptionalJson(stateFile);
  let measuredCleanup = saved?.measuredCleanup === undefined ? undefined : validateMeasuredCleanup(saved.measuredCleanup);
  const savedSection = saved?.state?.section;
  if (savedSection !== undefined) {
    try { validateSection(savedSection); }
    catch (error) { throw new PrototypeError("invalid_saved_section", `Invalid saved section settings: ${error.message}`, 422); }
  }
  let state = { ...initialState(), ...saved?.state };
  delete state.autoAdd;
  let model = null;
  // A failed explicit startup import must not discard the last saved snapshot.
  let modelCache = saved?.modelCache ?? "";
  let inputFile = saved?.inputFile ?? "";
  let inputName = saved?.inputName ?? "";
  let closed = false;
  let closing;
  let initialization;
  let initialized = false;
  let queue = Promise.resolve();
  // The last report from a person's viewer page, and from the background renderer.
  let lastRendered = null;
  let lastHeadless = null;
  let lastPrune = 0;
  const clients = new Map();
  const children = new Set();
  const renderWaiters = new Set();
  const captures = new Map();
  const token = requestedToken ?? randomBytes(24).toString("hex");
  let origin = "";
  let headless = null;

  const enqueue = (job) => {
    if (closed) return Promise.reject(new PrototypeError("closed", "Canvas closed", 410));
    const pending = queue.then(job, job);
    queue = pending;
    return pending;
  };
  const send = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const emit = (name, data) => { for (const res of clients.keys()) send(res, name, data); };
  const viewerCount = () => [...clients.values()].filter((client) => client.kind === "viewer").length;
  const saveView = (next, snapshot = { modelCache, inputFile, inputName, measuredCleanup }) => transient ? Promise.resolve() : atomicJson(stateFile, {
    state: next, modelCache: snapshot.modelCache, inputFile: snapshot.inputFile,
    inputName: snapshot.inputName, measuredCleanup: snapshot.measuredCleanup,
  });
  const commit = async (patch, imported) => {
    const next = { ...state, ...patch, revision: state.revision + 1 };
    await saveView(next, imported);
    if (imported) {
      ({ model, modelCache, inputFile, inputName, measuredCleanup } = imported);
      lastRendered = lastHeadless = null;
    }
    state = next;
    emit("state", state);
    return state;
  };
  const drawn = (report) => report?.revision === state.revision && report.topologyRevision === state.topologyRevision;
  const getState = () => ({
    ...state,
    application: "CAD Explorer",
    version: "1.0.0",
    projectRoot: project,
    runtimeRoot,
    rendered: lastRendered,
    // viewers counts open viewer pages; seen is whether one of them has drawn the current revision.
    // drawn says which renderer drew the current revision: a viewer page, the background renderer, or neither yet.
    renderers: {
      viewers: viewerCount(), seen: drawn(lastRendered), headless: !!headless?.running,
      drawn: drawn(lastRendered) ? "viewer" : drawn(lastHeadless) ? "headless" : null,
    },
    // False until the startup model (requested file, saved setup or demo) has been loaded or has failed.
    initialized,
    parts: model?.nodes.filter((node) => node.partId).map(({ id, label, partId }) => ({ id, label, partId })) || [],
    selectedReferences: model ? state.selectedIds.map((id) => ({
      id,
      reference: createReference(model, id, state.selectedFace?.nodeId === id ? state.selectedFace.faceId : null, state.selectedEdge?.nodeId === id ? state.selectedEdge.edgeId : null),
      text: formatSelection(model, id, state.selectedFace?.nodeId === id ? state.selectedFace.faceId : null, state.selectedEdge?.nodeId === id ? state.selectedEdge.edgeId : null),
    })) : [],
    limitations: [
      "Snapshot loading; no file watcher",
      "Explosion and assembly steps are visual offsets, not a disassembly simulation; sequence check results come from the sequence file",
      "Section caps are display-derived and do not modify or measure the STEP",
    ],
  });
  async function summary() {
    let changedOnDisk = false;
    if (state.source.file && !state.loading) {
      const info = await stat(path.join(project, state.source.file)).catch(() => null);
      changedOnDisk = !info || info.size !== state.source.size || info.mtime.toISOString() !== state.source.generatedAt;
    }
    return stateSummary(getState(), { url: origin && `${origin}/${token}/`, changedOnDisk });
  }

  async function python(script, args) {
    await stat(workbenchPython);
    return new Promise((resolve, reject) => {
      let stderr = "";
      let expired = false;
      const child = spawn(workbenchPython, [path.join(explorerRoot, "python", script), ...args], {
        cwd: project, shell: false, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.add(child);
      const timer = setTimeout(() => { expired = true; child.kill(); }, 120_000);
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-6000); });
      child.once("error", (error) => { clearTimeout(timer); children.delete(child); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer); children.delete(child);
        if (expired) reject(new PrototypeError("conversion_timeout", "STEP conversion exceeded two minutes", 408));
        else if (code !== 0) reject(new PrototypeError("conversion_failed", stderr.trim() || `Python exited with ${code}`, 422));
        else resolve();
      });
    });
  }

  // Storage stays bounded without a separate maintenance step; a failed prune never fails the user's action.
  function schedulePrune() {
    if (transient || Date.now() - lastPrune < pruneIntervalMs) return;
    lastPrune = Date.now();
    void pruneRuntime(runtimeRoot).then(({ freedBytes, removed }) => {
      if (freedBytes) log(`Explorer storage: removed ${Object.entries(removed).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`).join(", ")} (${Math.round(freedBytes / 1048576)} MB)`);
    }, (error) => log(`Explorer storage cleanup: ${publicError(error)}`));
  }

  async function demoFile() {
    const target = path.join(runtimeRoot, "demo-assembly.step");
    const missing = (file) => stat(file).then(() => false, (error) => {
      if (error?.code !== "ENOENT") throw error;
      return true;
    });
    if (await missing(target)) await python("create_demo.py", ["--output", target]);
    // Older runtimes gain the demo sequence without rewriting the STEP that saved views and references use.
    else if (await missing(sequencePath(target))) await python("create_demo.py", ["--output", target, "--sequence-only"]);
    return target;
  }

  async function loadFile(target, displayName, internal = false) {
    if (closed) throw new PrototypeError("closed", "Prototype has closed", 410);
    const root = internal ? await realpath(runtimeRoot) : project;
    const resolved = await validateStepPath(target, root);
    const info = await stat(resolved);
    const source = { file: internal ? "" : path.relative(project, resolved).split(path.sep).join("/"), generatedAt: info.mtime.toISOString(), size: info.size };
    return loadSnapshot({ resolved, displayName, sequenceRoot: root }, source);
  }

  async function loadSnapshot(snapshot, source) {
    if (closed) throw new PrototypeError("closed", "Prototype has closed", 410);
    await commit({ loading: true, error: "" });
    try {
      const imported = await prepareModelSnapshot({ ...snapshot, uploadDir, modelDir, python });
      await markUsed(imported.inputFile, path.join(modelDir, imported.modelCache));
      const assembly = snapshot.resolved ? await loadSequence(snapshot.resolved, imported.model, snapshot.sequenceRoot) : null;
      await commit(loadedView(state, model, imported.model, {
        assembly, documentRevision: imported.model.source.sha256, topologyRevision: imported.model.topologyRevision,
        modelName: imported.inputName, source, loading: false, error: "",
      }), imported);
      schedulePrune();
      return state;
    } catch (error) {
      await commit({ loading: false, error: publicError(error) });
      throw error;
    }
  }

  // A broken sequence file must not prevent viewing the STEP; its problem is reported in state instead.
  async function loadSequence(stepPath, loaded, root) {
    try { return await readSequence(stepPath, loaded, root); }
    catch (error) {
      const file = path.relative(root, sequencePath(stepPath)).split(path.sep).join("/");
      log(`Explorer assembly sequence: ${publicError(error)}`);
      return { file, stale: false, digest: "", steps: [], error: publicError(error) };
    }
  }

  const headlessRenderer = () => {
    if (!renderer || closed) return null;
    headless ??= renderer({ url: `${origin}/${token}/`, log, onExit: (error) => failHeadless(error) });
    return headless;
  };
  // Waits for which renderer depends on who is asking: "headless" for captures, "any" for load and view confirmations.
  const dependsOnHeadless = (by) => by === "headless" || (by === "any" && !viewerCount());
  function settle(waiter, error, report) {
    if (!renderWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer); clearTimeout(waiter.grace);
    if (error) waiter.reject(error);
    else waiter.resolve(report);
  }
  function failHeadless(error) {
    for (const waiter of [...renderWaiters]) if (dependsOnHeadless(waiter.by)) settle(waiter, error);
    for (const [id, pending] of captures) {
      if (pending.kind !== "headless") continue;
      clearTimeout(pending.timer); captures.delete(id); pending.reject(error);
    }
  }
  function renderedBy(by) {
    if (by !== "headless" && drawn(lastRendered)) return { ...lastRendered, kind: "viewer" };
    if (by !== "viewer" && drawn(lastHeadless)) return { ...lastHeadless, kind: "headless" };
    return null;
  }

  // Resolves once a renderer has drawn this revision. With no open (or no answering) viewer page, the background
  // renderer is started, so a hidden or closed tab never leaves a view unconfirmed.
  function waitForRender(revision, { by = "any" } = {}) {
    if (revision !== state.revision) return Promise.reject(new PrototypeError("superseded_view", "A newer view command superseded this one", 409));
    const done = renderedBy(by);
    if (done) return Promise.resolve(done);
    return new Promise((resolve, reject) => {
      const waiter = { revision, topologyRevision: state.topologyRevision, by, resolve, reject, timer: null, grace: null };
      renderWaiters.add(waiter);
      waiter.timer = setTimeout(() => settle(waiter, new PrototypeError("renderer_timeout", headless?.running
        ? `The background renderer did not draw the view within ${renderTimeoutMs / 1000} s. Retry, or open ${origin}/${token}/ to look.`
        : `No renderer drew the view within ${renderTimeoutMs / 1000} s. Open ${origin}/${token}/ and retry.`, 408)), renderTimeoutMs);
      const start = () => {
        const background = headlessRenderer();
        void background?.ensure().catch((error) => {
          if (dependsOnHeadless(by)) settle(waiter, error);
          else log(`Explorer headless renderer: ${publicError(error)}`);
        });
      };
      if (by === "viewer") return;
      if (dependsOnHeadless(by)) start();
      else waiter.grace = setTimeout(start, viewerGraceMs);
    });
  }

  // Confirms the current view against a renderer that drew it, retrying when a newer command supersedes it.
  async function confirmRendered() {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!model || state.loading) break;
      try { await waitForRender(state.revision); break; }
      catch (error) { if (error?.code !== "superseded_view") throw error; }
    }
    return summary();
  }

  async function execute(name, input = {}, { rendered = false } = {}) {
    const definition = commandDefinition(name);
    if (!definition) throw new PrototypeError("unknown_command", `Unknown command: ${name}`);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new PrototypeError("bad_input", "Command input must be an object");
    if (name === "get_state") return input.detail === "full" ? getState() : summary();
    if (name === "inspect_reference") return inspectReference(input.reference);
    if (name === "prepare_clipboard_reference") return prepareClipboardReference(input.reference, referenceFormat);
    if (name === "list_reviews") return reviews.list();
    if (name === "get_review") {
      const review = await reviews.get(input.id);
      return { ...review, image: { width: review.image.width, height: review.image.height }, drawing: { strokeCount: review.drawing.present.length } };
    }
    if (name === "capture_image") return captureImage(input);
    if (name === "add_reference_to_chat") {
      return enqueue(async () => {
        const attachment = composerAttachment(model, state, input.expectedRevision);
        if (!addReferenceToChat) throw new PrototypeError("no_composer", "This viewer has no Copilot message draft. Use Copy text under Reference text instead.", 409);
        await addReferenceToChat(attachment);
        return { added: true, title: attachment.title, sent: false };
      });
    }
    const changed = await enqueue(async () => {
      validateCommandRevision(state, name, input.expectedRevision);
      if (name === "open_review") {
        await reviews.get(input.id);
        return commit({ activeReviewId: input.id });
      }
      if (name === "close_review") return commit({ activeReviewId: null });
      if (name === "save_camera") {
        if (state.activeReviewId) throw new PrototypeError("review_active", "Captured review cameras do not move", 409);
        if (input.topologyRevision !== state.topologyRevision || input.expectedRevision !== state.revision) throw new PrototypeError("stale_view", "View changed while saving the camera", 409);
        validateCamera(input.camera);
        if ((input.camera.projection ?? "perspective") !== state.projection) throw new PrototypeError("stale_view", "Projection changed while saving the camera", 409);
        return commit({ camera: input.camera, cameraPinned: true });
      }
      if (state.activeReviewId && !definition.duringReview) {
        throw new PrototypeError("review_active", "Return to the model before changing its view. Drawing reviews stay bound to their captured pose.", 409);
      }
      if (name === "load_file") {
        if (typeof input.file !== "string" || !input.file) throw new PrototypeError("bad_file", "Supply a project-relative STEP path");
        return loadFile(path.resolve(project, input.file), path.basename(input.file));
      }
      if (name === "load_demo") return loadFile(await demoFile(), "Demo assembly.step", true);
      const next = changeView(state, model, name, input);
      await commit(next);
      return state;
    });
    if (rendered && definition.render === "live") await waitForRender(changed.revision);
    return getState();
  }

  // Agents' captures come from the background renderer at a fixed size; a viewer page's own Capture button names
  // itself as the client so the image matches what that person sees.
  async function captureImage(input = {}) {
    const { client, ...requested } = input;
    const options = captureOptions(requested);
    if (!model || state.loading) throw new PrototypeError("not_ready", "Wait for the model to finish loading", 409);
    const review = state.activeReviewId ? await reviews.get(state.activeReviewId) : null;
    const revision = state.revision;
    let target;
    if (client !== undefined) {
      target = [...clients].find(([, item]) => item.id === client && item.kind === "viewer");
      if (!target) throw new PrototypeError("unknown_client", "This viewer page is not connected; reload it and retry", 409);
      if (!review) await waitForRender(revision, { by: "viewer" });
    } else {
      await waitForRender(revision, { by: "headless" });
      target = [...clients].filter(([, item]) => item.kind === "headless").at(-1);
      if (!target) throw new PrototypeError("renderer_failed", "The background renderer disconnected before the capture", 503);
    }
    headless?.touch();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        captures.delete(id);
        reject(new PrototypeError("capture_timeout", "The renderer did not return an image", 408));
      }, 30_000);
      const request = { id, revision, reviewId: review?.id ?? null, reviewVersion: review?.version, ...options };
      captures.set(id, { ...request, kind: target[1].kind, resolve, reject, timer });
      send(target[0], "capture", request);
    });
  }

  // Images are stored by content: an unchanged view captured again reuses its file.
  async function saveCapture(pending, payload) {
    if (typeof payload.dataUrl !== "string" || !payload.dataUrl.startsWith("data:image/png;base64,")) throw new PrototypeError("invalid_image", "Expected a PNG image");
    const bytes = Buffer.from(payload.dataUrl.slice("data:image/png;base64,".length), "base64");
    if (bytes.length > maxImageBytes || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new PrototypeError("invalid_image", "Invalid or oversized PNG");
    if (payload.camera) validateCamera(payload.camera);
    const imagePath = path.join(captureDir, `${hash(bytes).slice(0, 32)}.png`);
    const result = {
      path: imagePath, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), by: pending.kind,
      revision: state.revision, documentRevision: state.documentRevision, topologyRevision: state.topologyRevision,
      modelName: state.modelName, source: state.source,
      exploded: state.explode, step: state.step, stepMode: state.stepMode, selectedIds: state.selectedIds, selectedFace: state.selectedFace,
      selectedEdge: state.selectedEdge,
      camera: payload.camera ?? state.camera, appearance: state.appearance, materialFinish: state.materialFinish, showEdges: state.showEdges,
      section: state.section,
    };
    if (await stat(imagePath).then(() => true, () => false)) await markUsed(imagePath);
    else await writeFile(imagePath, bytes);
    await atomicJson(`${imagePath}.json`, result);
    schedulePrune();
    return result;
  }

  const server = createServer(async (req, res) => {
    const respond = (code, data) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      const host = new URL(origin).host;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) {
        throw new PrototypeError("forbidden_origin", "Local Explorer requests only", 403);
      }
      const url = new URL(req.url || "/", origin);
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) throw new PrototypeError("forbidden", "Invalid Explorer capability", 403);
      const route = url.pathname.slice(prefix.length);
      if (route === "api/state" && req.method === "GET") return respond(200, url.searchParams.get("detail") === "summary" ? await summary() : getState());
      if (route === "api/model" && req.method === "GET") {
        if (!model) throw new PrototypeError("not_ready", "Model is not ready", 409);
        return respond(200, model);
      }
      if (route === "api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        const kind = url.searchParams.get("kind") === "headless" ? "headless" : "viewer";
        clients.set(res, { id: url.searchParams.get("client") || randomUUID(), kind });
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        res.on("close", () => { clients.delete(res); clearInterval(heartbeat); });
        return;
      }
      if (route === "api/command" && req.method === "POST") {
        const payload = await jsonBody(req);
        const result = await execute(payload.name, payload.input, { rendered: payload.rendered === true });
        return respond(200, payload.detail === "summary" && payload.name !== "get_state" && result?.application ? await summary() : result);
      }
      if (route === "api/confirm" && req.method === "POST") return respond(200, await confirmRendered());
      if (route === "api/upload" && req.method === "POST") {
        const filename = decodeURIComponent(String(req.headers["x-file-name"] || ""));
        if (![".step", ".stp"].includes(path.extname(filename).toLowerCase())) throw new PrototypeError("not_step", "Choose a STEP file");
        const modified = Number(req.headers["x-file-modified"]);
        const bytes = await body(req, maxStepBytes);
        const loaded = await enqueue(() => {
          if (state.activeReviewId) throw new PrototypeError("review_active", "Return to the model before opening another STEP", 409);
          const generatedAt = Number.isFinite(modified) && modified > 0 ? new Date(modified).toISOString() : "";
          return loadSnapshot({ bytes, displayName: path.basename(filename) }, { file: "", generatedAt, size: bytes.length });
        });
        return respond(200, loaded);
      }
      if (route === "api/rendered" && req.method === "POST") {
        const report = await jsonBody(req);
        const result = await enqueue(async () => {
          if (!report || typeof report !== "object" || Array.isArray(report) ||
              !Number.isSafeInteger(report.revision) || report.revision < 0 ||
              ![report.modelHash, report.topologyRevision].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
            throw new PrototypeError("bad_render_report", "Invalid renderer revision or model identity", 409);
          }
          if (report.camera !== undefined) validateCamera(report.camera);
          // Old model hashes are expected after a switch; no stale report may write or release a waiter.
          if (report.revision < state.revision) return { accepted: false, reason: "superseded_view" };
          if (report.revision > state.revision) throw new PrototypeError("bad_render_report", "Renderer revision is ahead of the view", 409);
          if (report.modelHash !== state.documentRevision || report.topologyRevision !== state.topologyRevision) throw new PrototypeError("bad_render_report", "Renderer revision does not match the model", 409);
          if ((state.section.enabled || report.section !== undefined) && !sameSection(report.section, state.section)) {
            throw new PrototypeError("bad_render_report", "Rendered section does not match the saved view", 409);
          }
          const kind = report.kind === "headless" ? "headless" : "viewer";
          // The person's camera is the one to remember; the background renderer only follows it.
          if (kind === "viewer" && report.camera && !state.activeReviewId) {
            if ((report.camera.projection ?? "perspective") !== state.projection) throw new PrototypeError("bad_render_report", "Rendered projection does not match the view", 409);
            const next = { ...state, camera: report.camera };
            await saveView(next);
            state = next;
          }
          if (kind === "viewer") lastRendered = report;
          else lastHeadless = report;
          for (const waiter of [...renderWaiters]) {
            if (report.revision < waiter.revision) continue;
            if (report.revision !== waiter.revision || report.topologyRevision !== waiter.topologyRevision) {
              settle(waiter, new PrototypeError("superseded_view", "A newer view command superseded this one", 409));
            } else if (waiter.by === "any" || waiter.by === kind) settle(waiter, null, { ...report, kind });
          }
          return { accepted: true };
        });
        return respond(200, result);
      }
      if (route === "api/renderer-error" && req.method === "POST") {
        const payload = await jsonBody(req);
        const message = String(payload.message || "The background renderer failed").slice(0, 500);
        log(`Explorer headless renderer: ${message}`);
        if (!(payload.webgl === true && await headless?.fallBack())) {
          failHeadless(new PrototypeError("render_failed", `Background rendering failed: ${message}`, 503));
          await headless?.stop();
        }
        return respond(200, { received: true });
      }
      if (route === "api/capture" && req.method === "POST") return respond(200, await captureImage(await jsonBody(req, 100_000, { optional: true })));
      if (route === "api/shutdown" && req.method === "POST" && onShutdown) {
        respond(200, { stopping: true });
        setImmediate(onShutdown);
        return;
      }
      if (route === "api/reviews" && req.method === "GET") return respond(200, await reviews.list());
      if (route === "api/reviews" && req.method === "POST") {
        const input = await jsonBody(req, 18 * 1024 * 1024);
        const created = await enqueue(async () => {
          const review = await reviews.create(input.capture, state, input.revision);
          await commit({ activeReviewId: review.id, camera: input.capture.camera });
          return review;
        });
        return respond(200, created);
      }
      const reviewRoute = /^api\/reviews\/([a-f0-9-]{36})(?:\/(image|copy))?$/.exec(route);
      if (reviewRoute && req.method === "GET" && !reviewRoute[2]) return respond(200, await reviews.get(reviewRoute[1]));
      if (reviewRoute && req.method === "POST") {
        const input = await jsonBody(req, 24 * 1024 * 1024);
        const result = await enqueue(async () => {
          if (reviewRoute[2] === "image") return reviews.saveImage(reviewRoute[1], input.version, input.dataUrl);
          if (reviewRoute[2] === "copy") {
            const review = await reviews.copy(reviewRoute[1], input.drawing);
            await commit({ activeReviewId: review.id });
            return review;
          }
          return reviews.save(reviewRoute[1], input.drawing, input.version);
        });
        return respond(200, result);
      }
      if (route === "api/clipboard-reference" && req.method === "POST") {
        const payload = await jsonBody(req);
        return respond(200, await prepareClipboardReference(payload.reference, referenceFormat));
      }
      if (route === "api/add-reference" && req.method === "POST") {
        const payload = await jsonBody(req);
        return respond(200, await execute("add_reference_to_chat", { expectedRevision: payload.revision }));
      }
      if (route === "api/capture-result" && req.method === "POST") {
        const payload = await jsonBody(req, maxImageBytes * 1.5);
        const pending = captures.get(payload.id);
        if (!pending) throw new PrototypeError("unknown_capture", "Capture request is no longer active", 409);
        const finish = (error, result) => {
          clearTimeout(pending.timer); captures.delete(payload.id);
          if (error) pending.reject(error); else pending.resolve(result);
        };
        if (payload.error || payload.revision !== pending.revision || state.revision !== pending.revision) {
          finish(new PrototypeError("capture_changed", payload.error || "View changed during capture", 409));
          return respond(409, { error: payload.error || "View changed during capture" });
        }
        try {
          finish(null, pending.reviewId
            ? await enqueue(() => reviews.saveImage(pending.reviewId, pending.reviewVersion, payload.dataUrl))
            : await saveCapture(pending, payload));
        } catch (error) {
          finish(error);
          throw error;
        }
        return respond(200, { saved: true });
      }
      if (route.startsWith("api/") || req.method !== "GET") throw new PrototypeError("not_found", "Unknown Explorer endpoint", 404);
      const dist = await realpath(path.join(explorerRoot, "dist"));
      const candidate = await realpath(path.resolve(dist, decodeURIComponent(route || "index.html")));
      if (!isInside(dist, candidate) || !(await stat(candidate)).isFile()) throw new PrototypeError("not_found", "Unknown asset", 404);
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }[path.extname(candidate)] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'",
      });
      res.end(await readFile(candidate));
    } catch (error) {
      log(`Explorer request: ${publicError(error)}`);
      if (!res.headersSent) respond(error instanceof PrototypeError ? error.status : 500, { error: publicError(error), code: error.code || "explorer_error" });
      else res.end();
    }
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 15_000;
  const listen = (candidate) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(candidate, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  // A preferred port is only a convenience for stable links: another program may hold it, or Windows may have
  // reserved it since the last start (EACCES), so any failure falls back to a free port.
  try { await listen(port); }
  catch (error) {
    if (!port) throw error;
    await listen(0);
  }
  server.on("error", (error) => log(`Explorer server: ${publicError(error)}`));
  origin = `http://127.0.0.1:${server.address().port}`;

  async function initialize() {
    try {
      if (file) await execute("load_file", { file });
      else if (saved?.modelCache && /^[a-f0-9]{64}\.json$/.test(saved.modelCache)) {
        const cached = JSON.parse(await readFile(path.join(modelDir, saved.modelCache), "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          throw new PrototypeError("snapshot_removed", `${saved.inputName || "The saved model"} was removed from Explorer's storage after its setup went unused. Open the STEP again.`, 410);
        }));
        if (cached.schemaVersion !== 1) {
          validateModel(cached);
          if (`${cached.topologyRevision}.json` !== saved.modelCache) throw new PrototypeError("cache_mismatch", "Saved geometry identity does not match its cache filename", 422);
        }
        if (cached.schemaVersion === 1 || cached.parts.some((part) => part.edges === undefined)) {
          if (!/^[a-f0-9]{64}$/.test(cached.source?.sha256 || "")) throw new PrototypeError("invalid_snapshot", "Saved STEP snapshot identity is invalid", 422);
          log("Rebuilding the saved prototype snapshot for exact CAD face and edge selection. Old selections are cleared; previous reference snapshots are retained.");
          await loadFile(path.join(uploadDir, `${cached.source.sha256}.step`), saved.inputName || state.modelName || cached.source.name, true);
        } else {
          model = cached;
          Object.assign(model, importDiagnostics(model));
          // Normalize historical warning strings before adding newly measured counts.
          if (measuredCleanup?.topologyRevision === model.topologyRevision) {
            model.cleanup = { ...measuredCleanup.counts };
          } else if (measuredCleanup) {
            log("Discarding saved cleanup counts for a different topology revision.");
            measuredCleanup = undefined;
          }
          modelCache = saved.modelCache;
          inputFile = saved.inputFile;
          inputName = saved.inputName || state.modelName || model.source.name;
          model.source = { ...model.source, name: inputName };
          await markUsed(inputFile, path.join(modelDir, modelCache));
          let section = savedSection ?? defaultSection(displayedWorldBounds(model, state) ?? model.bounds);
          const support = sectionSupport(model);
          if (section.enabled && !support.supported) {
            log(`Section view was turned off: ${support.message}`);
            section = { ...section, enabled: false };
          }
          const restored = pruneSectionSelection(reconcileSectionWithDisplay({ ...state, section }, model), model);
          await commit({ ...restored, loading: false, error: "", modelName: inputName, topologyRevision: model.topologyRevision, viewKept: null });
        }
      } else await execute("load_demo");
    } catch (error) {
      log(`Explorer initialization: ${publicError(error)}`);
      await commit({ loading: false, error: publicError(error) });
    }
  }

  return {
    url: `${origin}/${token}/`,
    projectRoot: project,
    initialize: () => initialization ??= initialize().finally(() => { initialized = true; }),
    execute,
    getState,
    summary,
    confirmRendered,
    captureImage,
    close() {
      if (closing) return closing;
      closed = true;
      for (const child of children) child.kill();
      for (const client of clients.keys()) client.end();
      for (const waiter of [...renderWaiters]) settle(waiter, new PrototypeError("closed", "Canvas closed", 410));
      for (const pending of captures.values()) { clearTimeout(pending.timer); pending.reject(new PrototypeError("closed", "Canvas closed", 410)); }
      closing = (async () => {
        try {
          await initialization;
          await queue.catch((error) => { log(`Explorer pending operation ended during close: ${publicError(error)}`); });
        } finally {
          try { await headless?.close(); }
          finally {
            server.closeAllConnections();
            try { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
            finally {
              if (transient) await rm(captureDir, { recursive: true, force: true });
              await releaseOwner();
            }
          }
        }
      })();
      return closing;
    },
  };
}
