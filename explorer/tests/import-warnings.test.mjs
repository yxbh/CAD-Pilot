import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createExplorerServer, explorerRoot, runtimeRoot, workbenchRoot } from "../server/server.mjs";
import { workbenchPython } from "../server/paths.mjs";

test("import warning details are dismissible without blocking explosion controls", { timeout: 180_000 }, async () => {
  const viewId = `import-warnings-${randomUUID()}`;
  const output = path.join(explorerRoot, ".local", viewId);
  await mkdir(output, { recursive: true });
  const service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
  const key = createHash("sha256").update(`${service.projectRoot}\n${viewId}`).digest("hex").slice(0, 24);
  try {
    await service.initialize();
    assert.equal(service.getState().error, "");
    const { stdout, stderr } = await promisify(execFile)(workbenchPython, [
      "-B", path.join(explorerRoot, "tests", "import-warnings-browser.py"), "--url", service.url, "--output", output,
    ], { cwd: explorerRoot, encoding: "utf8", timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
    console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    console.log(`Import warning evidence: ${output}`);
  } finally {
    await service.close();
    await rm(path.join(runtimeRoot, "reviews", key), { recursive: true, force: true });
    await rm(path.join(runtimeRoot, "views", `${key}.json`), { force: true });
  }
});
