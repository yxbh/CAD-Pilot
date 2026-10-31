import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { workbenchRoot } from "../server/paths.mjs";
import { runBrowser, withBrowserView } from "./browser-fixture.mjs";

test("a faulty scan-like mesh opens beside a STEP, shows its faults, takes point picks, cuts open and draws in the background", { timeout: 300_000 }, () =>
  withBrowserView("mesh", async ({ service, output }) => {
    const { stdout } = await runBrowser("mesh_browser.py", { url: service.url, output, timeout: 270_000 });
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.ghosts, 1, "An added file is a ghost unless asked otherwise");
    assert.match(report.beside, / \+ scan\.stl$/);
    assert.equal(report.aloneTriangles, report.triangles, "Every triangle in the file is in the drawn surface, none converted or dropped");
    assert.ok(report.faults.openEdges > 0 && report.faults.oversharedEdges > 0 && report.faults.flippedEdges > 0, JSON.stringify(report.faults));
    assert.equal(report.faults.degenerateTriangles, 1);
    // Counted from the overlay objects mounted in the scene, against the manifest's counts.
    assert.equal(report.faultMarks, report.faults.openEdges + report.faults.oversharedEdges + report.faults.flippedEdges + report.faults.degenerateTriangles);
    assert.ok(report.point.triangle >= 0 && report.point.triangle < report.triangles);
    assert.ok(Math.hypot(report.pointScreen[0] - report.clicked[0], report.pointScreen[1] - report.clicked[1]) < 3, "The marker sits where the user clicked");
    assert.ok(report.inspectedDistance < 0.01, "The picked point lies on the triangle the reference names");
    assert.ok(report.inspectedWorldZ > 0, "Seen from above, the pick is on the top of the ring");
    assert.equal(report.section.enabled, true, "Open meshes can be cut");
    assert.ok(report.outlineSegments > 0, "and the cut is outlined where it crosses the mesh");

    // With the page closed, the background renderer draws the same mesh view. Captures are stored by content, so a
    // different file means a different image: the fault overlay is drawn, and an added file sits where the view puts it.
    const capture = () => service.captureImage({ width: 320, height: 240 });
    const faulted = await capture();
    assert.equal(faulted.by, "headless");
    await service.execute("set_faults", { visible: false });
    assert.notEqual((await capture()).path, faulted.path, "The background renderer draws the fault overlay");
    const scan = path.relative(workbenchRoot, path.join(output, "scan.stl")).split(path.sep).join("/");
    await service.execute("add_file", { file: scan, style: "solid" });
    const together = await capture();
    await service.execute("set_file", { id: "ref1", offset: [0, 0, 200] });
    assert.notEqual((await capture()).path, together.path, "and places the added file as the view does");
    console.log(`Mesh browser evidence: ${output} (scan load ${report.loadSeconds} s)`);
  }));
