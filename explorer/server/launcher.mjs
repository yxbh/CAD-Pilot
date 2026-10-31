import { spawn } from "node:child_process";
import { closeSync, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { endpointFile, probeEndpoint, readEndpoint } from "./endpoint.mjs";
import { canonicalProjectRoot, explorerRoot, userRuntimeRoot } from "./paths.mjs";
import { PrototypeError } from "./protocol.mjs";
import { viewKeyFor } from "./server.mjs";

export const defaultViewId = "standalone";
const standaloneScript = path.join(explorerRoot, "server", "standalone.mjs");
const maxLogBytes = 1024 * 1024;

// key=value pairs avoid shell-specific JSON quoting (Windows PowerShell strips embedded quotes). Values that parse
// as JSON (numbers, booleans, arrays) keep that type; anything else is a string.
export function actionInput(args) {
  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try { return JSON.parse(args[0]); }
    catch { throw new PrototypeError("bad_arguments", "Action input must be key=value pairs or one JSON object"); }
  }
  const input = {};
  for (const pair of args) {
    const split = pair.indexOf("=");
    if (split < 1) throw new PrototypeError("bad_arguments", `Expected key=value, got "${pair}"`);
    const value = pair.slice(split + 1);
    try { input[pair.slice(0, split)] = JSON.parse(value); }
    catch { input[pair.slice(0, split)] = value; }
  }
  return input;
}

// Without the built page a viewer would answer with an error page, so fail before handing out a URL.
export async function assertBuilt(index = path.join(explorerRoot, "dist", "index.html")) {
  try { await access(index); }
  catch {
    throw new PrototypeError("not_built", "CAD Explorer is not built. In the workbench, run: npm --prefix explorer install, then npm --prefix explorer run build", 503);
  }
}

// The user's local Explorer data by default; CAD_EXPLORER_RUNTIME_ROOT relocates it, for example to isolate test runs.
export async function locateView({ projectRoot = process.cwd(), viewId = defaultViewId, runtimeRoot = userRuntimeRoot() } = {}) {
  if (typeof viewId !== "string" || !viewId.length || viewId.length > 80) throw new PrototypeError("bad_view_id", "The view name must contain 1 to 80 characters");
  // realpath returns the canonical spelling (including case on Windows), matching the server's view key.
  const project = await canonicalProjectRoot(projectRoot);
  const viewKey = viewKeyFor(project, viewId);
  return {
    project, viewId, runtimeRoot,
    endpoint: endpointFile(runtimeRoot, viewKey),
    log: path.join(runtimeRoot, "views", `${viewKey}.log`),
  };
}

export async function runningViewer(location) {
  const record = await readEndpoint(location.endpoint);
  const state = record && await probeEndpoint(record);
  return state ? { record, state } : null;
}

// A viewer that holds the setup's lease publishes its address right after it starts listening.
export async function waitForViewer(location, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const running = await runningViewer(location);
    if (running || Date.now() > deadline) return running;
    await delay(150);
  }
}

export async function call(record, route, body) {
  let response;
  try {
    response = await fetch(`${record.url}${route}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new PrototypeError("not_running", "The Explorer viewer stopped responding. Run open again.", 503);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PrototypeError(result.code || "explorer_error", result.error || `Explorer request failed with HTTP ${response.status}`, response.status);
  return result;
}

export const sendCommand = (record, name, input = {}, options = {}) => call(record, "api/command", { name, input, ...options });

// Startup restores the saved setup or loads the requested file; a reload must not race it.
export async function waitForLoad(record, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await call(record, "api/state");
    if ((state.initialized && !state.loading) || Date.now() > deadline) return state;
    await delay(250);
  }
}

export async function reloadInto(record, file, options = {}) {
  await waitForLoad(record);
  return sendCommand(record, "load_file", { ...options, file });
}

// The viewer outlives the command (and the chat session) that started it, so its links stay valid. Its log
// can contain the tokened URL, so it is owner-only; concurrent starts append rather than truncate each other.
export function spawnDetached(location, file, options = {}) {
  mkdirSync(path.dirname(location.log), { recursive: true });
  const output = openSync(location.log, "a", 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(output, 0o600);
    if (fstatSync(output).size > maxLogBytes) ftruncateSync(output, 0);
    const logStart = fstatSync(output).size;
    const optionArgs = Object.entries(options).map(([key, value]) => `${key}=${value}`);
    const child = spawn(process.execPath, [standaloneScript, ...(file ? [file, ...optionArgs] : [])], {
      cwd: location.project, detached: true, windowsHide: true, stdio: ["ignore", output, output],
      env: { ...process.env, CAD_EXPLORER_VIEW: location.viewId, CAD_EXPLORER_RUNTIME_ROOT: location.runtimeRoot },
    });
    child.unref();
    return { child, logStart };
  } finally { closeSync(output); }
}

function lastLogLine(location, start) {
  let descriptor;
  try {
    descriptor = openSync(location.log, "r");
    const length = Math.max(0, fstatSync(descriptor).size - start);
    const buffer = Buffer.alloc(Math.min(length, 64 * 1024));
    readSync(descriptor, buffer, 0, buffer.length, start);
    return buffer.toString("utf8").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  } catch { return ""; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function waitForStart(location, { child, logStart }, timeout, handoverTimeout) {
  let exited = null;
  child.once("exit", (code) => { exited = code ?? 1; });
  let deadline = Date.now() + timeout;
  let handingOver = false;
  while (Date.now() < deadline) {
    const running = await runningViewer(location);
    // Another viewer won the start; ours waits for it to finish loading, then reloads the file there.
    if (running && running.record.pid !== child.pid && !handingOver) {
      handingOver = true;
      deadline = Date.now() + handoverTimeout;
    }
    // Exit code 0 means the new process found another live viewer for this setup and handed over to it.
    if (running && (running.record.pid === child.pid || exited === 0)) return { ...running, started: running.record.pid === child.pid };
    if (exited !== null && exited !== 0) throw new PrototypeError("start_failed", lastLogLine(location, logStart) || `The Explorer viewer exited with code ${exited}`, 500);
    await delay(150);
  }
  throw new PrototypeError("start_timeout", `The Explorer viewer did not start. See ${location.log}`, 504);
}

// The store is shared by every workbench checkout, so a project's running viewer may run another checkout's code.
// A checkout is compared by its canonical path: the same folder reached through a link or spelled in another case
// (macOS and Windows folders ignore case) is the same checkout.
const canonicalCheckout = (root) => {
  try { return realpathSync.native(root); }
  catch { return root; }
};
export const foreignCheckout = (record, checkout = explorerRoot) => typeof record.explorerRoot !== "string"
  || canonicalCheckout(record.explorerRoot) !== canonicalCheckout(checkout);

// options are load_file's mesh inputs (units, up); they only apply with a file.
export async function openViewer(location, file, options = {}, { spawnViewer = spawnDetached, startTimeout = 30_000, loadTimeout = 150_000, distIndex, checkout = explorerRoot } = {}) {
  await assertBuilt(distIndex);
  let running = await runningViewer(location);
  let started = false;
  let replaced;
  // Restart it from this checkout; it keeps its address, so an open page reconnects to the new viewer.
  if (running && foreignCheckout(running.record, checkout)) {
    replaced = running.record.explorerRoot ?? "an earlier workbench version";
    await stopViewer(location);
    running = null;
  }
  if (running) {
    if (file) await reloadInto(running.record, file, options);
  } else {
    // A process that hands over to a concurrently started viewer has already reloaded the file there.
    ({ started, ...running } = await waitForStart(location, spawnViewer(location, file, options), startTimeout, loadTimeout * 2));
  }
  await waitForLoad(running.record, loadTimeout);
  // A view counts as shown once a renderer has drawn it: the person's page, or the background renderer.
  const shown = await call(running.record, "api/confirm", {});
  return { started, reloaded: !started && !!file, pid: running.record.pid, ...(replaced ? { replaced } : {}), ...shown };
}

export async function stopViewer(location, { timeout = 10_000 } = {}) {
  const running = await runningViewer(location);
  if (!running) return { stopped: false, running: false };
  await call(running.record, "api/shutdown", {});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await probeEndpoint(running.record, { timeout: 500 }))) return { stopped: true, url: running.record.url };
    await delay(150);
  }
  throw new PrototypeError("stop_timeout", "The Explorer viewer did not stop in time", 504);
}
