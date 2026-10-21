import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEndpoint, validEndpoint, writeEndpoint } from "../server/endpoint.mjs";
import { locateView, openViewer } from "../server/launcher.mjs";
import { actionInput, referenceFrom, run } from "../scripts/explorer.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

const cli = fileURLToPath(new URL("../scripts/explorer.mjs", import.meta.url));
const standalone = fileURLToPath(new URL("../server/standalone.mjs", import.meta.url));
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=";

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

// Real background viewers in a disposable runtime; never the user's runtime or saved setups.
async function launcherFixture(t) {
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

test("open starts one background viewer per project, reloads it in place and keeps its address", { timeout: 120_000 }, async (t) => {
  const { runtimeRoot, project, env, explorer } = await launcherFixture(t);
  const first = await explorer("open");
  assert.equal(first.code, 0, first.stderr);
  const opened = first.json();
  assert.equal(opened.started, true);
  assert.equal(opened.model, "Demo assembly.step");
  assert.equal(opened.error, "");
  const location = await locateView({ projectRoot: project, runtimeRoot });
  const recordFile = location.endpoint;
  const record = await readEndpoint(recordFile);
  assert.equal(record.url, opened.url);
  assert.equal(record.pid, opened.pid);
  if (process.platform !== "win32") {
    // Both the record and the background log contain the capability URL.
    assert.equal((await stat(recordFile)).mode & 0o777, 0o600);
    assert.equal((await stat(location.log)).mode & 0o777, 0o600);
    assert.match(await readFile(location.log, "utf8"), new RegExp(opened.url));
  }

  await mkdir(path.join(project, "parts"));
  await copyFile(path.join(runtimeRoot, "demo-assembly.step"), path.join(project, "parts", "demo copy.step"));
  const reopened = (await explorer("open", "parts/demo copy.step")).json();
  assert.deepEqual([reopened.url, reopened.started, reopened.reloaded, reopened.model], [opened.url, false, true, "demo copy.step"]);
  assert.ok(reopened.revision > opened.revision);

  // Running the human-facing command again hands over instead of failing on the view lease.
  const second = await exec(standalone, ["parts/demo copy.step"], { cwd: project, env });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.stdout.trim().split("\n"), [opened.url, "Reloaded: demo copy.step"]);

  const viewed = await explorer("do", "set_view", '{"preset":"top"}');
  assert.equal(viewed.json().cameraPreset, "top");
  const state = (await explorer("state")).json();
  assert.equal(state.modelName, "demo copy.step");
  const unknown = await explorer("do", "spin");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown view action "spin"/);
  assert.match((await explorer("do", "set_view", "top")).stderr, /Expected key=value/);
  const sectioned = (await explorer("do", "set_section", "enabled=true", "axis=y")).json();
  assert.deepEqual([sectioned.section.enabled, sectioned.section.axis], [true, "y"]);

  const reference = `cadproto:v2:${state.topologyRevision}/${encodeURIComponent(state.parts[0].id)}/part`;
  const inspected = await explorer("inspect", `CAD Explorer | demo copy.step | ${state.parts[0].label} | Whole part\n${reference}`);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(inspected.json().occurrence.id, state.parts[0].id);
  const copied = await (await fetch(opened.url + "api/clipboard-reference", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference }),
  })).json();
  // Identical bytes share one cached snapshot, which keeps the source name it was first imported with.
  assert.equal(copied.text, `CAD Explorer | Demo assembly.step | ${state.parts[0].label} | Whole part\n${reference}`, "Standalone viewers copy readable text, not Copilot chips");

  assert.equal((await explorer("stop")).json().stopped, true);
  const stopped = await explorer("state");
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /No Explorer viewer is running/);
  assert.deepEqual((await explorer("stop")).json(), { stopped: false, running: false });

  const restarted = (await explorer("open")).json();
  assert.equal(restarted.started, true);
  assert.equal(restarted.url, opened.url, "A restarted viewer keeps its port and token so earlier links still work");
  assert.equal(restarted.model, "demo copy.step");
});

test("capture saves the rendered view inside the project and rejects other paths", { timeout: 120_000 }, async (t) => {
  const { explorer, project } = await launcherFixture(t);
  const { url } = (await explorer("open")).json();
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = (await fetch(url + "api/events", { signal: abort.signal })).body.getReader();
  const state = await (await fetch(url + "api/state")).json();
  const rendered = await fetch(url + "api/rendered", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: state.revision, modelHash: state.documentRevision, topologyRevision: state.topologyRevision }),
  });
  assert.equal(rendered.status, 200);
  const capturing = explorer("capture", "reviews/view.png");
  let text = "", request;
  while (!request) {
    const { value, done } = await events.read();
    assert.equal(done, false);
    text += new TextDecoder().decode(value);
    const match = /event: capture\ndata: ([^\n]+)/.exec(text);
    if (match) request = JSON.parse(match[1]);
  }
  const answered = await fetch(url + "api/capture-result", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, dataUrl: png }),
  });
  assert.equal(answered.status, 200);
  const captured = await capturing;
  assert.equal(captured.code, 0, captured.stderr);
  assert.equal(captured.json().saved, "reviews/view.png");
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

test("simultaneous opens for one project share a single viewer", { timeout: 120_000 }, async (t) => {
  const { explorer } = await launcherFixture(t);
  const results = await Promise.all([explorer("open"), explorer("open"), explorer("open")]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const opened = results.map((result) => result.json());
  assert.equal(new Set(opened.map((item) => item.url)).size, 1);
  assert.equal(opened.filter((item) => item.started).length, 1);
  assert.ok(opened.every((item) => item.model === "Demo assembly.step"));
});

test("an unbuilt Explorer fails before starting a viewer", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-unbuilt-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const location = await locateView({ projectRoot: directory, runtimeRoot: directory });
  let spawned = false;
  await assert.rejects(openViewer(location, undefined, { distIndex: path.join(directory, "missing", "index.html"), spawnViewer: () => { spawned = true; } }),
    (error) => error.code === "not_built" && error.message.includes("npm --prefix explorer run build"));
  assert.equal(spawned, false);
});

test("server options keep a requested address, fall back from a busy port and gate shutdown", { timeout: 60_000 }, async (t) => {
  const runtime = await createTestRuntime(t);
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-address-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const token = "a".repeat(48);
  await assert.rejects(runtime.createService({ projectRoot: project, viewId: "bad", token: "short" }), { code: "bad_token" });
  let shutdowns = 0;
  const first = await runtime.createService({ projectRoot: project, viewId: "address", token, onShutdown: () => { shutdowns++; } });
  const port = Number(new URL(first.url).port);
  assert.equal(new URL(first.url).pathname, `/${token}/`);
  assert.deepEqual(await (await fetch(first.url + "api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json(), { stopping: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdowns, 1);
  await first.close();

  const again = await runtime.createService({ projectRoot: project, viewId: "address", port, token });
  assert.equal(again.url, first.url);
  assert.equal((await fetch(again.url + "api/shutdown", { method: "POST", body: "{}" })).status, 404, "Hosts without onShutdown keep the route closed");
  const busy = await runtime.createService({ projectRoot: project, viewId: "other", port });
  assert.notEqual(Number(new URL(busy.url).port), port);
});

test("endpoint records accept only a consistent loopback address", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-endpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "b".repeat(48);
  const record = { url: `http://127.0.0.1:4321/${token}/`, port: 4321, token, pid: 7 };
  assert.ok(validEndpoint(record));
  assert.ok(!validEndpoint({ ...record, url: `http://example.com:4321/${token}/` }));
  assert.ok(!validEndpoint({ ...record, token: "B".repeat(48) }));
  const file = path.join(directory, "view.endpoint.json");
  assert.equal(await readEndpoint(file), null);
  await writeEndpoint(file, record);
  assert.deepEqual(await readEndpoint(file), record);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, "{not json");
  assert.equal(await readEndpoint(file), null);
  await assert.rejects(writeEndpoint(file, { ...record, port: 1 }), /Invalid/);
});

test("pasted references, descriptors and chip markup resolve to one address", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cad explorer reference "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reference = `cadproto:v2:${"c".repeat(64)}/node%3A1/f3`;
  assert.equal(await referenceFrom(`CAD Explorer | plate.step | plate | Face f3 (plane, 1.00 mm^2)\n${reference}`), reference);
  assert.equal(await referenceFrom(`\`${reference}\``), reference);
  const descriptor = path.join(directory, "a & b.json");
  await writeFile(descriptor, JSON.stringify({ reference }));
  assert.equal(await referenceFrom(descriptor), reference);
  assert.equal(await referenceFrom(`<copilot-ref kind="file" target-id="${descriptor.replaceAll("&", "&amp;")}" label="plate" />`), reference);
  await assert.rejects(referenceFrom("the top face"), /cadproto:v2 reference/);
  const actions = (await run(["actions"])).map((action) => action.name);
  assert.ok(actions.includes("set_section") && actions.includes("capture_image"));
  assert.ok(!actions.includes("add_reference_to_chat") && !actions.includes("save_camera"));
  assert.match(await run(["--help"]), /^Usage:/);
  assert.deepEqual(actionInput(["enabled=true", "axis=y", "position=-12.5", "ids=[\"a\"]", "fixedId=node:1=2"]),
    { enabled: true, axis: "y", position: -12.5, ids: ["a"], fixedId: "node:1=2" });
  assert.deepEqual(actionInput(['{"preset":"top"}']), { preset: "top" });
  assert.throws(() => actionInput(["{broken"]), /JSON object/);
});
