import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHeadlessRenderer, findChromium } from "../server/renderer.mjs";
import { createTestRuntime } from "./service-fixture.mjs";
import { workbenchRoot } from "../server/paths.mjs";

// A stand-in Chromium that answers debugging-pipe commands the way the real one does.
function fakeBrowser() {
  const launches = [];
  const launch = (executable, args) => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(), exitCode: null, signalCode: null, args, commands: [], stdio: [null, null, null, toBrowser, fromBrowser],
    });
    toBrowser.on("data", (chunk) => {
      for (const text of chunk.toString("utf8").split("\0").filter(Boolean)) {
        const message = JSON.parse(text);
        child.commands.push(message);
        fromBrowser.write(`${JSON.stringify({ id: message.id, result: { targetId: "page" } })}\0`);
      }
    });
    child.kill = (signal = "SIGTERM") => { child.signalCode = signal; setImmediate(() => child.emit("exit", null, signal)); };
    launches.push(child);
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  return { launches, launch };
}

async function scratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-renderer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const profiles = async (directory) => (await readdir(directory)).filter((name) => name.startsWith("cad-explorer-renderer-")).sort();

test("the renderer uses the newest Playwright headless shell, or says how to install it", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-browsers-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const browsers = path.join(home, "ms-playwright");
  for (const revision of ["1200", "1248"]) {
    const folder = path.join(browsers, `chromium_headless_shell-${revision}`, "chrome-headless-shell-linux64");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "chrome-headless-shell"), "");
    await chmod(path.join(folder, "chrome-headless-shell"), 0o755);
  }
  const env = { PLAYWRIGHT_BROWSERS_PATH: browsers };
  assert.equal(await findChromium({ env, platform: "linux", home }),
    path.join(browsers, "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell"));
  assert.equal(await findChromium({ env: { ...env, CAD_EXPLORER_CHROMIUM: "/opt/chrome" }, platform: "linux", home }), "/opt/chrome");
  await assert.rejects(findChromium({ env: {}, platform: "linux", home }), (error) => error.code === "renderer_missing" && /playwright install chromium/.test(error.message));
});

test("the renderer starts once on demand, opens the viewer over its pipe, stops when idle, retries in software and reports a crash", async (t) => {
  const tmp = await scratch(t);
  const { launches, launch } = fakeBrowser();
  const exits = [];
  const renderer = createHeadlessRenderer({
    url: "http://127.0.0.1:1/secret-token/", idleMs: 50, find: async () => "/chrome", launch, tmp, platform: "win32", onExit: (error) => exits.push(error),
  });
  await Promise.all([renderer.ensure(), renderer.ensure()]);
  assert.equal(launches.length, 1);
  assert.ok(renderer.running);
  assert.ok(launches[0].args.includes("--remote-debugging-pipe"), "Chromium exits with this process through its pipe");
  // Hardware ANGLE first; Chromium may still switch to software WebGL itself on a machine without a usable GPU.
  assert.ok(launches[0].args.includes("--use-angle=d3d11") && launches[0].args.includes("--enable-unsafe-swiftshader"));
  assert.ok(!launches[0].args.includes("--no-sandbox"), "the sandbox stays on where it works");
  // The capability URL is sent over the pipe, never on a command line other local users can read.
  assert.equal(launches[0].args.at(-1), "about:blank");
  assert.ok(launches[0].args.every((arg) => !arg.includes("secret-token")));
  assert.deepEqual(launches[0].commands.map(({ method, params }) => [method, params.url]),
    [["Target.createTarget", "http://127.0.0.1:1/secret-token/?renderer=headless"]]);
  const [profile] = await profiles(tmp);
  assert.equal(await readFile(path.join(tmp, profile, "owner"), "utf8"), String(process.pid));
  await delay(120);
  assert.equal(renderer.running, false, "an idle renderer stops");
  assert.deepEqual(await profiles(tmp), [], "a stopped browser's profile is removed");
  assert.deepEqual(exits, [], "an intentional stop is not a failure");
  await renderer.ensure();
  // Windows falls back to Direct3D's software rasterizer, then to SwiftShader, which ships with Chromium.
  for (const flag of ["--use-angle=d3d11-warp", "--use-angle=swiftshader"]) {
    assert.equal(await renderer.fallBack(), true);
    assert.deepEqual(launches.at(-1).args.filter((arg) => arg.startsWith("--use-angle=")), [flag]);
  }
  assert.equal(launches.length, 4);
  assert.equal(await renderer.fallBack(), false, "SwiftShader is the last resort");
  // Page console output is not a reason; the exit signal is. A crashing browser resets its pipes, which must not end this process.
  launches[3].stderr.emit("data", Buffer.from('[1:2:INFO:CONSOLE(7)] "THREE.Clock: This module has been deprecated."\n'));
  launches[3].stdio[4].destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  launches[3].stdio[3].destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  launches[3].signalCode = "SIGKILL";
  launches[3].emit("exit", null, "SIGKILL");
  assert.equal(renderer.running, false);
  assert.match(exits[0].message, /stopped \(signal SIGKILL\)/);
  assert.doesNotMatch(exits[0].message, /THREE/);
  launches.length = 0;
  await renderer.ensure();
  launches[0].stderr.emit("data", Buffer.from("[3:4:ERROR:gpu_init.cc(5)] GPU process crashed\n"));
  launches[0].emit("exit", 1, null);
  assert.match(exits[1].message, /exit code 1: GPU process crashed/);
  await renderer.close();
  assert.deepEqual(await profiles(tmp), [], "closing waits for a crashed browser's profile to be removed");
  await assert.rejects(renderer.ensure(), { code: "closed" });
});

test("on Linux the renderer runs without the sandbox, and a browser that resets its pipe fails its start, not the process", async (t) => {
  const tmp = await scratch(t);
  const { launches, launch } = fakeBrowser();
  let reset = false;
  const resetting = (...args) => {
    const child = launch(...args);
    if (reset) child.stdio[3].prependListener("data", () => child.stdio[4].destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
    return child;
  };
  const renderer = createHeadlessRenderer({ url: "http://127.0.0.1:1/t/", find: async () => "/chrome", launch: resetting, tmp, platform: "linux" });
  await renderer.ensure();
  assert.ok(launches[0].args.includes("--no-sandbox"));
  assert.ok(launches[0].args.every((arg) => !arg.startsWith("--use-angle=")), "Linux keeps Chromium's own ANGLE choice");
  await renderer.fallBack();
  assert.ok(launches[1].args.includes("--no-sandbox") && launches[1].args.includes("--use-angle=swiftshader"));
  await renderer.stop();
  reset = true;
  await assert.rejects(renderer.ensure(), (error) => error.code === "renderer_failed" && /did not open the viewer: read ECONNRESET/.test(error.message));
  assert.equal(renderer.running, false);
  await renderer.close();
  assert.deepEqual(await profiles(tmp), []);
});

test("a browser that exits as it starts fails the start at once, with what it printed", { timeout: 30_000 }, async (t) => {
  const tmp = await scratch(t);
  // As a headless shell does on Linux without its system libraries: the loader prints the problem and it exits.
  const loader = "/opt/chrome-headless-shell: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory";
  const launch = (executable, args, options) => spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(`${loader}\n`)}); process.exit(127)`], options);
  const exits = [];
  const renderer = createHeadlessRenderer({ url: "http://127.0.0.1:1/t/", find: async () => "/chrome", launch, tmp, onExit: (error) => exits.push(error) });
  const started = Date.now();
  await assert.rejects(renderer.ensure(), (error) => error.code === "renderer_failed" && error.message.includes(`exit code 127: ${loader}`));
  assert.ok(Date.now() - started < 5000, "the start failed when the browser exited, not when its command timed out");
  assert.equal(renderer.running, false);
  await renderer.close();
  assert.deepEqual(await profiles(tmp), []);
});

test("each browser owns its profile: a stop racing a start keeps the new one, and orphaned profiles are swept", async (t) => {
  const tmp = await scratch(t);
  // A profile left by a viewer that was killed outright names an owner that no longer exists.
  const ended = spawn(process.execPath, ["-e", ""]);
  await once(ended, "exit");
  await mkdir(path.join(tmp, "cad-explorer-renderer-orphan"));
  await writeFile(path.join(tmp, "cad-explorer-renderer-orphan", "owner"), String(ended.pid));
  await mkdir(path.join(tmp, "cad-explorer-renderer-alive"));
  await writeFile(path.join(tmp, "cad-explorer-renderer-alive", "owner"), String(process.pid));
  const { launches, launch } = fakeBrowser();
  const renderer = createHeadlessRenderer({ url: "http://127.0.0.1:1/t/", find: async () => "/chrome", launch, tmp });
  await renderer.ensure();
  const first = launches[0].args.find((arg) => arg.startsWith("--user-data-dir=")).slice(16);
  assert.deepEqual(await profiles(tmp), ["cad-explorer-renderer-alive", path.basename(first)].sort(), "only the orphan is swept");
  await Promise.all([renderer.stop(), renderer.ensure()]);
  const second = launches.at(-1).args.find((arg) => arg.startsWith("--user-data-dir=")).slice(16);
  assert.notEqual(second, first);
  assert.ok(renderer.running);
  assert.deepEqual(await profiles(tmp), ["cad-explorer-renderer-alive", path.basename(second)].sort());
  await renderer.close();
});

// A stand-in renderer whose page never draws, so the test controls every report.
function stubRenderer({ ensure = async () => {} } = {}) {
  const calls = { ensure: 0, fallBack: 0, stop: 0 };
  let failure = null;
  const factory = ({ onExit }) => {
    failure = onExit;
    return {
      running: false,
      async ensure() { calls.ensure++; return ensure(); },
      touch() {},
      async fallBack() { calls.fallBack++; return calls.fallBack === 1; },
      async stop() { calls.stop++; },
      async close() {},
    };
  };
  return { calls, factory, crash: (error) => failure(error) };
}

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=";

// A service with a stand-in renderer, and pages simulated over its own HTTP protocol.
async function routingFixture(t, viewId, stubOptions) {
  const runtime = await createTestRuntime(t);
  const stub = stubRenderer(stubOptions);
  const service = await runtime.createService({ projectRoot: workbenchRoot, viewId, renderer: stub.factory, log: () => {} });
  await service.initialize();
  const post = (route, body) => fetch(service.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const report = (kind) => {
    const state = service.getState();
    return post("api/rendered", { revision: state.revision, modelHash: state.documentRevision, topologyRevision: state.topologyRevision, kind });
  };
  const page = async (kind, client = kind) => {
    const abort = new AbortController();
    const events = await fetch(service.url + `api/events?kind=${kind}&client=${client}`, { signal: abort.signal });
    const opened = { text: "", close: () => abort.abort() };
    void (async () => { for await (const chunk of events.body) opened.text += Buffer.from(chunk).toString("utf8"); })().catch(() => {});
    t.after(() => abort.abort());
    return opened;
  };
  const captureRequests = (opened) => [...opened.text.matchAll(/event: capture\ndata: ([^\n]+)/g)].map((match) => JSON.parse(match[1]));
  const until = async (condition, message) => {
    for (let count = 0; !condition(); count++) {
      assert.ok(count < 200, message);
      await delay(10);
    }
  };
  return { service, stub, post, report, page, captureRequests, until };
}

test("views without a viewer page start the background renderer; an answering page is given a moment first", { timeout: 60_000 }, async (t) => {
  const { service, stub, post, report, page } = await routingFixture(t, "routing");
  const confirming = service.confirmRendered();
  await delay(50);
  assert.equal(stub.calls.ensure, 1, "with no viewer page the background renderer starts at once");
  await page("headless");
  assert.equal((await report("headless")).status, 200);
  const confirmed = await confirming;
  assert.equal(confirmed.shown.drawn, "headless");
  assert.match(confirmed.note, /No viewer page is open/);

  await page("viewer", "person");
  const viewing = service.execute("fit_view", {}, { rendered: true });
  await delay(300);
  assert.equal(stub.calls.ensure, 1, "an open viewer page gets a moment to answer");
  assert.equal((await report("viewer")).status, 200);
  await viewing;
  assert.equal(service.getState().renderers.seen, true);

  // A page that cannot create a WebGL context restarts once in software; a second failure is reported.
  const capturing = service.captureImage();
  void capturing.catch(() => {});
  const failed = (webgl) => post("api/renderer-error", { message: "Error creating WebGL context", webgl });
  assert.equal((await failed(true)).status, 200);
  assert.deepEqual([stub.calls.fallBack, stub.calls.stop], [1, 0]);
  assert.equal((await failed(true)).status, 200);
  await assert.rejects(capturing, (error) => error.code === "render_failed" && /WebGL context/.test(error.message));
  assert.equal(stub.calls.stop, 1, "a page that failed for good is stopped so the next request starts afresh");

  const again = service.captureImage();
  void again.catch(() => {});
  await delay(50);
  stub.crash(Object.assign(new Error("The headless renderer stopped (exit 1)"), { code: "renderer_failed" }));
  await assert.rejects(again, { code: "renderer_failed" });
  await assert.rejects(service.captureImage({ width: 9 }), { code: "bad_capture" });
  await assert.rejects(service.captureImage({ client: "nobody" }), { code: "unknown_client" });
});

test("a closed background page's last report is forgotten, so the next capture starts the renderer again", { timeout: 60_000 }, async (t) => {
  const { service, stub, post, report, page, captureRequests, until } = await routingFixture(t, "restart");
  const first = await page("headless");
  assert.equal((await report("headless")).status, 200);
  assert.equal(service.getState().renderers.drawn, "headless");
  // The renderer stopped (idle, crash or a failure): its page disconnects.
  first.close();
  await until(() => service.getState().renderers.drawn === null, "the closed page's report still counts as drawn");
  const ensured = stub.calls.ensure;
  const capturing = service.captureImage();
  await until(() => stub.calls.ensure > ensured, "the capture did not start the renderer again");
  const second = await page("headless", "fresh");
  assert.equal((await report("headless")).status, 200);
  await until(() => captureRequests(second).length === 1, "the fresh page was not asked to capture");
  assert.equal((await post("api/capture-result", { ...captureRequests(second)[0], dataUrl: png })).status, 200);
  assert.equal((await capturing).by, "headless");
});

test("background captures take turns on the one drawing surface", { timeout: 60_000 }, async (t) => {
  const { service, post, report, page, captureRequests, until } = await routingFixture(t, "turns");
  const background = await page("headless");
  assert.equal((await report("headless")).status, 200);
  const red = service.captureImage({ width: 64, height: 48, background: "#ff0000" });
  const blue = service.captureImage({ width: 96, height: 64, background: "#0000ff" });
  await until(() => captureRequests(background).length === 1, "the first capture was not requested");
  await delay(100);
  assert.equal(captureRequests(background).length, 1, "the second capture waits until the first is answered");
  assert.equal((await post("api/capture-result", { ...captureRequests(background)[0], dataUrl: png })).status, 200);
  await red;
  await until(() => captureRequests(background).length === 2, "the second capture was not requested");
  assert.deepEqual(captureRequests(background).map(({ width, background: colour }) => [width, colour]), [[64, "#ff0000"], [96, "#0000ff"]]);
  assert.equal((await post("api/capture-result", { ...captureRequests(background)[1], dataUrl: png })).status, 200);
  await blue;
});

test("a load that no renderer can draw still opens, and says why it was not drawn", { timeout: 60_000 }, async (t) => {
  const missing = Object.assign(new Error("Headless rendering needs Playwright's Chromium."), { code: "renderer_missing" });
  const { service, report, page } = await routingFixture(t, "missing", { ensure: async () => { throw missing; } });
  const confirmed = await service.confirmRendered();
  assert.equal(confirmed.shown.drawn, null);
  assert.equal(confirmed.note, `The model loaded, but no renderer could draw it: ${missing.message} Open ${service.url} to see it.`);
  const viewed = await service.execute("fit_view", {}, { rendered: true });
  assert.equal(viewed.revision, service.getState().revision, "a view action is not failed for want of a renderer");
  await assert.rejects(service.captureImage(), { code: "renderer_missing" }, "a capture still needs an image");
  await page("viewer");
  assert.equal((await report("viewer")).status, 200);
  assert.doesNotMatch((await service.summary()).note ?? "", /no renderer could draw/, "a drawing clears the problem");
});

test("a viewer page still meshing the model it fetched gets longer before the background renderer starts", { timeout: 60_000 }, async (t) => {
  const { service, stub, report, page } = await routingFixture(t, "meshing");
  await page("viewer");
  assert.equal((await fetch(service.url + "api/model?kind=viewer&visible=1")).status, 200);
  const confirming = service.confirmRendered();
  await delay(2500);
  assert.equal(stub.calls.ensure, 0, "a page meshing its model is not raced by the background renderer");
  assert.equal((await report("viewer")).status, 200);
  assert.equal((await confirming).shown.drawn, "viewer");
});

test("a hidden viewer page that fetched the model does not hold back the background renderer", { timeout: 60_000 }, async (t) => {
  const { service, stub, report, page } = await routingFixture(t, "hidden");
  await page("viewer");
  // A hidden tab still follows the state and fetches each model, but draws nothing until it is shown.
  assert.equal((await fetch(service.url + "api/model?kind=viewer&visible=0")).status, 200);
  const confirming = service.confirmRendered();
  await delay(2500);
  assert.equal(stub.calls.ensure, 1, "the background renderer starts after the usual moment, not after the meshing allowance");
  await page("headless");
  assert.equal((await report("headless")).status, 200);
  assert.equal((await confirming).shown.drawn, "headless");
});

test("once an open page has had its grace, a background renderer that cannot start or crashes ends the wait with its reason", { timeout: 30_000 }, async (t) => {
  const missing = Object.assign(new Error("Headless rendering needs Playwright's Chromium."), { code: "renderer_missing" });
  const absent = await routingFixture(t, "absent", { ensure: async () => { throw missing; } });
  // A page that is connected but never draws, such as a hidden tab.
  await absent.page("viewer");
  const started = Date.now();
  const confirmed = await absent.service.confirmRendered();
  assert.ok(Date.now() - started < 10_000, "the wait ended long before the 90 s render timeout");
  assert.equal(confirmed.note, `The model loaded, but no renderer could draw it: ${missing.message} Open ${absent.service.url} to see it.`);

  const { service, stub, page } = await routingFixture(t, "crashing");
  await page("viewer");
  const viewing = service.execute("fit_view", {}, { rendered: true });
  for (let waited = 0; stub.calls.ensure < 1; waited += 50) {
    assert.ok(waited < 5000, "the background renderer was not started after the page's grace");
    await delay(50);
  }
  stub.crash(Object.assign(new Error("The headless renderer stopped (exit code 127: libnss3.so is missing)"), { code: "renderer_failed" }));
  await viewing;
  assert.match((await service.summary()).note, /no renderer could draw it: The headless renderer stopped \(exit code 127: libnss3\.so is missing\)/);
});
