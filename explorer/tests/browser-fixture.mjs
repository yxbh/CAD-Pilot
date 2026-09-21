import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createExplorerServer, explorerRoot, runtimeRoot, workbenchRoot } from "../server/server.mjs";
import { workbenchPython } from "../server/paths.mjs";

const execute = promisify(execFile);

export function viewStateFile(projectRoot, viewId) {
  const key = createHash("sha256").update(`${projectRoot}\n${viewId}`).digest("hex").slice(0, 24);
  return path.join(runtimeRoot, "views", `${key}.json`);
}

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
  const service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
  const stateFile = viewStateFile(service.projectRoot, viewId);
  try {
    await service.initialize();
    assert.equal(service.getState().error, "");
    return await run({ service, output });
  } finally {
    try { await service.close(); }
    finally {
      await rm(path.join(runtimeRoot, "reviews", path.basename(stateFile, ".json")), { recursive: true, force: true });
      await rm(stateFile, { force: true });
    }
  }
}

export async function checkBrowser(script) {
  return withBrowserView(path.basename(script, ".py"), async ({ service, output }) => {
    const result = await runBrowser(script, { url: service.url, output });
    console.log(result.stdout.trim());
    console.log(`Browser evidence: ${output}`);
  });
}
