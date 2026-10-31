import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHeadlessRenderer, findChromium } from "../server/renderer.mjs";
import { createTestRuntime } from "./service-fixture.mjs";
import { workbenchRoot } from "../server/paths.mjs";

function fakeBrowser() {
  const launches = [];
  const launch = (executable, args) => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), exitCode: null, args });
    child.kill = () => { child.exitCode = 0; setImmediate(() => child.emit("exit", 0, null)); };
    launches.push(child);
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  return { launches, launch };
}

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

test("the renderer starts once on demand, stops when idle, retries once in software and reports a crash", async () => {
  const { launches, launch } = fakeBrowser();
  const exits = [];
  const renderer = createHeadlessRenderer({ url: "http://127.0.0.1:1/token/", idleMs: 50, find: async () => "/chrome", launch, onExit: (error) => exits.push(error) });
  await Promise.all([renderer.ensure(), renderer.ensure()]);
  assert.equal(launches.length, 1);
  assert.ok(renderer.running);
  assert.ok(launches[0].args.includes("--remote-debugging-pipe"), "Chromium exits with this process through its pipe");
  assert.equal(launches[0].args.at(-1), "http://127.0.0.1:1/token/?renderer=headless");
  await delay(120);
  assert.equal(renderer.running, false, "an idle renderer stops");
  assert.deepEqual(exits, [], "an intentional stop is not a failure");
  await renderer.ensure();
  assert.equal(await renderer.fallBack(), true);
  assert.equal(launches.length, 3);
  assert.ok(launches[2].args.includes("--use-angle=swiftshader"));
  assert.equal(await renderer.fallBack(), false, "software rendering is the last resort");
  launches[2].stderr.emit("data", Buffer.from("FATAL: GPU process crashed\n"));
  launches[2].exitCode = 1;
  launches[2].emit("exit", 1, null);
  assert.equal(renderer.running, false);
  assert.match(exits[0].message, /GPU process crashed/);
  await renderer.close();
  await assert.rejects(renderer.ensure(), { code: "closed" });
});

// A stand-in renderer whose page never draws, so the test controls every report.
function stubRenderer() {
  const calls = { ensure: 0, fallBack: 0, stop: 0 };
  let failure = null;
  const factory = ({ onExit }) => {
    failure = onExit;
    return {
      running: false,
      async ensure() { calls.ensure++; },
      touch() {},
      async fallBack() { calls.fallBack++; return calls.fallBack === 1; },
      async stop() { calls.stop++; },
      async close() {},
    };
  };
  return { calls, factory, crash: (error) => failure(error) };
}

test("views without a viewer page start the background renderer; an answering page is given a moment first", { timeout: 60_000 }, async (t) => {
  const runtime = await createTestRuntime(t);
  const stub = stubRenderer();
  const service = await runtime.createService({ projectRoot: workbenchRoot, viewId: "routing", renderer: stub.factory, log: () => {} });
  await service.initialize();
  const report = (state, kind) => fetch(service.url + "api/rendered", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: state.revision, modelHash: state.documentRevision, topologyRevision: state.topologyRevision, kind }),
  });

  const confirming = service.confirmRendered();
  await delay(50);
  assert.equal(stub.calls.ensure, 1, "with no viewer page the background renderer starts at once");
  assert.equal((await report(service.getState(), "headless")).status, 200);
  const confirmed = await confirming;
  assert.equal(confirmed.shown.drawn, "headless");
  assert.match(confirmed.note, /No viewer page is open/);

  const abort = new AbortController();
  t.after(() => abort.abort());
  await fetch(service.url + "api/events?kind=viewer&client=page", { signal: abort.signal });
  const viewing = service.execute("fit_view", {}, { rendered: true });
  await delay(300);
  assert.equal(stub.calls.ensure, 1, "an open viewer page gets a moment to answer");
  assert.equal((await report(service.getState(), "viewer")).status, 200);
  await viewing;
  assert.equal(service.getState().renderers.seen, true);

  // A page that cannot create a WebGL context restarts once in software; a second failure is reported.
  const capturing = service.captureImage();
  void capturing.catch(() => {});
  const failed = (webgl) => fetch(service.url + "api/renderer-error", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Error creating WebGL context", webgl }),
  });
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
