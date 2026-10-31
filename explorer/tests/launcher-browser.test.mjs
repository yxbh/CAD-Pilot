import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEndpoint } from "../server/endpoint.mjs";
import { locateView } from "../server/launcher.mjs";
import { revisionLabel } from "../server/summary.mjs";
import { exec, launcherFixture } from "./launcher-fixture.mjs";

const standalone = fileURLToPath(new URL("../server/standalone.mjs", import.meta.url));

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

test("simultaneous opens for one project share a single viewer", { timeout: 240_000 }, async (t) => {
  const { explorer } = await launcherFixture(t);
  const results = await Promise.all([explorer("open"), explorer("open"), explorer("open")]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const opened = results.map((result) => result.json());
  assert.equal(new Set(opened.map((item) => item.url)).size, 1);
  assert.equal(opened.filter((item) => item.started).length, 1);
  assert.ok(opened.every((item) => item.model.name === "Demo assembly.step"));
});
