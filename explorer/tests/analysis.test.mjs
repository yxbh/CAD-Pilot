import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisFields, analysisKey, analysisLegend, analysisReport, applyAnalysis, defaultAnalysis, directionLabel, formatNumber,
  niceScale, parseDirection, RAMPS, rampColor, validateAnalysis,
} from "../shared/analysis.mjs";
import { changeView, initialState, loadedView } from "../server/protocol.mjs";
import { stateSummary } from "../server/summary.mjs";
import { analysisOptions, renderOptions } from "../scripts/explorer.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const model = {
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  parts: [{ id: "shape", bounds: { min: [0, 0, 0], max: [1, 1, 1] }, positions: [0, 0, 0], faces: [], sectionCaps: true }],
  nodes: [{ id: "a", partId: "shape", parentId: null, matrix: identity }],
};

test("analysis settings change only what is given and refuse what they cannot draw", () => {
  const start = defaultAnalysis();
  assert.deepEqual(start, {
    map: "none", triangleEdges: false, backfaces: false, normals: false, overhangAngle: 45, buildDirection: [0, 0, 1],
    minimumWall: 1, curvature: "mean", curvatureScale: null,
  });
  const next = applyAnalysis(start, { map: "overhang", overhangAngle: 50, buildDirection: [0, 0, -3], normals: true });
  assert.deepEqual(next, { ...start, map: "overhang", overhangAngle: 50, buildDirection: [0, 0, -1], normals: true });
  assert.equal(start.map, "none", "The current settings are not changed in place");
  assert.equal(applyAnalysis(next, { curvatureScale: 0.2 }).curvatureScale, 0.2);
  assert.equal(applyAnalysis({ ...next, curvatureScale: 0.2 }, { curvatureScale: null }).curvatureScale, null);
  for (const input of [{ map: "heat" }, { overhangAngle: 90 }, { overhangAngle: -1 }, { buildDirection: [0, 0, 0] }, { buildDirection: [1, 2] },
    { minimumWall: 0 }, { curvature: "principal" }, { curvatureScale: -1 }, { triangleEdges: "yes" }, { wireframe: true }, []]) {
    assert.throws(() => applyAnalysis(start, input), /analysis|map|angle|direction|wall|curvature|true or false|Unknown/i, JSON.stringify(input));
  }
  assert.deepEqual(validateAnalysis(next), next);
  assert.throws(() => validateAnalysis({ map: "overhang" }), /lack/);
  assert.notEqual(analysisKey(start), analysisKey(next));
  assert.deepEqual(analysisFields({ ...start, map: "thickness", triangleEdges: true, normals: true }), ["thickness", "edges", "normals"]);
  assert.deepEqual(analysisFields({ ...start, map: "overhang", backfaces: true }), [], "Overhangs, zebra and back faces are drawn by the shader alone");
});

test("build directions read as axes or vectors and print back as axes", () => {
  assert.deepEqual(parseDirection("+z"), [0, 0, 1]);
  assert.deepEqual(parseDirection("-Y"), [0, -1, 0]);
  assert.ok(Object.is(parseDirection("-y")[0], 0), "No negative zero reaches the settings");
  assert.deepEqual(parseDirection("1, 0, 1"), [0.707107, 0, 0.707107]);
  assert.throws(() => parseDirection("up"), /axis/);
  assert.throws(() => parseDirection("0,0,0"), /zero/);
  assert.equal(directionLabel([0, 0, 1]), "+Z");
  assert.equal(directionLabel([-1, 0, 0]), "-X");
  assert.equal(directionLabel([0.707107, 0, 0.707107]), "(0.707, 0, 0.707)");
});

test("each colour map's legend states its scale, and overlays add keys", () => {
  const start = defaultAnalysis();
  assert.equal(analysisLegend(start), null, "Plain shading needs no legend");
  const overhang = analysisLegend({ ...start, map: "overhang", overhangAngle: 50, buildDirection: [0, -1, 0] });
  assert.match(overhang.map.title, /from vertical.*-Y/);
  assert.deepEqual(overhang.map.ticks.map(([at, label]) => [at, label]), [[0, "50°"], [1, "90° flat underside"]]);
  assert.deepEqual(overhang.keys.map((key) => key.label), ["On the build plate"]);
  const thickness = analysisLegend({ ...start, map: "thickness", minimumWall: 1.2 }, { stats: { thinnest: 0.84 } });
  assert.deepEqual(thickness.map.ticks.map(([, label]) => label), ["0", "1.2 min", "2.4", "4.8+ mm"]);
  assert.match(thickness.map.note, /Thinnest 0\.84 mm/);
  assert.match(analysisLegend({ ...start, map: "thickness" }, { pending: true }).map.note, /Measuring/);
  const curvature = analysisLegend({ ...start, map: "curvature", curvature: "gaussian" }, { stats: { curvatureScale: 0.02 } });
  assert.equal(curvature.map.title, "Gaussian curvature");
  assert.deepEqual(curvature.map.ticks.map(([, label]) => label), ["-0.02", "0", "+0.02 /mm²"]);
  assert.match(curvature.map.note, /reflects the triangulation/);
  assert.equal(analysisLegend({ ...start, map: "curvature", curvatureScale: 0.5 }, { stats: { curvatureScale: 0.02 } }).map.ticks[2][1], "+0.5 /mm",
    "A set scale wins over the fitted one");
  assert.equal(analysisLegend({ ...start, map: "zebra" }).map.ramp, null);
  const overlays = analysisLegend({ ...start, backfaces: true, normals: true }, { faults: true });
  assert.equal(overlays.map, null);
  assert.deepEqual(overlays.keys.map((key) => key.label), [
    "Back of a triangle", "Face normal, base to tip", "Open edge", "Edge on 3+ triangles", "Flipped edge", "Zero-area triangle",
  ]);
  assert.deepEqual(rampColor(RAMPS.thickness, 0), [0x7a, 0x0f, 0x17]);
  assert.deepEqual(rampColor(RAMPS.thickness, 2), [0x2f, 0x6f, 0xbf], "Values past the end take the last colour");
  assert.deepEqual(rampColor(RAMPS.curvature, 0.5), [0xec, 0xeb, 0xe6]);
  assert.deepEqual([45, 0.84, 1.234, 2.4, 4.8, 123.6, 0].map(formatNumber), ["45", "0.84", "1.23", "2.4", "4.8", "124", "0"]);
  assert.deepEqual([0.13, 0.2, 0.31, 0.7, 7, 0].map(niceScale), [0.2, 0.2, 0.5, 1, 10, 1]);
});

test("set_analysis is a display preference: kept across loads and summarized with its legend's numbers", () => {
  const state = { ...initialState(), modelName: "part.step", revision: 3 };
  const changed = changeView(state, model, "set_analysis", { map: "thickness", minimumWall: 0.8, triangleEdges: true, expectedRevision: 3 });
  assert.equal(changed.analysis.map, "thickness");
  assert.equal(changed.analysis.minimumWall, 0.8);
  assert.equal(changed.revision, 4);
  assert.throws(() => changeView(state, model, "set_analysis", {}), { code: "bad_analysis" });
  assert.throws(() => changeView(state, model, "set_analysis", { map: "heat" }), { code: "bad_analysis" });
  const reloaded = loadedView(changed, null, model, { modelName: "other.stl", source: { file: "other.stl" } });
  assert.deepEqual(reloaded.analysis, changed.analysis, "Another file opens with the same analysis view");
  const summarized = (stats) => stateSummary({
    ...changed, parts: [], renderers: { viewers: 1, seen: true, headless: false, drawn: "viewer" },
  }, { url: "http://x/", drawnAnalysis: stats }).view.analysis;
  assert.deepEqual(summarized({ thinnest: 0.6, curvatureScale: 2 }), { map: "thickness", minimumWall: 0.8, thinnest: 0.6, overlays: ["triangle edges"] });
  assert.deepEqual(summarized(undefined), { map: "thickness", minimumWall: 0.8, overlays: ["triangle edges"] });
  assert.equal(stateSummary({ ...state, parts: [], renderers: { viewers: 0, seen: false, headless: false, drawn: null } }, { url: "" }).view.analysis, undefined,
    "Plain shading is not mentioned");
  assert.deepEqual(analysisReport({ ...defaultAnalysis(), map: "curvature" }, { thinnest: 1, curvatureScale: 0.5 }),
    { map: "curvature", kind: "mean", scale: "auto", curvatureScale: 0.5 });
});

test("render and capture flags spell set_analysis inputs, choosing the map their settings belong to", () => {
  assert.equal(analysisOptions({ size: "10x10" }), undefined);
  assert.deepEqual(analysisOptions({ overhang: "50:-y" }), { map: "overhang", overhangAngle: 50, buildDirection: [0, -1, 0] });
  assert.deepEqual(analysisOptions({ overhang: ":0,1,1" }), { map: "overhang", buildDirection: [0, 0.707107, 0.707107] });
  assert.deepEqual(analysisOptions({ wall: "1.5", map: "thickness" }), { map: "thickness", minimumWall: 1.5 });
  assert.deepEqual(analysisOptions({ curvature: "gaussian:0.01" }), { map: "curvature", curvature: "gaussian", curvatureScale: 0.01 });
  assert.deepEqual(analysisOptions({ overlays: "triangles,normals" }), { triangleEdges: true, backfaces: false, normals: true });
  assert.deepEqual(analysisOptions({ overlays: "none", map: "zebra" }), { map: "zebra", triangleEdges: false, backfaces: false, normals: false });
  for (const [flags, message] of [[{ wall: "1", map: "zebra" }, /--wall belongs to --map thickness, not --map zebra/],
    [{ overhang: "30", wall: "1" }, /--wall belongs to --map thickness, not --overhang/], [{ map: "heat" }, /--map takes/],
    [{ overlays: "wireframe" }, /--overlays takes/], [{ overlays: "" }, /--overlays takes/], [{ overhang: "steep" }, /--overhang needs a number/],
    [{ overhang: "45:up" }, /--overhang: A build direction/]]) {
    assert.throws(() => analysisOptions(flags), message, JSON.stringify(flags));
  }
  assert.deepEqual(renderOptions({ map: "zebra", outlines: "off" }), { outlines: false, analysis: { map: "zebra" } });
});
