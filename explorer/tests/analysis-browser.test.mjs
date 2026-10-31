import assert from "node:assert/strict";
import test from "node:test";
import { runBrowser, withBrowserView } from "./browser-fixture.mjs";

test("analysis views draw on STEP and mesh parts alike, with legends, from the page, commands and background captures", { timeout: 300_000 }, () =>
  withBrowserView("analysis", async ({ service, output }) => {
    const { stdout } = await runBrowser("analysis_browser.py", { url: service.url, output, timeout: 270_000 });
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(report.pageErrors, []);
    // Every demo part is coloured, with triangle edges and normal arrows mounted over it.
    assert.equal(report.step.analysisSurfaces, report.parts);
    assert.ok(report.step.triangleEdgeSegments > 0 && report.step.normalArrows > 0, JSON.stringify(report.step));
    assert.match(report.stepLegend, /Overhang from vertical.*\+Z.*45°.*On the build plate.*Back of a triangle.*Face normal/);
    assert.equal(report.stepThinnest, 4, "The demo's plates are 4 mm thick");
    // A closed mesh has three edges per triangle, each shared by two.
    assert.equal(report.meshEdges, report.triangles * 1.5);
    assert.ok(Math.abs(report.meshThinnest - 2) < 1e-3, `The plate is 2 mm thick, not ${report.meshThinnest}`);
    assert.ok(report.curvatureScale > 0);
    assert.match(report.curvatureLegend, /Mean curvature.*reflects the triangulation/);
    assert.equal(report.zebraSurfaces, 1, "The page's Analysis panel set the map");

    // With the page closed, the background renderer draws the same views, legend included. Captures are stored by
    // content, so a different file means a different image.
    const capture = (analysis) => service.captureImage({ width: 360, height: 260, ...(analysis ? { analysis } : {}) });
    await service.execute("set_analysis", { map: "none" });
    const plain = await capture();
    assert.equal(plain.by, "headless");
    assert.equal(plain.analysis, undefined);
    // On a closed, consistent mesh no back face shows; only the legend's key changes the image.
    const keyed = await capture({ backfaces: true });
    assert.notEqual(keyed.path, plain.path, "The legend is drawn into the capture");
    const thickness = await capture({ map: "thickness", minimumWall: 1 });
    assert.equal(thickness.analysis.map, "thickness");
    assert.ok(Math.abs(thickness.analysis.thinnest - 2) < 1e-3, JSON.stringify(thickness.analysis));
    assert.equal(service.getState().analysis.map, "none", "A capture's own analysis leaves the view's alone");
    // A capture's settings can arrive before the last one's result is acknowledged; its own still apply.
    assert.equal((await capture()).path, plain.path, "and the next capture draws the view's own again");
    await assert.rejects(service.captureImage({ analysis: { map: "heat" } }), { code: "bad_analysis" });
    console.log(`Analysis browser evidence: ${output}`);
  }));
