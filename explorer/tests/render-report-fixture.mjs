import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { explorerRoot, workbenchPython } from "../server/paths.mjs";
import { createTestRuntime, viewStateFile } from "./service-fixture.mjs";

export async function renderReportFixture(run) {
  const runtime = await createTestRuntime();
  const root = path.join(runtime.runtimeRoot, "project");
  try {
    await mkdir(root);
    await promisify(execFile)(workbenchPython, [
      "-B", path.join(explorerRoot, "tests", "render-reports-browser.py"), "--output", root, "--fixtures-only",
    ], { timeout: 60_000, cwd: root });
    const service = await runtime.createService({ projectRoot: root, file: "a.step", log: () => {} });
    const stateFile = viewStateFile(runtime.runtimeRoot, service.projectRoot, "default");
    await service.initialize();
    assert.equal(service.getState().error, "");
    return await run({ service, root, stateFile });
  } finally {
    await runtime.dispose();
  }
}
