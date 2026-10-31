import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBuilt } from "../server/launcher.mjs";
import { explorerRoot, workbenchRoot } from "../server/paths.mjs";
import { createHeadlessRenderer } from "../server/renderer.mjs";
import { runPython } from "./python-host.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

export async function runBrowser(script, { url, output, timeout = 210_000 }) {
  await assertBuilt();
  const result = await runPython(script, ["--url", url, "--output", output], { timeout });
  if (result.stderr) console.error(result.stderr.trim());
  return result;
}

// The demo assembly and its sequence, written once per test process. Each browser test's runtime gets a copy, where
// the service finds it and skips building it again; core tests still build it themselves.
let demo;
function demoTemplate() {
  demo ??= (async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-demo-"));
    process.once("exit", () => rmSync(folder, { recursive: true, force: true }));
    await runPython(path.join(explorerRoot, "python", "create_demo.py"), ["--output", path.join(folder, "demo-assembly.step")]);
    return folder;
  })();
  return demo;
}

export async function withBrowserView(name, run) {
  const viewId = `${name}-${randomUUID()}`;
  const output = path.join(explorerRoot, ".local", viewId);
  await mkdir(output, { recursive: true });
  const t0 = performance.now();
  const mark = (what) => console.error(`[timing] ${name} ${what} at ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  const runtime = await createTestRuntime();
  try {
    await cp(await demoTemplate(), runtime.runtimeRoot, { recursive: true });
    mark("demo copied");
    const service = await runtime.createService({ projectRoot: workbenchRoot, viewId, renderer: createHeadlessRenderer });
    mark("service created");
    await service.initialize();
    mark("initialized");
    assert.equal(service.getState().error, "");
    return await run({ service, output });
  } finally {
    mark("scenario done");
    await runtime.dispose();
    mark("disposed");
  }
}

export async function checkBrowser(script) {
  return withBrowserView(path.basename(script, ".py"), async ({ service, output }) => {
    const result = await runBrowser(script, { url: service.url, output });
    console.log(result.stdout.trim());
    console.log(`Browser evidence: ${output}`);
  });
}
