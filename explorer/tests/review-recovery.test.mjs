import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createExplorerServer, explorerRoot, runtimeRoot, workbenchRoot } from "../server/server.mjs";
import { workbenchPython } from "../server/paths.mjs";

const execute = promisify(execFile);

async function checkBrowser(script) {
  const viewId = `recovery-${randomUUID()}`;
  const output = path.join(explorerRoot, ".local", viewId);
  await mkdir(output, { recursive: true });
  const service = await createExplorerServer({ projectRoot: workbenchRoot, viewId, log: () => {} });
  const key = createHash("sha256").update(`${service.projectRoot}\n${viewId}`).digest("hex").slice(0, 24);
  try {
    await service.initialize();
    assert.equal(service.getState().error, "");
    const result = await execute(workbenchPython, [
      "-B", path.join(explorerRoot, "tests", script),
      "--url", service.url, "--output", output,
    ], { cwd: explorerRoot, encoding: "utf8", timeout: 210_000, maxBuffer: 2 * 1024 * 1024 });
    console.log(result.stdout.trim());
    console.log(`Recovery evidence: ${output}`);
  } finally {
    await service.close();
    await rm(path.join(runtimeRoot, "reviews", key), { recursive: true, force: true });
    await rm(path.join(runtimeRoot, "views", `${key}.json`), { force: true });
  }
}

test("maintained drawing UI recovers conflicts, unconfirmed writes, local exports, and queued switching", { timeout: 240_000 }, () => checkBrowser("review-recovery-browser.py"));
test("all drawing tools, PNG clipboard equivalence, fixed viewport, resize, and reload remain usable", { timeout: 240_000 }, () => checkBrowser("v2_browser.py"));
test("reopening after reload suspends live rendering throughout pending review reads and commands", { timeout: 240_000 }, () => checkBrowser("review-reopen-browser.py"));
