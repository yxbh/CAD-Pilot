import assert from "node:assert/strict";
import test from "node:test";
import { runBrowser, withBrowserView } from "./browser-fixture.mjs";

test("live camera survives panel, viewport and DPR resizing, capture and reload", { timeout: 180_000 }, () =>
  withBrowserView("camera-resize", async ({ service, output }) => {
    const { stdout } = await runBrowser("camera_resize.py", { url: service.url, output, timeout: 165_000 });
    const report = JSON.parse(stdout);
    assert.equal(report.cases.length, 2);
    assert.equal(report.liveProjectionMeasured, true);
  }));
