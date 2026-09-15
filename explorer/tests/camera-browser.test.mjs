import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createExplorerServer, explorerRoot, runtimeRoot, workbenchRoot } from "../server/server.mjs";

// Build first, then run with EXPLORER_BROWSER_TESTS=1 to exercise the real R3F root.
test("live camera survives panel, viewport and DPR resizing, capture and reload", {
  skip: process.env.EXPLORER_BROWSER_TESTS !== "1", timeout: 180_000,
}, async () => {
  const viewId = `camera-resize-${randomUUID()}`;
  const key = createHash("sha256").update(`${workbenchRoot}\n${viewId}`).digest("hex").slice(0, 24);
  const service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
  try {
    await service.initialize();
    const { stdout } = await promisify(execFile)(path.join(workbenchRoot, ".venv", "Scripts", "python.exe"), [
      path.join(explorerRoot, "tests", "camera_resize.py"), "--url", service.url,
      "--output", path.join(explorerRoot, ".runtime", "camera-resize", viewId),
    ], { cwd: workbenchRoot, timeout: 165_000, maxBuffer: 2 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    assert.equal(report.cases.length, 2);
    assert.equal(report.liveProjectionMeasured, true);
  } finally {
    await service.close();
    await rm(path.join(runtimeRoot, "views", `${key}.json`), { force: true });
    await rm(path.join(runtimeRoot, "reviews", key), { force: true, recursive: true });
  }
});
