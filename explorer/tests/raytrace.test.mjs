import assert from "node:assert/strict";
import test from "node:test";
import { analysisDrawn, IMAGE_SAMPLES, IMAGE_SECONDS, MAX_SAMPLES, MAX_SECONDS, SOFTWARE_SECONDS, traceAnswer, traceLimits } from "../shared/raytrace.mjs";
import { analysisKey, applyAnalysis, defaultAnalysis } from "../shared/analysis.mjs";
import { changeView, initialState } from "../server/protocol.mjs";
import { stateSummary } from "../server/summary.mjs";
import { renderOptions, traceOptions } from "../scripts/explorer.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const model = {
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  parts: [{ id: "shape", bounds: { min: [0, 0, 0], max: [1, 1, 1] }, positions: [0, 0, 0], faces: [], sectionCaps: true }],
  nodes: [{ id: "a", partId: "shape", parentId: null, matrix: identity }],
};

test("an image traces to its samples or its time, whichever comes first", () => {
  assert.deepEqual(traceLimits(), { samples: IMAGE_SAMPLES, seconds: IMAGE_SECONDS });
  assert.deepEqual(traceLimits({ samples: 16 }), { samples: 16, seconds: MAX_SECONDS }, "Samples alone take as long as they take");
  assert.deepEqual(traceLimits({ seconds: 5 }), { samples: MAX_SAMPLES, seconds: 5 }, "A time alone takes what it gets");
  assert.deepEqual(traceLimits({ samples: 32, seconds: 10 }), { samples: 32, seconds: 10 });
  for (const input of [{ samples: 0 }, { samples: 1.5 }, { samples: MAX_SAMPLES + 1 }, { seconds: 0 }, { seconds: MAX_SECONDS + 1 }, { seconds: "5" }]) {
    assert.throws(() => traceLimits(input), RangeError, JSON.stringify(input));
  }
});

test("a traced image's answer gives its samples and times, and says when software WebGL capped it", () => {
  const gpu = traceAnswer({ samples: 128, asked: 128, seconds: 6.14, waited: 7.06, stopped: "samples", software: false, renderer: "ANGLE (Apple M5)" });
  assert.deepEqual(gpu, { samples: 128, asked: 128, seconds: 6.1, waited: 7.1, stopped: "samples", renderer: "ANGLE (Apple M5)" });
  const capped = traceAnswer({ samples: 9, asked: 128, seconds: 20, waited: 77, stopped: "time", software: true, renderer: "SwiftShader" });
  assert.match(capped.note, /software WebGL.*57 s to prepare and compile.*stopped at the 20 s software limit with 9 of 128 samples/);
  const finished = traceAnswer({ samples: 16, asked: 16, seconds: 3, waited: 60, stopped: "samples", software: true, renderer: "SwiftShader" });
  assert.match(finished.note, new RegExp(`then 3 s for 16 samples\\. Software tracing stops after ${SOFTWARE_SECONDS} s`));
  assert.equal(traceAnswer(undefined), null);
  assert.equal(traceAnswer({ samples: "many" }), null);
});

test("ray traced is an appearance, kept with its finish and summarized as one", () => {
  const traced = changeView({ ...initialState(), appearance: "studio", materialFinish: "polished" }, model, "set_appearance", { mode: "raytraced" });
  assert.equal(traced.appearance, "raytraced");
  assert.equal(traced.showEdges, false, "Outlines go, as for Studio");
  assert.throws(() => changeView(initialState(), model, "set_appearance", { mode: "photo" }), { code: "bad_appearance" });
  const summary = stateSummary({ ...traced, modelName: "part.step", parts: [], renderers: { viewers: 1, seen: true, headless: false, drawn: "viewer" } }, { url: "" });
  assert.equal(summary.view.appearance, "raytraced polished");
  // The traced view leaves analysis views out, so it draws, and its images wait for, no analysis.
  const thickness = applyAnalysis(defaultAnalysis(), { map: "thickness" });
  assert.equal(analysisKey(analysisDrawn("raytraced", thickness)), analysisKey(defaultAnalysis()));
  assert.equal(analysisDrawn("studio", thickness), thickness);
});

test("--samples and --time ray trace a render or capture", () => {
  assert.deepEqual(traceOptions({}), {});
  assert.deepEqual(traceOptions({ samples: "64", time: "12.5" }), { samples: 64, seconds: 12.5 });
  assert.throws(() => traceOptions({ samples: "lots" }), /--samples needs a number/);
  assert.deepEqual(renderOptions({ time: "30", finish: "satin" }), { finish: "satin", seconds: 30 });
});
