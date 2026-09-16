import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createExplorerServer, explorerRoot, inspectReference, runtimeRoot, workbenchRoot } from "../server/server.mjs";
import { workbenchPython } from "../server/paths.mjs";
import { parseReference } from "../shared/references.mjs";

test("CAD edges can be hovered, picked and copied through the live renderer", { timeout: 180_000 }, async () => {
  const viewId = `edge-picking-${randomUUID()}`;
  const service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
  const key = createHash("sha256").update(`${service.projectRoot}\n${viewId}`).digest("hex").slice(0, 24);
  try {
    await service.initialize();
    assert.equal(service.getState().error, "");
    const { stdout } = await promisify(execFile)(workbenchPython, [
      "-B", path.join(explorerRoot, "tests", "edge_browser.py"), "--url", service.url,
      "--output", path.join(explorerRoot, ".local", viewId),
    ], { cwd: workbenchRoot, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    assert.equal(report.straightEdgePicked, true);
    assert.equal(report.curvedEdgePicked, true);
    assert.equal(report.occludedEdgeRejected, true);
    assert.equal(report.faceAndPartPickingPreserved, true);
    const copied = parseReference(report.edgeReference);
    assert.ok(copied.edgeId, "The browser must return an exact CAD edge reference");
    const inspected = await inspectReference(report.edgeReference);
    assert.equal(inspected.reference, report.edgeReference);
    assert.equal(inspected.topologyRevision, copied.topologyRevision);
    assert.equal(inspected.occurrence.id, copied.nodeId);
    assert.equal(inspected.edge.id, copied.edgeId);
    assert.equal(inspected.face, null);
    assert.ok(inspected.edge.length > 0);
    console.log(`Copied edge: ${report.edgeReference}`);
  } finally {
    await service.close();
    await rm(path.join(runtimeRoot, "views", `${key}.json`), { force: true });
    await rm(path.join(runtimeRoot, "reviews", key), { force: true, recursive: true });
  }
});
