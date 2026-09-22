import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { explorerRoot, workbenchRoot } from "../server/paths.mjs";
import { workbenchPython } from "../server/paths.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

const execute = promisify(execFile);

export async function runBrowser(script, { url, output, timeout = 210_000 }) {
  const result = await execute(workbenchPython, [
    "-B", path.join(explorerRoot, "tests", script), "--url", url, "--output", output,
  ], { cwd: explorerRoot, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.stderr) console.error(result.stderr.trim());
  return result;
}

export async function withBrowserView(name, run) {
  const viewId = `${name}-${randomUUID()}`;
  const output = path.join(explorerRoot, ".local", viewId);
  await mkdir(output, { recursive: true });
  const runtime = await createTestRuntime();
  try {
    const service = await runtime.createService({ projectRoot: workbenchRoot, viewId });
    await service.initialize();
    assert.equal(service.getState().error, "");
    return await run({ service, output });
  } finally {
    await runtime.dispose();
  }
}

export async function checkBrowser(script) {
  return withBrowserView(path.basename(script, ".py"), async ({ service, output }) => {
    const result = await runBrowser(script, { url: service.url, output });
    console.log(result.stdout.trim());
    console.log(`Browser evidence: ${output}`);
  });
}
