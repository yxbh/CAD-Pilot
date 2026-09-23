import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { explorerRoot, workbenchPython, workbenchRoot } from "../server/paths.mjs";
import { runBrowser } from "./browser-fixture.mjs";
import { createTestRuntime } from "./service-fixture.mjs";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("visual section caps preserve holes, assembly gaps, picking and captured pose", { timeout: 210_000 }, async (t) => {
  const { createService } = await createTestRuntime(t);
  const viewId = `section-${randomUUID()}`;
  const output = path.join(explorerRoot, ".local", viewId);
  const fixture = path.join(output, "section-fixture.step");
  await mkdir(output, { recursive: true });
  await execute(workbenchPython, ["-B", path.join(explorerRoot, "tests", "section_browser.py"), "--output", output, "--fixtures-only"],
    { cwd: explorerRoot, timeout: 60_000 });
  const sourceHash = digest(await readFile(fixture));
  const service = await createService({ projectRoot: workbenchRoot, viewId, file: path.relative(workbenchRoot, fixture), log: () => {} });
  await service.initialize();
  assert.equal(service.getState().error, "");
  assert.equal(service.getState().documentRevision, sourceHash);
  const { stdout } = await runBrowser("section_browser.py", { url: service.url, output, timeout: 180_000 });
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.sourceHash, sourceHash);
  assert.equal(report.capPreservesHole, true);
  assert.equal(report.capPreservesHalfMillimeterGap, true);
  assert.equal(report.capBlocksClickThrough, true);
  assert.equal(report.persistence, true);
  const inspected = await service.execute("inspect_reference", { reference: report.partiallyClippedEdgeReference });
  assert.ok(inspected.edge, "A partially clipped native edge keeps its exact CAD reference");
  t.diagnostic(`Section browser evidence: ${output}`);
});
