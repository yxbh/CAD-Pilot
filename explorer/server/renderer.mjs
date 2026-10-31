import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrototypeError } from "./protocol.mjs";

const missing = "Headless rendering needs Playwright's Chromium. In the workbench, run: uv run python -m playwright install chromium";

function playwrightBrowsers({ env, platform, home }) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "ms-playwright");
  if (platform === "darwin") return path.posix.join(home, "Library", "Caches", "ms-playwright");
  return path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, ".cache"), "ms-playwright");
}

// The workbench setup installs Playwright's browsers; its small headless shell is all the renderer needs.
export async function findChromium({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.CAD_EXPLORER_CHROMIUM) return env.CAD_EXPLORER_CHROMIUM;
  const root = playwrightBrowsers({ env, platform, home });
  const installs = (await readdir(root).catch(() => []))
    .map((name) => /^chromium_headless_shell-(\d+)$/.exec(name)).filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [name] of installs) {
    for (const folder of (await readdir(path.join(root, name)).catch(() => [])).filter((entry) => entry.startsWith("chrome-headless-shell-"))) {
      const executable = path.join(root, name, folder, platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
      if (await access(executable).then(() => true, () => false)) return executable;
    }
  }
  throw new PrototypeError("renderer_missing", missing, 503);
}

// Hardware WebGL where the platform's ANGLE backend is dependable; software WebGL is the fallback when it is not.
const gpuFlags = { darwin: ["--use-angle=metal"], win32: ["--use-angle=d3d11"] };
const softwareFlags = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const profilePrefix = "cad-explorer-renderer-";

// A viewer killed outright cannot remove its renderer's profile; the next renderer removes profiles whose owner is gone.
export async function sweepProfiles(root = os.tmpdir(), alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}) {
  for (const name of (await readdir(root).catch(() => [])).filter((entry) => entry.startsWith(profilePrefix))) {
    const owner = Number(await readFile(path.join(root, name, "owner"), "utf8").catch(() => ""));
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

// Commands over Chromium's debugging pipe: NUL-terminated JSON on fds 3 (to the browser) and 4 (from it).
function devtools(browser) {
  const pending = new Map();
  let buffer = "";
  let next = 0;
  browser.stdio[4].on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(text); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  return (method, params = {}, timeout = 15_000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`);
  });
}

// Why a renderer stopped: its exit status, and the last error Chromium printed (page console output is not a reason).
function stopReason(code, signal, stderr) {
  const status = signal ? `signal ${signal}` : `exit code ${code}`;
  const error = stderr.split(/\r?\n/).filter((line) => /ERROR|FATAL/.test(line) && !/CONSOLE|CVDisplayLink|GPU stall/.test(line)).at(-1);
  return error ? `${status}: ${error.replace(/^\[[^\]]*\]\s*/, "").slice(0, 300)}` : status;
}

/**
 * One background Chromium page that draws the same viewer as the user's tab, so loads, render acknowledgements and
 * captures never depend on a visible or focused tab. It starts on demand and stops after idling. Chromium starts on a
 * blank page and opens the viewer over its debugging pipe, so the capability URL never appears in its command line,
 * and it exits by itself when this process ends, however it ends. Each browser has its own temporary profile.
 */
export function createHeadlessRenderer({ url, log = () => {}, idleMs = 2 * 60_000, find = findChromium, launch = spawn, onExit = () => {}, tmp = os.tmpdir() }) {
  let child = null;
  let starting = null;
  let stopping = null;
  let software = false;
  let idle = null;
  let closed = false;

  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { void halt(); }, idleMs);
    idle.unref?.();
  };
  // An intentional stop: the browser's exit is expected, so it is not reported as a failure.
  async function stop(browser) {
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill();
      // A browser wedged by its GPU process may ignore the polite signal.
      const force = setTimeout(() => browser.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    await rm(browser.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  function halt() {
    clearTimeout(idle);
    const running = child;
    child = null;
    if (!running) return stopping ?? Promise.resolve();
    stopping = stop(running).finally(() => { stopping = null; });
    return stopping;
  }
  async function start() {
    await stopping;
    const executable = await find();
    await sweepProfiles(tmp);
    const profile = await mkdtemp(path.join(tmp, profilePrefix));
    await writeFile(path.join(profile, "owner"), String(process.pid));
    let stderr = "";
    const browser = launch(executable, [
      "--headless", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1280,800",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      ...(software ? softwareFlags : gpuFlags[process.platform] ?? []),
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    browser.profile = profile;
    child = browser;
    browser.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
    browser.once("exit", (code, signal) => {
      void rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      if (child !== browser) return;
      child = null;
      const reason = stopReason(code, signal, stderr);
      log(`Explorer headless renderer stopped: ${reason}`);
      onExit(new PrototypeError("renderer_failed", `The headless renderer stopped (${reason})`, 503));
    });
    try {
      await new Promise((resolve, reject) => {
        browser.once("spawn", resolve);
        browser.once("error", (error) => reject(new PrototypeError("renderer_failed", `Headless renderer did not start: ${error.message}`, 503)));
      });
      await devtools(browser)("Target.createTarget", { url: `${url}?renderer=headless` }).catch((error) => {
        throw new PrototypeError("renderer_failed", `Headless renderer did not open the viewer: ${error.message}`, 503);
      });
    } catch (error) {
      if (child === browser) child = null;
      await stop(browser);
      throw error;
    }
  }

  return {
    get running() { return !!child; },
    async ensure() {
      if (closed) throw new PrototypeError("closed", "Explorer is closing", 410);
      touch();
      if (child && !starting) return;
      starting ??= start().finally(() => { starting = null; });
      return starting;
    },
    touch,
    // A page that could not create a WebGL context restarts once with software rendering.
    async fallBack() {
      if (software || closed) return false;
      software = true;
      log("Explorer headless renderer: hardware WebGL is unavailable; retrying with software rendering.");
      await starting?.catch(() => {});
      await halt();
      await this.ensure();
      return true;
    },
    // A page that failed for good is stopped, so the next request starts a fresh one instead of waiting on it. With no
    // start in progress the stop begins at once, so a later ensure() waits for it and starts a new browser.
    async stop() {
      if (starting) await starting.catch(() => {});
      return halt();
    },
    async close() {
      closed = true;
      if (starting) await starting.catch(() => {});
      return halt();
    },
  };
}
