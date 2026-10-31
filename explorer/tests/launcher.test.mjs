import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEndpoint, validEndpoint, writeEndpoint } from "../server/endpoint.mjs";
import { locateView, openViewer } from "../server/launcher.mjs";
import { actionInput, referenceFrom, renderOptions, run } from "../scripts/explorer.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

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
  assert.throws(() => renderOptions({ size: "600" }), /WIDTHxHEIGHT/);
  assert.throws(() => renderOptions({ explode: "lots" }), /--explode needs a number/);
  assert.throws(() => renderOptions({ outlines: "maybe" }), /on or off/);
});
