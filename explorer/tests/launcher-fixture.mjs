import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workbenchPython } from "../server/paths.mjs";
import { assertBuilt } from "../server/launcher.mjs";
import { demoTemplate } from "./browser-fixture.mjs";

const cli = fileURLToPath(new URL("../scripts/explorer.mjs", import.meta.url));

export function exec(script, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

// The four corner pixels, which a capture's backdrop fills.
export async function corners(file) {
  const { stdout } = await promisify(execFile)(workbenchPython, ["-c", "import sys; from PIL import Image; i = Image.open(sys.argv[1]).convert('RGB'); w, h = i.size; [print(*i.getpixel(p)) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]", file]);
  return stdout.trim().split("\n").map((line) => line.split(" ").map(Number));
}

// The width in pixels of everything drawn over the backdrop that fills the top-left pixel.
export async function drawnWidth(file) {
  const { stdout } = await promisify(execFile)(workbenchPython, ["-c", "import sys; from PIL import Image, ImageChops; i = Image.open(sys.argv[1]).convert('RGB'); box = ImageChops.difference(i, Image.new('RGB', i.size, i.getpixel((0, 0)))).getbbox(); print(box[2] - box[0])", file]);
  return Number(stdout);
}

export async function pngSize(file) {
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

// Real background viewers and the real background renderer in a disposable runtime; no viewer page is ever opened,
// so every view is confirmed and captured by the headless renderer alone. The runtime starts with the test process's
// demo, as a browser test's does.
export async function launcherFixture(t) {
  await assertBuilt();
  const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-launcher-")));
  await cp(await demoTemplate(), runtimeRoot, { recursive: true });
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad design ")));
  const env = { ...process.env, CAD_EXPLORER_RUNTIME_ROOT: runtimeRoot };
  delete env.CAD_EXPLORER_VIEW;
  const explorer = (...args) => exec(cli, args, { cwd: project, env });
  t.after(async () => {
    await explorer("stop");
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { runtimeRoot, project, env, explorer };
}
