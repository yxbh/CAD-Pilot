import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workbenchPython } from "../server/paths.mjs";
import { readEndpoint } from "../server/endpoint.mjs";
import { assertBuilt, locateView } from "../server/launcher.mjs";
import { revisionLabel } from "../server/summary.mjs";

const cli = fileURLToPath(new URL("../scripts/explorer.mjs", import.meta.url));
const standalone = fileURLToPath(new URL("../server/standalone.mjs", import.meta.url));

function exec(script, args, options) {
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
async function corners(file) {
  const { stdout } = await promisify(execFile)(workbenchPython, ["-c", "import sys; from PIL import Image; i = Image.open(sys.argv[1]).convert('RGB'); w, h = i.size; [print(*i.getpixel(p)) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]", file]);
  return stdout.trim().split("\n").map((line) => line.split(" ").map(Number));
}

// The width in pixels of everything drawn over the backdrop that fills the top-left pixel.
async function drawnWidth(file) {
  const { stdout } = await promisify(execFile)(workbenchPython, ["-c", "import sys; from PIL import Image, ImageChops; i = Image.open(sys.argv[1]).convert('RGB'); box = ImageChops.difference(i, Image.new('RGB', i.size, i.getpixel((0, 0)))).getbbox(); print(box[2] - box[0])", file]);
  return Number(stdout);
}

async function pngSize(file) {
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

// Real background viewers and the real background renderer in a disposable runtime; no viewer page is ever opened,
// so every view here is confirmed and captured by the headless renderer alone.
async function launcherFixture(t) {
  await assertBuilt();
  const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-launcher-")));
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

test("open confirms each view without a tab, reloads in place keeping the view and keeps its address", { timeout: 240_000 }, async (t) => {
  const { runtimeRoot, project, env, explorer } = await launcherFixture(t);
  const first = await explorer("open");
  assert.equal(first.code, 0, first.stderr);
  const opened = first.json();
  assert.equal(opened.started, true);
  assert.equal(opened.model.name, "Demo assembly.step");
  assert.equal(opened.error, undefined);
  assert.deepEqual(opened.shown, { viewers: 0, seen: false, drawn: "headless", headless: true });
  // The camera that drew the view, in the shape render reports.
  const { viewHeight, ...camera } = opened.view.camera;
  assert.deepEqual(camera, { view: "iso", projection: "perspective" });
  assert.ok(viewHeight > 0, `viewHeight ${viewHeight}`);
  assert.match(opened.note, /No viewer page is open; the view was drawn in the background/);
  assert.ok(opened.note.includes(opened.url));
  const location = await locateView({ projectRoot: project, runtimeRoot });
  const record = await readEndpoint(location.endpoint);
  assert.deepEqual([record.url, record.pid], [opened.url, opened.pid]);

  await mkdir(path.join(project, "parts"));
  await copyFile(path.join(runtimeRoot, "demo-assembly.step"), path.join(project, "parts", "demo copy.step"));
  const loaded = (await explorer("open", "parts/demo copy.step")).json();
  assert.equal(loaded.model.file, "parts/demo copy.step");
  assert.equal(loaded.model.revision.length, 12);
  assert.ok(Date.parse(loaded.model.generatedAt) > 0);
  const sectioned = (await explorer("do", "set_section", "enabled=true", "axis=y")).json();
  assert.equal(sectioned.view.section.axis, "y");
  const exploded = (await explorer("do", "set_explode", "amount=0.3")).json();
  assert.equal(exploded.view.explode.amount, 0.3);
  assert.equal(exploded.shown.drawn, null, "do answers before any renderer has drawn the change");
  assert.ok(JSON.stringify(exploded).length < 1500, "do answers with a compact summary");

  // A regenerated STEP with the same assembly tree keeps the cutaway and the explosion.
  const reopened = (await explorer("open", "parts/demo copy.step")).json();
  assert.deepEqual([reopened.url, reopened.started, reopened.reloaded], [opened.url, false, true]);
  assert.equal(reopened.view.kept, true);
  assert.equal(reopened.view.section.axis, "y");
  assert.equal(reopened.view.explode.amount, 0.3);
  assert.equal(reopened.shown.drawn, "headless");
  assert.ok(reopened.view.revision > exploded.view.revision);

  // Running the human-facing command again hands over instead of failing on the view lease.
  const second = await exec(standalone, ["parts/demo copy.step"], { cwd: project, env });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.stdout.trim().split("\n"), [opened.url, "Reloaded: demo copy.step"]);

  const angled = (await explorer("do", "set_view", "azimuth=45", "elevation=32")).json().view.camera;
  assert.deepEqual([angled.view, angled.projection], ["45:32", "perspective"]);
  const summary = (await explorer("state")).json();
  assert.equal(summary.model.name, "demo copy.step");
  assert.equal(summary.parts, undefined, "the summary leaves out the part list");
  const full = (await explorer("state", "--full")).json();
  assert.equal(revisionLabel(full.documentRevision), summary.model.revision);
  assert.equal(full.renderers.viewers, 0);
  assert.ok(JSON.stringify(full).length > JSON.stringify(summary).length);
  const unknown = await explorer("do", "spin");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown view action "spin"/);
  assert.match((await explorer("do", "set_view", "top")).stderr, /Expected key=value/);

  const reference = `cadproto:v2:${full.topologyRevision}/${encodeURIComponent(full.parts[0].id)}/part`;
  const inspected = await explorer("inspect", `CAD Explorer | demo copy.step | ${full.parts[0].label} | Whole part\n${reference}`);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(inspected.json().occurrence.id, full.parts[0].id);
  const copied = await (await fetch(opened.url + "api/clipboard-reference", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference }),
  })).json();
  // Identical bytes share one cached snapshot, which keeps the source name it was first imported with.
  assert.equal(copied.text, `CAD Explorer | Demo assembly.step | ${full.parts[0].label} | Whole part\n${reference}`, "Standalone viewers copy readable text, not Copilot chips");

  assert.equal((await explorer("stop")).json().stopped, true);
  const stopped = await explorer("state");
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /No Explorer viewer is running/);
  assert.deepEqual((await explorer("stop")).json(), { stopped: false, running: false });

  const restarted = (await explorer("open")).json();
  assert.equal(restarted.started, true);
  assert.equal(restarted.url, opened.url, "A restarted viewer keeps its port and token so earlier links still work");
  assert.equal(restarted.model.name, "demo copy.step");
});

test("capture draws in the background into the project at any size and rejects other paths", { timeout: 240_000 }, async (t) => {
  const { explorer, project } = await launcherFixture(t);
  assert.equal((await explorer("open")).code, 0);
  const captured = await explorer("capture", "reviews/view.png");
  assert.equal(captured.code, 0, captured.stderr);
  assert.equal(captured.json().saved, "reviews/view.png");
  assert.deepEqual(await pngSize(path.join(project, "reviews", "view.png")), [1280, 800]);
  const small = (await explorer("capture", "reviews/small.png", "--size", "320x200", "--background", "#ffffff")).json();
  assert.deepEqual([small.width, small.height], [320, 200]);
  assert.deepEqual(await pngSize(path.join(project, "reviews", "small.png")), [320, 200]);
  // Simultaneous captures take turns, each with its own size and backdrop.
  const [red, blue] = await Promise.all([
    explorer("capture", "reviews/red.png", "--size", "64x48", "--background", "#ff0000"),
    explorer("capture", "reviews/blue.png", "--size", "96x64", "--background", "#0000ff"),
  ]);
  assert.equal(red.code, 0, red.stderr);
  assert.equal(blue.code, 0, blue.stderr);
  assert.deepEqual(await pngSize(path.join(project, "reviews", "red.png")), [64, 48]);
  assert.deepEqual(await pngSize(path.join(project, "reviews", "blue.png")), [96, 64]);
  assert.deepEqual(await corners(path.join(project, "reviews", "red.png")), Array(4).fill([255, 0, 0]));
  assert.deepEqual(await corners(path.join(project, "reviews", "blue.png")), Array(4).fill([0, 0, 255]));
  // An unchanged view captured again reuses its stored image.
  assert.equal((await explorer("capture")).json().path, captured.json().path);
  const outside = await explorer("capture", "../outside.png");
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /inside the project/);
  if (process.platform !== "win32") {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-elsewhere-"));
    t.after(() => rm(elsewhere, { recursive: true, force: true }));
    await symlink(elsewhere, path.join(project, "linked"));
    const linked = await explorer("capture", "linked/view.png");
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /inside the project/);
  }
});

test("render writes a STEP's image without touching the project's viewer or saved setups and reports the camera it drew", { timeout: 240_000 }, async (t) => {
  const { explorer, project, runtimeRoot } = await launcherFixture(t);
  const opened = (await explorer("open")).json();
  await copyFile(path.join(runtimeRoot, "demo-assembly.step"), path.join(project, "demo.step"));
  const views = await readdir(path.join(runtimeRoot, "views"));
  const rendered = await explorer("render", "demo.step", "docs/demo.png", "--size", "400x300", "--view", "30:20",
    "--section", "y", "--appearance", "studio", "--background", "#f2f1ec");
  assert.equal(rendered.code, 0, rendered.stderr);
  const result = rendered.json();
  assert.deepEqual([result.saved, result.width, result.height, result.camera.view, result.camera.projection], ["docs/demo.png", 400, 300, "30:20", "perspective"]);
  assert.equal(result.section.axis, "y");
  assert.deepEqual(await pngSize(path.join(project, "docs", "demo.png")), [400, 300]);
  // A custom background replaces Studio's floor too: seen from above, the floor would fill the bottom corners.
  assert.deepEqual(await corners(path.join(project, "docs", "demo.png")), Array(4).fill([242, 241, 236]));
  assert.deepEqual(await readdir(path.join(runtimeRoot, "views")), views, "a one-shot render saves no setup");
  assert.ok((await readdir(runtimeRoot)).includes(".pruned"), "a one-shot render prunes the store it imported into");
  const state = (await explorer("state")).json();
  assert.deepEqual([state.view.revision, state.view.section, state.model.name], [opened.view.revision, "off", "Demo assembly.step"]);
  // Hidden parts are named as in sequences: a group's label covers its parts.
  const grouped = await explorer("render", "demo.step", "docs/hidden.png", "--size", "200x150", "--hide", "Four spacers");
  assert.equal(grouped.code, 0, grouped.stderr);
  const missing = await explorer("render", "demo.step", "docs/hidden.png", "--hide", "Base plate,no such part");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No part or group label matches no such part/);
  const everything = await explorer("render", "demo.step", "docs/hidden.png", "--hide", "*");
  assert.equal(everything.code, 1);
  assert.match(everything.stderr, /would hide every part/);
  // An orthographic render shows viewHeight / height millimetres per pixel at any size: seen from the front, the demo's
  // base plate (python/create_demo.py BASE_WIDTH) is its widest part, 100 mm across.
  const scales = [];
  for (const size of ["400x300", "800x600"]) {
    const front = await explorer("render", "demo.step", "docs/front.png", "--size", size, "--view", "front", "--projection", "orthographic", "--background", "#ffffff");
    assert.equal(front.code, 0, front.stderr);
    const { camera, height } = front.json();
    assert.deepEqual(Object.keys(camera).sort(), ["projection", "view", "viewHeight"]);
    assert.deepEqual([camera.view, camera.projection], ["front", "orthographic"]);
    const pixel = camera.viewHeight / height;
    const millimetres = await drawnWidth(path.join(project, "docs", "front.png")) * pixel;
    assert.ok(Math.abs(millimetres - 100) <= 2 * pixel, `${size}: ${millimetres} mm drawn at ${pixel} mm per pixel`);
    scales.push(pixel);
  }
  assert.ok(Math.abs(scales[0] / scales[1] - 2) < 1e-9, "twice the size, half the millimetres per pixel");
  // An orthographic view is fitted to the image the same way at the default size as at a requested one of the same shape.
  const fitted = [];
  for (const size of [[], ["--size", "640x400"]]) {
    const ortho = await explorer("render", "demo.step", "docs/ortho.png", ...size, "--projection", "orthographic", "--background", "#ffffff");
    assert.equal(ortho.code, 0, ortho.stderr);
    const { camera, width } = ortho.json();
    fitted.push({ viewHeight: camera.viewHeight, drawn: await drawnWidth(path.join(project, "docs", "ortho.png")) / width });
  }
  assert.ok(Math.abs(fitted[0].viewHeight / fitted[1].viewHeight - 1) < 1e-9, `view heights ${fitted.map((fit) => fit.viewHeight).join(" and ")} mm`);
  assert.ok(Math.abs(fitted[0].drawn - fitted[1].drawn) <= 2 / 640, `drawn ${fitted.map((fit) => fit.drawn).join(" and ")} of the width`);
});

test("simultaneous opens for one project share a single viewer", { timeout: 240_000 }, async (t) => {
  const { explorer } = await launcherFixture(t);
  const results = await Promise.all([explorer("open"), explorer("open"), explorer("open")]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const opened = results.map((result) => result.json());
  assert.equal(new Set(opened.map((item) => item.url)).size, 1);
  assert.equal(opened.filter((item) => item.started).length, 1);
  assert.ok(opened.every((item) => item.model.name === "Demo assembly.step"));
});
