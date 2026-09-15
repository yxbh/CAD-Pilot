import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import { createViewRegistry } from "../server/view-registry.mjs";
import { acquireViewOwner } from "../server/view-owner.mjs";
import { canonicalProjectRoot, explorerRoot, runtimeRoot, workbenchRoot } from "../server/paths.mjs";
import { createExplorerServer } from "../server/server.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options = { projectRoot: workbenchRoot, viewId: "registry-test" };
function fixture({ initialized, closing } = {}) {
  const calls = { created: 0, initialized: 0, closed: 0, files: [], contexts: [] };
  const created = deferred();
  const registry = createViewRegistry({
    canonicalize: async () => workbenchRoot,
    createService: async (context) => {
      calls.created++;
      calls.contexts.push(context);
      const service = {
        url: `http://127.0.0.1/${calls.created}`,
        async initialize() { calls.initialized++; created.resolve(); await initialized?.promise; },
        async close() { calls.closed++; await closing?.promise; },
        async execute(name, input) { calls.files.push([name, input.file]); },
      };
      return service;
    },
  });
  return { registry, calls, created };
}

test("canonical project spellings and concurrent same-panel opens share one initialized service", async () => {
  const initialized = deferred();
  const { registry, calls, created } = fixture({ initialized });
  const a = registry.open("a", { ...options, file: "part.step" });
  const b = registry.open("a", { ...options, projectRoot: workbenchRoot.toLowerCase(), file: "part.step" });
  await created.promise;
  assert.equal(calls.created, 1);
  initialized.resolve();
  assert.equal(await a, await b);
  assert.equal(calls.initialized, 1);
  assert.deepEqual(calls.files, []);
  assert.equal(calls.contexts[0].firstPanel(), "a");
  await assert.rejects(registry.open("b", { ...options, projectRoot: workbenchRoot.toLowerCase() }),
    (error) => error.code === "view_already_open" && error.message.includes('"a"'));
  assert.equal(calls.created, 1);
  await registry.close("a");
  assert.equal(calls.closed, 1);
});

test("same-panel opens deduplicate, and a pending close cannot delete a replacement", async () => {
  const closing = deferred();
  const { registry, calls } = fixture({ closing });
  const [a, again] = await Promise.all([registry.open("a", options), registry.open("a", options)]);
  assert.equal(a, again);
  assert.equal(calls.created, 1);
  const close = registry.close("a");
  const next = registry.open("b", options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.created, 1, "Replacement must wait for the previous service to release ownership");
  closing.resolve();
  await close;
  assert.notEqual(await next, a);
  assert.equal(registry.serviceFor("b").url, "http://127.0.0.1/2");
  await registry.close("a");
  assert.equal(calls.closed, 1, "Closing an old panel must not close the new owner");
  await registry.close("b");
  assert.equal(calls.closed, 2);
});

test("closing during initialization releases the service once, without orphaning it", async () => {
  const initialized = deferred();
  const { registry, calls, created } = fixture({ initialized });
  const opened = registry.open("a", options);
  await created.promise;
  const closed = registry.close("a");
  initialized.resolve();
  await opened;
  await closed;
  assert.equal(calls.closed, 1);
  assert.throws(() => registry.serviceFor("a"), /Open the CAD Explorer/);
  await registry.shutdown();
});

test("failed initialization closes its service and permits a new attempt", async () => {
  let created = 0;
  let closed = 0;
  const registry = createViewRegistry({
    canonicalize: async () => workbenchRoot,
    createService: async () => {
      const number = ++created;
      return {
        async initialize() { if (number === 1) throw new Error("Initialization failed"); },
        async close() { closed++; },
      };
    },
  });
  await assert.rejects(registry.open("a", options), /Initialization failed/);
  assert.equal(closed, 1);
  await registry.open("a", options);
  await registry.close("a");
  assert.equal(created, 2);
  assert.equal(closed, 2);
});

test("shutdown waits for in-flight creation and rejects new opens", async () => {
  const initialized = deferred();
  const { registry, calls, created } = fixture({ initialized });
  const opened = registry.open("a", options);
  const rejected = assert.rejects(opened, /stopping/);
  await created.promise;
  const stopped = registry.shutdown();
  initialized.resolve();
  await rejected;
  await stopped;
  assert.equal(calls.closed, 1);
  await assert.rejects(registry.open("b", options), /stopping/);
});

test("filesystem canonicalization and an OS-owned lease prevent duplicate durable writers", async () => {
  const root = await canonicalProjectRoot(workbenchRoot);
  const alternate = process.platform === "win32" ? workbenchRoot.toLowerCase() : path.join(workbenchRoot, ".");
  assert.equal(await canonicalProjectRoot(alternate), root);
  const viewId = `owner-${randomUUID()}`;
  const first = await createExplorerServer({ projectRoot: root, viewId });
  try {
    await assert.rejects(createExplorerServer({ projectRoot: alternate, viewId }), (error) => error.code === "view_in_use");
  } finally { await first.close(); }
  const reopened = await createExplorerServer({ projectRoot: root, viewId });
  await reopened.close();
  await reopened.close();
});

test("view ownership tolerates temporary directories longer than Unix socket limits", { skip: process.platform === "win32" }, async () => {
  const deepTemporaryRoot = path.join(runtimeRoot, "temporary-directory-segment".repeat(6));
  await mkdir(deepTemporaryRoot, { recursive: true });
  const viewKey = `long-temp-${randomUUID()}`;
  const moduleUrl = pathToFileURL(path.join(explorerRoot, "server", "view-owner.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import {acquireViewOwner} from ${JSON.stringify(moduleUrl)}; const release = await acquireViewOwner(${JSON.stringify(runtimeRoot)}, ${JSON.stringify(viewKey)}); await release(); process.stdout.write("released");`,
  ], { env: { ...process.env, TMPDIR: deepTemporaryRoot }, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(Buffer.concat(output).toString(), "released");
});

test("Windows releases view ownership after the owning process is terminated", { skip: process.platform !== "win32" }, async () => {
  const viewKey = `crash-${randomUUID()}`;
  const moduleUrl = pathToFileURL(path.join(explorerRoot, "server", "view-owner.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import {acquireViewOwner} from ${JSON.stringify(moduleUrl)}; await acquireViewOwner(${JSON.stringify(runtimeRoot)}, ${JSON.stringify(viewKey)}); process.stdout.write("owned"); setInterval(()=>{},1000);`,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    await once(child.stdout, "data");
    await assert.rejects(acquireViewOwner(runtimeRoot, viewKey), (error) => error.code === "view_in_use");
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
    const release = await acquireViewOwner(runtimeRoot, viewKey);
    await release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
  }
});
