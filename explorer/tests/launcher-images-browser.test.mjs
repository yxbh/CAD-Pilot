import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { corners, drawnWidth, launcherFixture, pngSize } from "./launcher-fixture.mjs";

test("capture draws in the background into the project at any size and rejects other paths", { timeout: 240_000 }, async (t) => {
  const { explorer, project } = await launcherFixture(t);
  assert.equal((await explorer("open")).code, 0);
  const captured = await explorer("capture", "reviews/view.png");
  assert.equal(captured.code, 0, captured.stderr);
  assert.equal(captured.json().saved, "reviews/view.png");
  assert.deepEqual(await pngSize(path.join(project, "reviews", "view.png")), [1280, 800]);
  const small = (await explorer("capture", "reviews/small.png", "--size", "320x200", "--background", "#ffffff")).json();
  assert.deepEqual([small.width, small.height], [320, 200]);
  // Each capture reports the camera that drew it, in the shape render and state use; one aspect, one framing.
  const { camera } = captured.json();
  assert.deepEqual(Object.keys(camera).sort(), ["projection", "view", "viewHeight"]);
  assert.ok(camera.viewHeight > 0);
  assert.ok(Math.abs(small.camera.viewHeight - camera.viewHeight) < 1e-6 * camera.viewHeight, JSON.stringify([small.camera, camera]));
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
  // Hidden parts are named as in sequences: a group's label covers its parts.
  const rendered = await explorer("render", "demo.step", "docs/demo.png", "--size", "400x300", "--view", "30:20",
    "--section", "y", "--appearance", "studio", "--background", "#f2f1ec", "--hide", "Four spacers");
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
  const missing = await explorer("render", "demo.step", "docs/hidden.png", "--hide", "Base plate,no such part");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No part or group label matches no such part/);
  const everything = await explorer("render", "demo.step", "docs/hidden.png", "--hide", "*");
  assert.equal(everything.code, 1);
  assert.match(everything.stderr, /would hide every part/);
  // An orthographic view is fitted to the image the same way at the default size as at a requested one of the same
  // shape, and shows viewHeight / height millimetres per pixel: twice as many at half the size. Seen from the front, the
  // demo's base plate (python/create_demo.py BASE_WIDTH) is its widest part, 100 mm across.
  const fronts = [];
  for (const size of [[], ["--size", "640x400"]]) {
    const front = await explorer("render", "demo.step", "docs/front.png", ...size, "--view", "front", "--projection", "orthographic", "--background", "#ffffff");
    assert.equal(front.code, 0, front.stderr);
    const { camera, width, height } = front.json();
    assert.deepEqual(Object.keys(camera).sort(), ["projection", "view", "viewHeight"]);
    assert.deepEqual([camera.view, camera.projection], ["front", "orthographic"]);
    fronts.push({ width, height, viewHeight: camera.viewHeight, pixel: camera.viewHeight / height, drawn: await drawnWidth(path.join(project, "docs", "front.png")) });
  }
  const [full, half] = fronts;
  assert.deepEqual([[full.width, full.height], [half.width, half.height]], [[1280, 800], [640, 400]]);
  assert.ok(Math.abs(full.viewHeight / half.viewHeight - 1) < 1e-9, `view heights ${full.viewHeight} and ${half.viewHeight} mm`);
  assert.ok(Math.abs(full.drawn / full.width - half.drawn / half.width) <= 2 / half.width, `drawn ${full.drawn} of ${full.width} and ${half.drawn} of ${half.width} pixels`);
  assert.ok(Math.abs(half.pixel / full.pixel - 2) < 1e-9, "half the size, twice the millimetres per pixel");
  assert.ok(Math.abs(half.drawn * half.pixel - 100) <= 2 * half.pixel, `${half.drawn * half.pixel} mm drawn at ${half.pixel} mm per pixel`);
});
