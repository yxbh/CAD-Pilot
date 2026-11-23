import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEndpoint, validEndpoint, writeEndpoint } from "../server/endpoint.mjs";
import { foreignCheckout, locateView, openViewer } from "../server/launcher.mjs";
import { actionInput, checkedInput, referenceFrom, renderOptions, run } from "../scripts/explorer.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

test("an unbuilt Explorer fails before starting a viewer", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-unbuilt-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const location = await locateView({ projectRoot: directory, runtimeRoot: directory });
  let spawned = false;
  await assert.rejects(openViewer(location, undefined, {}, { distIndex: path.join(directory, "missing", "index.html"), spawnViewer: () => { spawned = true; } }),
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

test("render flags spell the same view actions as do", () => {
  assert.deepEqual(renderOptions({
    size: "600x360", view: "45:32", background: "#f2f1ec", outlines: "off", section: "x:-12.5:flipped",
    explode: "0.4:z", step: "2:buildup", hide: "Lid, bolt *", appearance: "studio",
  }), {
    width: 600, height: 360, view: "45:32", background: "#f2f1ec", appearance: "studio", outlines: false,
    section: { axis: "x", flipped: true, position: -12.5 }, explode: { amount: 0.4, direction: "z" },
    step: { step: 2, mode: "buildup" }, hide: ["Lid", "bolt *"],
  });
  assert.deepEqual(renderOptions({ section: "y" }), { section: { axis: "y", flipped: false } });
  assert.deepEqual(renderOptions({ units: "m", up: "y" }), { units: "m", up: "y" }, "how to read a mesh");
  assert.throws(() => renderOptions({ size: "600" }), /WIDTHxHEIGHT/);
  assert.throws(() => renderOptions({ explode: "lots" }), /--explode needs a number/);
  assert.throws(() => renderOptions({ outlines: "maybe" }), /on or off/);
});

test("open reads --units and --up, and each command refuses options it does not read", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-flags-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened = [];
  const open = async (location, file, options) => { opened.push([file, options]); return {}; };
  await run(["open", "outputs/pin.stl", "--units", "mm", "--up", "y"], { cwd: directory, open });
  await run(["open", "outputs/pin.stl"], { cwd: directory, open });
  assert.deepEqual(opened, [["outputs/pin.stl", { units: "mm", up: "y" }], ["outputs/pin.stl", {}]]);
  await assert.rejects(run(["open", "outputs/pin.stl", "units=mm"], { cwd: directory, open }), /open takes one file; say how to read a mesh with --units and --up/);
  await assert.rejects(run(["open", "--units", "mm"], { cwd: directory, open }), /name the file/);
  await assert.rejects(run(["state", "--units", "mm"], { cwd: directory }), /state does not take --units/);
  await assert.rejects(run(["capture", "--hide", "lid", "--step", "2"], { cwd: directory }), /capture does not take --hide or --step/);
  // A capture draws the view as it is, so the refusal names the view actions that change it first.
  await assert.rejects(run(["capture", "--hide", "lid", "--step", "2"], { cwd: directory }),
    /Run help to list each command's options\. capture draws the view as it is: change it first with do set_visibility \(with the parts' ids, which state --full lists, not their labels\), do set_step, or use render, which takes --hide, --step\.$/);
  await assert.rejects(run(["capture", "--section", "x", "--explode", "0.4", "--finish", "matte", "--outlines", "off"], { cwd: directory }),
    /change it first with do set_section, do set_explode, do set_appearance, or use render, which takes --section, --explode, --finish, --outlines\.$/);
  // render is named only for the options it takes.
  await assert.rejects(run(["capture", "--step", "2", "--dry-run"], { cwd: directory }),
    /^Error: capture does not take --step or --dry-run\. .* change it first with do set_step, or use render, which takes --step\.$/);
  await assert.rejects(run(["capture", "--units", "mm"], { cwd: directory }), /^Error: capture does not take --units\. Run help to list each command's options\.$/);
  await assert.rejects(run(["state", "--hide", "lid"], { cwd: directory }), /^Error: state does not take --hide\. Run help to list each command's options\.$/);
  // A misspelt option is refused, not read as an argument: prune --dryrun must not prune.
  await assert.rejects(run(["prune", "--dryrun"], { cwd: directory }), /Unknown option --dryrun/);
  await assert.rejects(run(["actions", "extra"], { cwd: directory }), /actions takes no arguments, got extra/);
  await assert.rejects(run(["capture", "reviews/a.png", "reviews/b.png"], { cwd: directory }), /capture takes one path, got reviews\/a\.png reviews\/b\.png/);
  assert.equal(opened.length, 2);
});

test("do refuses input an action does not read or lacks, before asking the viewer", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-inputs-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const refused = (argv, message) => assert.rejects(run(["do", ...argv], { cwd: directory }), (error) => {
    assert.equal(error.code, "bad_arguments");
    assert.equal(error.message, message);
    return true;
  });
  await refused(["remove_file", "ref=ref1"], "remove_file does not take ref and needs id. Its inputs: id (required).");
  await refused(["set_visibility", "ids=[\"o1.2\"]"], "set_visibility needs visible. Its inputs: ids (required), visible (required).");
  await refused(["set_section", "enabled=true", "axsi=y"], "set_section does not take axsi. Its inputs: enabled, axis, position, flipped.");
  await refused(["set_view", "{\"preset\":\"top\",\"zoom\":2}"], "set_view does not take zoom. Its inputs: preset, azimuth, elevation.");
  await refused(["show_all", "fit=true"], "show_all does not take fit. It takes no input.");
  await refused(["capture_image", "size=800x600"], "capture_image does not take size. Its inputs: width, height, background, analysis, samples, seconds.");
  await refused(["set_view", "[1]"], "Expected key=value, got \"[1]\"");
  // topologyRevision is read only where an action's inputs list it; elsewhere the viewer would not always check it.
  await refused(["show_all", "topologyRevision=abc"], "show_all does not take topologyRevision. It takes no input.");
  assert.deepEqual(checkedInput("select_face", { id: "a", faceId: "f1", topologyRevision: "abc" }), { id: "a", faceId: "f1", topologyRevision: "abc" });
  assert.deepEqual(checkedInput("set_step", { step: null, expectedRevision: 3 }), { step: null, expectedRevision: 3 });
  assert.deepEqual(checkedInput("show_all", {}), {});
  assert.throws(() => checkedInput("show_all", []), /key=value pairs or one JSON object/);
  await assert.rejects(run(["do", "spin", "fast=true"], { cwd: directory }), { code: "unknown_action" });
});

test("--view read as a setup's name says so when it is a camera and no such setup runs", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-view-flag-")));
  const saved = Object.fromEntries(["CAD_EXPLORER_RUNTIME_ROOT", "CAD_EXPLORER_VIEW"].map((name) => [name, process.env[name]]));
  process.env.CAD_EXPLORER_RUNTIME_ROOT = path.join(directory, "runtime");
  delete process.env.CAD_EXPLORER_VIEW;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(run(["capture", "reviews/a.png", "--view", "iso"], { cwd: directory }), (error) => {
    assert.equal(error.code, "not_running");
    assert.equal(error.message, "No Explorer viewer is running for the setup named \"iso\". Here --view names a saved setup, not a camera. "
      + "For the setup, run: explorer.mjs open <file> --view iso. For the camera, leave --view out and run do set_view preset=iso, or use render, whose --view is the camera.");
    return true;
  });
  await assert.rejects(run(["state", "--view", "45:32"], { cwd: directory }), /leave --view out and run do set_view azimuth=45 elevation=32, or use render/);
  const plain = /^Error: No Explorer viewer is running for this project\. Run: explorer\.mjs open <file>$/;
  for (const argv of [["capture", "reviews/a.png", "--view", "exploded"], ["capture", "reviews/a.png"]]) await assert.rejects(run(argv, { cwd: directory }), plain);
  // Beside do, --view still names a setup; set_view itself is how to turn the camera, and other actions are told.
  await assert.rejects(run(["do", "set_view", "preset=top", "--view", "iso"], { cwd: directory }), (error) => {
    assert.equal(error.message, "No Explorer viewer is running for the setup named \"iso\". Here --view names a saved setup, not a camera. "
      + "For the setup, run: explorer.mjs open <file> --view iso.");
    return true;
  });
  await assert.rejects(run(["do", "capture_image", "--view", "iso"], { cwd: directory }), /leave --view out and run do set_view preset=iso/);
  // A setup named by the environment was not typed as a camera, so it gets the plain answer.
  process.env.CAD_EXPLORER_VIEW = "top";
  await assert.rejects(run(["state"], { cwd: directory }), plain);
});

// A stand-in viewer: just enough of the HTTP protocol for the launcher to find, stop and confirm it.
async function fakeViewer(t, { checkout, pid }) {
  const token = randomBytes(24).toString("hex");
  let record;
  const server = createServer((req, res) => {
    const route = req.url.slice(`/${token}/`.length).split("?")[0];
    const json = (value, after) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value), after);
    };
    if (route === "api/state") return json({ application: "CAD Explorer", initialized: true, loading: false });
    if (route === "api/confirm") return json({ application: "CAD Explorer", url: record.url });
    if (route === "api/shutdown") return json({ stopping: true }, () => { server.close(); server.closeAllConnections(); });
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const { port } = server.address();
  record = { url: `http://127.0.0.1:${port}/${token}/`, port, token, pid, explorerRoot: checkout };
  return { server, record };
}

test("open restarts a viewer that another workbench checkout started, keeping one viewer per setup", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-checkout-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const location = await locateView({ projectRoot: directory, runtimeRoot: directory });
  const distIndex = path.join(directory, "index.html");
  await writeFile(distIndex, "");
  const foreign = await fakeViewer(t, { checkout: "/other/checkout/explorer", pid: 1 });
  await mkdir(path.dirname(location.endpoint), { recursive: true });
  await writeEndpoint(location.endpoint, foreign.record);
  const spawnViewer = () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    void fakeViewer(t, { checkout: "/this/checkout/explorer", pid: 4242 }).then(({ record }) => writeEndpoint(location.endpoint, record));
    return { child, logStart: 0 };
  };
  const opened = await openViewer(location, undefined, {}, { spawnViewer, distIndex, checkout: "/this/checkout/explorer" });
  assert.deepEqual([opened.started, opened.replaced, opened.pid], [true, "/other/checkout/explorer", 4242]);
  assert.equal(foreign.server.listening, false, "the other checkout's viewer was stopped, not left competing");
  assert.ok(foreignCheckout({ explorerRoot: "/other" }, "/this") && !foreignCheckout({ explorerRoot: "/this" }, "/this"));
  assert.ok(foreignCheckout({}, "/this"), "a viewer from before checkouts were recorded is replaced too");
});

test("the same checkout reached through a link or spelled in another case is not another checkout", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cad-explorer-spelling-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "Workbench", "explorer");
  await mkdir(checkout, { recursive: true });
  await symlink(path.join(directory, "Workbench"), path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(foreignCheckout({ explorerRoot: path.join(directory, "linked", "explorer") }, checkout), false);
  // macOS and Windows folders usually ignore case; there another spelling names the same folder.
  const otherCase = path.join(directory, "WORKBENCH", "explorer");
  const ignoresCase = await stat(otherCase).then(() => true, () => false);
  assert.equal(foreignCheckout({ explorerRoot: otherCase }, checkout), !ignoresCase);
  assert.equal(foreignCheckout({ explorerRoot: path.join(directory, "elsewhere", "explorer") }, checkout), true);
});
