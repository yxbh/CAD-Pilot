import assert from "node:assert/strict";
import test from "node:test";
import { runBrowser, withBrowserView } from "./browser-fixture.mjs";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not ${expected}`);

test("assembly steps settle before renders and captures, follow the section range and survive cancelled drags", { timeout: 210_000 }, () =>
  withBrowserView("assembly", async ({ service, output }) => {
    const { stdout } = await runBrowser("assembly_browser.py", { url: service.url, output, timeout: 180_000 });
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.reportedWhileMoving, false, "the renderer must not acknowledge a step while its parts are moving");
    assert.equal(report.capturedStep, 0);
    assert.equal(report.renderedStep, 0);
    assert.deepEqual(report.apart, {
      "Base plate": 0, "Spacer 1": 45, "Spacer 2": 45, "Spacer 3": 45, "Spacer 4": 45, "Cover plate": 70,
    });
    assert.equal(report.buildupVisibleParts, 1, "build-up hides parts until their step");
    near(report.sectionMax.assembled, 35);
    near(report.sectionMax.exploded, 105);
    near(report.sectionMax.buildup, 4);
    assert.equal(report.afterCancelStep, 1);
    assert.deepEqual(report.afterCancelLift, {
      "Base plate": 0, "Spacer 1": 0, "Spacer 2": 0, "Spacer 3": 0, "Spacer 4": 0, "Cover plate": 70,
    });
    assert.equal(report.offStep, null);
    assert.ok(Object.values(report.offLift).every((value) => value === 0), JSON.stringify(report.offLift));
    console.log(`Assembly browser evidence: ${output}`);
  }));
