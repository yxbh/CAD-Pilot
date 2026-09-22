import assert from "node:assert/strict";
import test from "node:test";
import { parseReference } from "../shared/references.mjs";
import { runBrowser, withBrowserView } from "./browser-fixture.mjs";

test("CAD edges can be hovered, picked and copied through the live renderer", { timeout: 180_000 }, () =>
  withBrowserView("edge-picking", async ({ service, output }) => {
    const { stdout } = await runBrowser("edge_browser.py", { url: service.url, output, timeout: 150_000 });
    const report = JSON.parse(stdout);
    assert.equal(report.straightEdgePicked, true);
    assert.equal(report.curvedEdgePicked, true);
    assert.equal(report.occludedEdgeRejected, true);
    assert.equal(report.faceAndPartPickingPreserved, true);
    const copied = parseReference(report.edgeReference);
    assert.ok(copied.edgeId, "The browser must return an exact CAD edge reference");
    const inspected = await service.execute("inspect_reference", { reference: report.edgeReference });
    assert.equal(inspected.reference, report.edgeReference);
    assert.equal(inspected.topologyRevision, copied.topologyRevision);
    assert.equal(inspected.occurrence.id, copied.nodeId);
    assert.equal(inspected.edge.id, copied.edgeId);
    assert.equal(inspected.face, null);
    assert.ok(inspected.edge.length > 0);
    console.log(`Copied edge: ${report.edgeReference}`);
  }));
