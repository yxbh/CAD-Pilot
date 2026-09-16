import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { changeView, initialState, PrototypeError, topologyRevision, validateModel } from "./protocol.mjs";
import { createReference, formatSelection } from "../shared/references.mjs";
import { composerAttachment } from "./composer.mjs";
import { importWarnings } from "../shared/diagnostics.mjs";
import { ReviewStore, validateCamera } from "./reviews.mjs";
import { atomicJson } from "./storage.mjs";
import { createInspectionService } from "./inspection.mjs";
import { explorerRoot, workbenchRoot, workbenchPython, runtimeRoot, canonicalProjectRoot } from "./paths.mjs";
import { acquireViewOwner } from "./view-owner.mjs";

export { explorerRoot, workbenchRoot, runtimeRoot } from "./paths.mjs";
const maxStepBytes = 100 * 1024 * 1024;
const maxJsonBytes = 160 * 1024 * 1024;
const maxImageBytes = 12 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicError = (error) => error instanceof Error ? error.message : String(error);
const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

export const { inspectReference, prepareClipboardReference } = createInspectionService({ runtimeRoot, workbenchRoot });

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

async function jsonBody(req, limit = 100_000) {
  try { return JSON.parse((await body(req, limit)).toString("utf8")); }
  catch (error) {
    if (error instanceof PrototypeError) throw error;
    throw new PrototypeError("invalid_json", "Expected a JSON request");
  }
}

export async function createExplorerServer({ projectRoot = workbenchRoot, viewId = "default", file, addReferenceToChat, log = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const project = await canonicalProjectRoot(projectRoot);
  if (typeof viewId !== "string" || !viewId.length || viewId.length > 80) throw new PrototypeError("bad_view_id", "viewId must contain 1 to 80 characters");
  const viewKey = hash(`${project}\n${viewId}`).slice(0, 24);
  const releaseOwner = await acquireViewOwner(runtimeRoot, viewKey);
  try { return await startOwnedService({ project, viewKey, file, addReferenceToChat, log, releaseOwner }); }
  catch (error) {
    await releaseOwner();
    throw error;
  }
}

async function startOwnedService({ project, viewKey, file, addReferenceToChat, log, releaseOwner }) {
  const viewDir = path.join(runtimeRoot, "views");
  const modelDir = path.join(runtimeRoot, "models");
  const uploadDir = path.join(runtimeRoot, "inputs");
  const captureDir = path.join(runtimeRoot, "captures");
  await Promise.all([viewDir, modelDir, uploadDir, captureDir].map((dir) => mkdir(dir, { recursive: true })));
  const stateFile = path.join(viewDir, `${viewKey}.json`);
  const reviews = new ReviewStore(path.join(runtimeRoot, "reviews", viewKey));
  const saved = await readOptionalJson(stateFile);
  let state = { ...initialState(), ...saved?.state };
  delete state.autoAdd;
  let model = null;
  let modelCache = "";
  let inputFile = "";
  let inputName = "";
  let closed = false;
  let closing;
  let initialization;
  let queue = Promise.resolve();
  let lastRendered = null;
  const clients = new Set();
  const children = new Set();
  const renderWaiters = new Set();
  const captures = new Map();
  const token = randomBytes(24).toString("hex");
  let origin = "";

  const enqueue = (job) => {
    if (closed) return Promise.reject(new PrototypeError("closed", "Canvas closed", 410));
    const pending = queue.then(job, job);
    queue = pending;
    return pending;
  };
  const emit = (name, data) => {
    for (const client of clients) client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const commit = async (patch) => {
    const next = { ...state, ...patch, revision: state.revision + 1 };
    await atomicJson(stateFile, { state: next, modelCache, inputFile, inputName });
    state = next;
    emit("state", state);
    return state;
  };
  const getState = () => ({
    ...state,
    application: "CAD Explorer",
    version: "1.0.0",
    projectRoot: project,
    runtimeRoot,
    rendered: lastRendered,
    parts: model?.nodes.filter((node) => node.partId).map(({ id, label, partId }) => ({ id, label, partId })) || [],
    selectedReferences: model ? state.selectedIds.map((id) => ({
      id,
      reference: createReference(model, id, state.selectedFace?.nodeId === id ? state.selectedFace.faceId : null, state.selectedEdge?.nodeId === id ? state.selectedEdge.edgeId : null),
      text: formatSelection(model, id, state.selectedFace?.nodeId === id ? state.selectedFace.faceId : null, state.selectedEdge?.nodeId === id ? state.selectedEdge.edgeId : null),
    })) : [],
    limitations: ["Snapshot loading; no file watcher", "Visual spacing, not a disassembly simulation"],
  });

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

  async function demoFile() {
    const target = path.join(runtimeRoot, "demo-assembly.step");
    try { await stat(target); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await python("create_demo.py", ["--output", target]);
    }
    return target;
  }

  async function loadFile(target, displayName, internal = false) {
    if (closed) throw new PrototypeError("closed", "Prototype has closed", 410);
    const resolved = await realpath(target);
    if ((!internal && !isInside(project, resolved)) ||
        (internal && !isInside(await realpath(runtimeRoot), resolved))) {
      throw new PrototypeError("outside_project", "STEP must be inside the selected project root", 403);
    }
    if (![".step", ".stp"].includes(path.extname(resolved).toLowerCase())) throw new PrototypeError("not_step", "Choose a .step or .stp file");
    const info = await stat(resolved);
    if (!info.isFile() || info.size > maxStepBytes) throw new PrototypeError("too_large", "Choose a STEP file smaller than 100 MB", 413);
    await commit({ loading: true, error: "" });
    try {
      const bytes = await readFile(resolved);
      if (bytes.length > maxStepBytes) throw new PrototypeError("too_large", "STEP file exceeds 100 MB", 413);
      const sourceHash = hash(bytes);
      const snapshot = path.join(uploadDir, `${sourceHash}.step`);
      await writeFile(snapshot, bytes);
      const output = path.join(modelDir, `${sourceHash}.${randomUUID()}.json`);
      await python("convert.py", [snapshot, "--output", output]);
      if ((await stat(output)).size > maxJsonBytes) throw new PrototypeError("model_too_large", "Converted mesh exceeds the viewer's size limit", 413);
      const loaded = validateModel(JSON.parse(await readFile(output, "utf8")), { requireRevision: false });
      loaded.warnings = importWarnings(loaded.warnings);
      await unlink(output);
      if (loaded.source.sha256 !== sourceHash) throw new PrototypeError("revision_mismatch", "Converted model does not match the STEP snapshot", 422);
      loaded.source.name = displayName || path.basename(resolved);
      loaded.topologyRevision = topologyRevision(loaded);
      const cache = `${loaded.topologyRevision}.json`;
      try {
        const cached = validateModel(JSON.parse(await readFile(path.join(modelDir, cache), "utf8")));
        if (cached.topologyRevision !== loaded.topologyRevision) throw new PrototypeError("cache_mismatch", "Cached geometry identity does not match", 422);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await atomicJson(path.join(modelDir, cache), loaded);
      }
      model = loaded;
      modelCache = cache;
      inputFile = snapshot;
      inputName = loaded.source.name;
      lastRendered = null;
      await commit({ ...initialState(), autoCopy: state.autoCopy, documentRevision: sourceHash, topologyRevision: loaded.topologyRevision, modelName: inputName, fitNonce: state.fitNonce + 1 });
      return state;
    } catch (error) {
      await commit({ loading: false, error: publicError(error) });
      throw error;
    }
  }

  function waitForRender(revision) {
    if (revision !== state.revision) return Promise.reject(new PrototypeError("superseded_view", "A newer view command superseded this one", 409));
    if (lastRendered?.revision === revision && lastRendered.topologyRevision === state.topologyRevision) return Promise.resolve(lastRendered);
    return new Promise((resolve, reject) => {
      const waiter = { revision, topologyRevision: state.topologyRevision, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        renderWaiters.delete(waiter);
        reject(new PrototypeError("renderer_timeout", "The view was saved, but no visible renderer acknowledged it. Open the canvas and retry.", 408));
      }, 12_000);
      renderWaiters.add(waiter);
    });
  }

  async function execute(name, input = {}, { rendered = false } = {}) {
    if (name === "get_state") return getState();
    if (name === "inspect_reference") return inspectReference(input.reference);
    if (name === "prepare_clipboard_reference") return prepareClipboardReference(input.reference);
    if (name === "list_reviews") return reviews.list();
    if (name === "get_review") {
      const review = await reviews.get(input.id);
      return { ...review, image: { width: review.image.width, height: review.image.height }, drawing: { strokeCount: review.drawing.present.length } };
    }
    if (name === "add_reference_to_chat") {
      return enqueue(async () => {
        const attachment = composerAttachment(model, state, input.expectedRevision);
        if (!addReferenceToChat) throw new PrototypeError("no_composer", "This viewer has no Copilot message draft. Use Copy text under Reference text instead.", 409);
        await addReferenceToChat(attachment);
        return { added: true, title: attachment.title, sent: false };
      });
    }
    const changed = await enqueue(async () => {
      if (["open_review", "close_review", "save_camera"].includes(name) && input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
        throw new PrototypeError("stale_view", "The view changed. Read its current state and retry.", 409);
      }
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
        return commit({ camera: input.camera });
      }
      if (state.activeReviewId && name !== "set_auto_copy") {
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
    if (rendered && !["open_review", "close_review", "save_camera"].includes(name)) await waitForRender(changed.revision);
    return getState();
  }

  async function captureImage() {
    if (!model || state.loading) throw new PrototypeError("not_ready", "Wait for the model to finish loading", 409);
    const review = state.activeReviewId ? await reviews.get(state.activeReviewId) : null;
    if (!review) await waitForRender(state.revision);
    const id = randomUUID();
    const revision = state.revision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        captures.delete(id);
        reject(new PrototypeError("capture_timeout", "The canvas did not return an image", 408));
      }, 12_000);
      captures.set(id, { revision, reviewId: review?.id ?? null, reviewVersion: review?.version, resolve, reject, timer });
      emit("capture", { id, revision, reviewId: review?.id ?? null, reviewVersion: review?.version });
    });
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
      const pathname = new URL(req.url || "/", origin).pathname;
      const prefix = `/${token}/`;
      if (!pathname.startsWith(prefix)) throw new PrototypeError("forbidden", "Invalid Explorer capability", 403);
      const route = pathname.slice(prefix.length);
      if (route === "api/state" && req.method === "GET") return respond(200, getState());
      if (route === "api/model" && req.method === "GET") {
        if (!model) throw new PrototypeError("not_ready", "Model is not ready", 409);
        return respond(200, model);
      }
      if (route === "api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        res.on("close", () => { clients.delete(res); clearInterval(heartbeat); });
        return;
      }
      if (route === "api/command" && req.method === "POST") {
        const payload = await jsonBody(req);
        return respond(200, await execute(payload.name, payload.input));
      }
      if (route === "api/upload" && req.method === "POST") {
        const filename = decodeURIComponent(String(req.headers["x-file-name"] || ""));
        if (![".step", ".stp"].includes(path.extname(filename).toLowerCase())) throw new PrototypeError("not_step", "Choose a STEP file");
        const bytes = await body(req, maxStepBytes);
        const target = path.join(uploadDir, `${hash(bytes)}.step`);
        await writeFile(target, bytes);
        const loaded = await enqueue(() => {
          if (state.activeReviewId) throw new PrototypeError("review_active", "Return to the model before opening another STEP", 409);
          return loadFile(target, path.basename(filename), true);
        });
        return respond(200, loaded);
      }
      if (route === "api/rendered" && req.method === "POST") {
        const report = await jsonBody(req);
        const result = await enqueue(async () => {
        if (!Number.isInteger(report.revision) || report.modelHash !== state.documentRevision || report.topologyRevision !== state.topologyRevision) throw new PrototypeError("bad_render_report", "Renderer revision does not match the model", 409);
        if (report.revision !== state.revision) return { accepted: false, reason: "superseded_view" };
        if (report.camera && !state.activeReviewId) {
          validateCamera(report.camera);
          if ((report.camera.projection ?? "perspective") !== state.projection) throw new PrototypeError("bad_render_report", "Rendered projection does not match the view", 409);
          const next = { ...state, camera: report.camera };
          await atomicJson(stateFile, { state: next, modelCache, inputFile, inputName });
          state = next;
        }
        lastRendered = report;
        for (const waiter of [...renderWaiters]) {
          if (report.revision >= waiter.revision) {
            clearTimeout(waiter.timer); renderWaiters.delete(waiter);
            if (report.revision === waiter.revision && report.topologyRevision === waiter.topologyRevision) waiter.resolve(report);
            else waiter.reject(new PrototypeError("superseded_view", "A newer view command superseded this one", 409));
          }
        }
        return { accepted: true };
        });
        return respond(200, result);
      }
      if (route === "api/capture" && req.method === "POST") return respond(200, await captureImage());
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
        return respond(200, await prepareClipboardReference(payload.reference));
      }
      if (route === "api/add-reference" && req.method === "POST") {
        const payload = await jsonBody(req);
        return respond(200, await execute("add_reference_to_chat", { expectedRevision: payload.revision }));
      }
      if (route === "api/capture-result" && req.method === "POST") {
        const payload = await jsonBody(req, maxImageBytes * 1.5);
        const pending = captures.get(payload.id);
        if (!pending) throw new PrototypeError("unknown_capture", "Capture request is no longer active", 409);
        if (payload.error || payload.revision !== pending.revision || state.revision !== pending.revision) {
          clearTimeout(pending.timer); captures.delete(payload.id);
          pending.reject(new PrototypeError("capture_changed", payload.error || "View changed during capture", 409));
          return respond(409, { error: payload.error || "View changed during capture" });
        }
        if (pending.reviewId) {
          try {
            const result = await enqueue(() => reviews.saveImage(pending.reviewId, pending.reviewVersion, payload.dataUrl));
            clearTimeout(pending.timer); captures.delete(payload.id); pending.resolve(result);
            return respond(200, { saved: true });
          } catch (error) {
            clearTimeout(pending.timer); captures.delete(payload.id); pending.reject(error);
            throw error;
          }
        }
        if (typeof payload.dataUrl !== "string" || !payload.dataUrl.startsWith("data:image/png;base64,")) throw new PrototypeError("invalid_image", "Expected a PNG image");
        const bytes = Buffer.from(payload.dataUrl.slice("data:image/png;base64,".length), "base64");
        if (bytes.length > maxImageBytes || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new PrototypeError("invalid_image", "Invalid or oversized PNG");
        const imagePath = path.join(captureDir, `${payload.id}.png`);
        if (payload.camera) validateCamera(payload.camera);
        const result = {
          path: imagePath, revision: state.revision, documentRevision: state.documentRevision, topologyRevision: state.topologyRevision,
          exploded: state.explode, selectedIds: state.selectedIds, selectedFace: state.selectedFace,
          selectedEdge: state.selectedEdge,
          camera: payload.camera ?? state.camera, appearance: state.appearance, materialFinish: state.materialFinish, showEdges: state.showEdges,
        };
        await writeFile(imagePath, bytes);
        await atomicJson(`${imagePath}.json`, result);
        clearTimeout(pending.timer); captures.delete(payload.id); pending.resolve(result);
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  async function initialize() {
    try {
      if (file) await execute("load_file", { file });
      else if (saved?.modelCache && /^[a-f0-9]{64}\.json$/.test(saved.modelCache)) {
        const cached = JSON.parse(await readFile(path.join(modelDir, saved.modelCache), "utf8"));
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
          model.warnings = importWarnings(model.warnings);
          modelCache = saved.modelCache;
          inputFile = saved.inputFile;
          inputName = saved.inputName || state.modelName || model.source.name;
          model.source = { ...model.source, name: inputName };
          await commit({ loading: false, error: "", modelName: inputName, topologyRevision: model.topologyRevision });
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
    initialize: () => initialization ??= initialize(),
    execute,
    getState,
    captureImage,
    close() {
      if (closing) return closing;
      closed = true;
      for (const child of children) child.kill();
      for (const client of clients) client.end();
      for (const waiter of renderWaiters) { clearTimeout(waiter.timer); waiter.reject(new PrototypeError("closed", "Canvas closed", 410)); }
      for (const pending of captures.values()) { clearTimeout(pending.timer); pending.reject(new PrototypeError("closed", "Canvas closed", 410)); }
      closing = (async () => {
        try {
          await initialization;
          await queue.catch((error) => { log(`Explorer pending operation ended during close: ${publicError(error)}`); });
        } finally {
          server.closeAllConnections();
          try { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
          finally { await releaseOwner(); }
        }
      })();
      return closing;
    },
  };
}
