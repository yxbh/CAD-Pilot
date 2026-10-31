import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runPython } from "./python-host.mjs";
import { createTestRuntime, viewStateFile } from "./service-fixture.mjs";

export async function renderReportFixture(run) {
  const runtime = await createTestRuntime();
  const root = path.join(runtime.runtimeRoot, "project");
  try {
    await mkdir(root);
    await runPython("render-reports-browser.py", ["--output", root, "--fixtures-only"], { timeout: 60_000 });
    const service = await runtime.createService({ projectRoot: root, file: "a.step", log: () => {} });
    const stateFile = viewStateFile(runtime.runtimeRoot, service.projectRoot, "default");
    await service.initialize();
    assert.equal(service.getState().error, "");
    return await run({ service, root, stateFile });
  } finally {
    await runtime.dispose();
  }
}
