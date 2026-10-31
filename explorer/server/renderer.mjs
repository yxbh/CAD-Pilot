import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
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

/**
 * One background Chromium page that draws the same viewer as the user's tab, so loads, render acknowledgements and
 * captures never depend on a visible or focused tab. It starts on demand and stops after idling. The debugging pipe
 * is held open but unused: Chromium exits by itself when this process ends, however it ends.
 */
export function createHeadlessRenderer({ url, log = () => {}, idleMs = 10 * 60_000, find = findChromium, launch = spawn, onExit = () => {} }) {
  let child = null;
  let starting = null;
  let profile = null;
  let software = false;
  let idle = null;
  let closed = false;
  let stderr = "";

  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { void stop(); }, idleMs);
    idle.unref?.();
  };
  async function stop() {
    clearTimeout(idle);
    const running = child;
    child = null;
    if (running && running.exitCode === null) {
      const exited = new Promise((resolve) => running.once("exit", resolve));
      running.kill();
      // A browser wedged by its GPU process may ignore the polite signal.
      const force = setTimeout(() => running.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    profile = null;
  }
  async function start() {
    const executable = await find();
    profile = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-renderer-"));
    stderr = "";
    const browser = launch(executable, [
      "--headless", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1280,800",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      ...(software ? softwareFlags : gpuFlags[process.platform] ?? []),
      `${url}?renderer=headless`,
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    child = browser;
    browser.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    browser.once("exit", (code, signal) => {
      if (child !== browser) return;
      child = null;
      const detail = stderr.trim().split(/\r?\n/).filter((line) => !/CVDisplayLink|GPU stall/.test(line)).at(-1) || `exit ${code ?? signal}`;
      log(`Explorer headless renderer stopped: ${detail}`);
      onExit(new PrototypeError("renderer_failed", `The headless renderer stopped (${detail})`, 503));
    });
    try {
      await new Promise((resolve, reject) => {
        browser.once("spawn", resolve);
        browser.once("error", (error) => reject(new PrototypeError("renderer_failed", `Headless renderer did not start: ${error.message}`, 503)));
      });
    } catch (error) {
      child = null;
      await stop();
      throw error;
    }
  }

  return {
    get running() { return !!child; },
    async ensure() {
      if (closed) throw new PrototypeError("closed", "Explorer is closing", 410);
      touch();
      if (child) return;
      starting ??= start().finally(() => { starting = null; });
      return starting;
    },
    touch,
    // A page that could not create a WebGL context restarts once with software rendering.
    async fallBack() {
      if (software || closed) return false;
      software = true;
      log("Explorer headless renderer: hardware WebGL is unavailable; retrying with software rendering.");
      await stop();
      await this.ensure();
      return true;
    },
    // A page that failed for good is stopped, so the next request starts a fresh one instead of waiting on it.
    async stop() {
      await starting?.catch(() => {});
      await stop();
    },
    async close() {
      closed = true;
      await starting?.catch(() => {});
      await stop();
    },
  };
}
