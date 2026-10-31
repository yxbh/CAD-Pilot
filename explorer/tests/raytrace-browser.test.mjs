import assert from "node:assert/strict";
import test from "node:test";
import { runBrowser, withBrowserView } from "./browser-fixture.mjs";

test("the ray-traced view is set from the page's appearance settings and traced by the background renderer to a sample count", { timeout: 420_000 }, () =>
  withBrowserView("raytrace", async ({ service, output }) => {
    const { stdout } = await runBrowser("raytrace_browser.py", { url: service.url, output, timeout: 120_000 });
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.appearance, "raytraced");
    assert.equal(report.studioPressed, "true", "Ray traced is Studio's light, traced");
    assert.match(report.status, /Preparing the ray-traced view|Compiling the path tracer|Ray traced · \d+ of 512 samples|Ray tracing needs a GPU/);

    // With the page closed, the background renderer traces the image to the samples asked for: it compiles the tracer
    // first, which software WebGL takes about a minute over and says so.
    const traced = await service.captureImage({ width: 200, height: 150, samples: 3, seconds: 30 });
    assert.equal(traced.by, "headless");
    assert.equal(traced.raytrace.asked, 3);
    assert.ok(traced.raytrace.samples >= 1 && traced.raytrace.samples <= 3, JSON.stringify(traced.raytrace));
    assert.ok(traced.raytrace.renderer.length > 0);
    assert.ok(traced.raytrace.waited >= traced.raytrace.seconds);
    if (/SwiftShader|llvmpipe|Basic Render/i.test(traced.raytrace.renderer)) assert.match(traced.raytrace.note, /software WebGL/);
    else assert.equal(traced.raytrace.note, undefined);
    await service.execute("set_appearance", { mode: "studio" });
    const studio = await service.captureImage({ width: 200, height: 150 });
    assert.equal(studio.raytrace, undefined);
    assert.notEqual(studio.path, traced.path, "Studio's raster view is another picture");
    await assert.rejects(service.captureImage({ samples: 0 }), { code: "bad_capture" });
    console.log(`Ray-trace browser evidence: ${output} (${JSON.stringify(traced.raytrace)})`);
  }));
