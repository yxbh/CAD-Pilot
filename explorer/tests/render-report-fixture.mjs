import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createExplorerServer, explorerRoot, runtimeRoot } from "../server/server.mjs";
import { workbenchPython } from "../server/paths.mjs";
import { viewStateFile } from "./browser-fixture.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function renderReportFixture(run) {
  const local = path.join(explorerRoot, ".local");
  await mkdir(local, { recursive: true });
  const root = await mkdtemp(path.join(local, "render-reports-"));
  let service;
  const files = new Set();
  try {
    await promisify(execFile)(workbenchPython, [
      "-B", path.join(explorerRoot, "tests", "render-reports-browser.py"), "--output", root, "--fixtures-only",
    ], { timeout: 60_000, cwd: root });
    service = await createExplorerServer({ projectRoot: root, file: "a.step", log: () => {} });
    const stateFile = viewStateFile(service.projectRoot, "default");
    files.add(stateFile);
    // Import both fixtures once so every test-owned cache/snapshot is known for cleanup.
    await service.initialize();
    assert.equal(service.getState().error, "");
    const remember = () => {
      const state = service.getState();
      files.add(path.join(runtimeRoot, "models", `${state.topologyRevision}.json`));
      files.add(path.join(runtimeRoot, "inputs", `${state.documentRevision}.step`));
    };
    remember();
    await service.execute("load_file", { file: "b.step" });
    remember();
    await service.execute("load_file", { file: "a.step" });
    files.add(path.join(runtimeRoot, "inputs", `${digest(await readFile(path.join(root, "broken.step")))}.step`));
    return await run({ service, root, stateFile, files });
  } finally {
    try { await service?.close(); }
    finally {
      await Promise.all([...files].map((file) => rm(file, { force: true })));
      await rm(root, { recursive: true, force: true });
    }
  }
}
