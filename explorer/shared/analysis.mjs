// Analysis views: colour maps and overlays that show the triangles a view draws, for STEP previews and meshes alike.
// The settings, their validation, the colours and the legend that explains them are shared by the server, the page
// and the background renderer, so each draws and describes a view the same way.

export const ANALYSIS_MAPS = ["none", "overhang", "thickness", "curvature", "zebra"];
export const CURVATURE_KINDS = ["mean", "gaussian"];
const FLAGS = ["triangleEdges", "backfaces", "normals"];
const KEYS = ["map", ...FLAGS, "overhangAngle", "buildDirection", "minimumWall", "curvature", "curvatureScale"];

export function defaultAnalysis() {
  return {
    map: "none", triangleEdges: false, backfaces: false, normals: false,
    // Angles are from vertical, as the fdm-design skill states them: 0 is an upright wall, 90 a flat underside.
    overhangAngle: 45, buildDirection: [0, 0, 1], minimumWall: 1, curvature: "mean", curvatureScale: null,
  };
}

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function unit(vector) {
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(finite)) throw new TypeError("A build direction is three numbers, X, Y and Z");
  const length = Math.hypot(...vector);
  if (length < 1e-9) throw new RangeError("A build direction cannot be zero");
  return vector.map((value) => Math.round(value / length * 1e6) / 1e6 + 0);
}

// "+z", "-x", "y" or "0,0,1", as the command line spells a direction.
export function parseDirection(text) {
  const axis = /^([+-]?)([xyz])$/i.exec(String(text).trim());
  if (axis) return AXES[axis[2].toLowerCase()].map((value) => axis[1] === "-" ? 0 - value : value);
  const parts = String(text).split(",").map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => part === "" || !Number.isFinite(Number(part)))) {
    throw new TypeError(`A build direction is an axis such as +z or -y, or three numbers such as 0,0,1; got "${text}"`);
  }
  return unit(parts.map(Number));
}

export function directionLabel(vector) {
  for (const [name, axis] of Object.entries(AXES)) {
    for (const sign of [1, -1]) if (axis.every((value, index) => value * sign === vector[index])) return `${sign > 0 ? "+" : "-"}${name.toUpperCase()}`;
  }
  return `(${vector.map((value) => Math.round(value * 1000) / 1000).join(", ")})`;
}

/** The settings after a set_analysis input; throws a TypeError or RangeError that names the problem. */
export function applyAnalysis(current, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Analysis settings must be an object");
  const unknown = Object.keys(input).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw new TypeError(`Unknown analysis setting ${unknown.join(", ")}`);
  const next = { ...current };
  if (input.map !== undefined) {
    if (!ANALYSIS_MAPS.includes(input.map)) throw new TypeError(`Choose a map from ${ANALYSIS_MAPS.join(", ")}`);
    next.map = input.map;
  }
  for (const flag of FLAGS) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== "boolean") throw new TypeError(`${flag} must be true or false`);
    next[flag] = input[flag];
  }
  if (input.overhangAngle !== undefined) {
    if (!finite(input.overhangAngle) || input.overhangAngle < 0 || input.overhangAngle >= 90) {
      throw new RangeError("The overhang angle is from vertical, from 0 up to but not including 90 degrees");
    }
    next.overhangAngle = input.overhangAngle;
  }
  if (input.buildDirection !== undefined) next.buildDirection = unit(input.buildDirection);
  if (input.minimumWall !== undefined) {
    if (!finite(input.minimumWall) || input.minimumWall <= 0 || input.minimumWall > 1000) throw new RangeError("The minimum wall is a thickness from above 0 to 1000 mm");
    next.minimumWall = input.minimumWall;
  }
  if (input.curvature !== undefined) {
    if (!CURVATURE_KINDS.includes(input.curvature)) throw new TypeError("Choose mean or gaussian curvature");
    next.curvature = input.curvature;
  }
  if (input.curvatureScale !== undefined) {
    if (input.curvatureScale !== null && (!finite(input.curvatureScale) || input.curvatureScale <= 0)) {
      throw new RangeError("The curvature scale is a positive number, or null to fit it to the shown parts");
    }
    next.curvatureScale = input.curvatureScale;
  }
  return next;
}

/** Saved or requested settings in full; throws when any is missing or invalid. */
export function validateAnalysis(value) {
  const next = applyAnalysis(defaultAnalysis(), value);
  const missing = KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`Analysis settings lack ${missing.join(", ")}`);
  return next;
}

// What the view draws, in a form a renderer report or capture can be matched against.
export const analysisKey = (analysis) => JSON.stringify(KEYS.map((key) => analysis[key]));

// The per-part data each setting needs, computed in the page's geometry worker.
export function analysisFields(analysis) {
  return [
    ...(analysis.map === "thickness" ? ["thickness"] : []),
    ...(analysis.map === "curvature" ? ["curvature"] : []),
    ...(analysis.triangleEdges ? ["edges"] : []),
    ...(analysis.normals ? ["normals"] : []),
  ];
}

// The answer's account of the settings: only what differs from plain shading.
export function analysisSummary(analysis) {
  const overlays = [
    ...(analysis.triangleEdges ? ["triangle edges"] : []), ...(analysis.backfaces ? ["back faces"] : []), ...(analysis.normals ? ["normals"] : []),
  ];
  const map = {
    none: null,
    overhang: { map: "overhang", angle: analysis.overhangAngle, direction: directionLabel(analysis.buildDirection) },
    thickness: { map: "thickness", minimumWall: analysis.minimumWall },
    curvature: { map: "curvature", kind: analysis.curvature, scale: analysis.curvatureScale ?? "auto" },
    zebra: { map: "zebra" },
  }[analysis.map];
  if (!map && !overlays.length) return null;
  return { ...(map ?? {}), ...(overlays.length ? { overlays } : {}) };
}

// The summary with the numbers a renderer's legend printed: the thinnest wall (mm) or the fitted curvature scale.
export function analysisReport(analysis, stats) {
  const shown = analysisSummary(analysis);
  if (!shown) return null;
  const key = { thickness: "thinnest", curvature: "curvatureScale" }[analysis.map];
  return { ...shown, ...(key && Number.isFinite(stats?.[key]) ? { [key]: stats[key] } : {}) };
}

// Colours are sRGB hex. A ramp's stops run from 0 to 1 along its legend.
export const RAMPS = {
  // From the overhang angle (0) to a flat underside (1).
  overhang: [[0, "#f7d154"], [0.45, "#ef8a2f"], [1, "#c21f2c"]],
  // From 0 to four times the minimum wall: red below the minimum, then yellow, green and blue as walls thicken.
  thickness: [[0, "#7a0f17"], [0.249, "#e3412f"], [0.25, "#f6cf4c"], [0.5, "#69bf63"], [1, "#2f6fbf"]],
  // From -scale to +scale: concave or saddle blue, flat pale, convex or dome red.
  curvature: [[0, "#2b5fae"], [0.25, "#8dbbe4"], [0.5, "#ecebe6"], [0.75, "#f0a179"], [1, "#b3242c"]],
};
export const THICKNESS_SPAN = 4;
export const ANALYSIS_COLORS = {
  plate: "#5a93dc", noValue: "#7f8b93", backface: "#d23c3c", normalBase: "#0f3b57", normalTip: "#3ff0ff",
  triangleEdges: "#0e2533", zebraLight: "#f4f4f2", zebraDark: "#1b1c1f",
};
// Mesh faults, drawn through the surface: open edges, edges on more than two triangles, edges whose triangles wind
// the same way, and zero-area triangles as dots.
export const FAULT_COLORS = { open: "#ff4d4d", overshared: "#ff4dff", flipped: "#ffa64d", degenerate: "#ffe14d" };

function hexRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The sRGB colour, 0 to 255 per channel, at t along a ramp. */
export function rampColor(stops, t) {
  const at = Math.min(1, Math.max(0, t));
  let index = 1;
  while (index < stops.length - 1 && at > stops[index][0]) index++;
  const [from, low] = stops[index - 1];
  const [to, high] = stops[index];
  const blend = to > from ? Math.min(1, Math.max(0, (at - from) / (to - from))) : 1;
  const [a, b] = [hexRgb(low), hexRgb(high)];
  return a.map((channel, axis) => Math.round(channel + (b[axis] - channel) * blend));
}

// Three significant figures, or whole numbers from 100, as a legend prints a scale.
export function formatNumber(value) {
  return String(Math.abs(value) >= 100 ? Math.round(value) : Number(value.toPrecision(3)));
}

// A scale rounded up to 1, 2 or 5 times a power of ten, so legend ticks read cleanly.
export function niceScale(value) {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * power).find((step) => step >= value * 0.999);
}

/**
 * What a legend shows for the settings: a ramp with its scale for a colour map, and keys for the overlays. stats are
 * the shown parts' numbers: thinnest (mm) and curvatureScale (the fitted scale); pending says they are still being
 * computed. Returns null when nothing needs one.
 */
export function analysisLegend(analysis, { stats = {}, faults = false, pending = false } = {}) {
  const keys = [];
  let map = null;
  if (analysis.map === "overhang") {
    map = {
      title: `Overhang from vertical, building toward ${directionLabel(analysis.buildDirection)}`,
      ramp: RAMPS.overhang, ticks: [[0, `${formatNumber(analysis.overhangAngle)}°`], [1, "90° flat underside"]],
      note: "A review trigger, not a print limit.",
    };
    keys.push({ color: ANALYSIS_COLORS.plate, label: "On the build plate" });
  } else if (analysis.map === "thickness") {
    const wall = analysis.minimumWall;
    map = {
      title: "Wall thickness", ramp: RAMPS.thickness,
      ticks: [[0, "0"], [0.25, `${formatNumber(wall)} min`], [0.5, formatNumber(wall * 2)], [1, `${formatNumber(wall * THICKNESS_SPAN)}+ mm`]],
      note: pending ? "Measuring the walls..." : `${stats.thinnest !== undefined ? `Thinnest ${formatNumber(stats.thinnest)} mm. ` : ""}Rays straight inward from each triangle.`,
    };
    keys.push({ color: ANALYSIS_COLORS.noValue, label: "No opposite wall" });
  } else if (analysis.map === "curvature") {
    const scale = analysis.curvatureScale ?? stats.curvatureScale ?? 1;
    const unit = analysis.curvature === "mean" ? "/mm" : "/mm²";
    map = {
      title: analysis.curvature === "mean" ? "Mean curvature" : "Gaussian curvature", ramp: RAMPS.curvature,
      ticks: [[0, `-${formatNumber(scale)}`], [0.5, "0"], [1, `+${formatNumber(scale)} ${unit}`]],
      note: pending ? "Estimating from the triangles..." : "From the displayed triangles: on a tessellated STEP it reflects the triangulation.",
    };
    keys.push({ color: ANALYSIS_COLORS.noValue, label: "Open border" });
  } else if (analysis.map === "zebra") {
    map = { title: "Zebra stripes", ramp: null, ticks: [], note: "Kinked stripes show creases; uneven spacing shows changing curvature." };
  }
  if (analysis.backfaces) keys.push({ color: ANALYSIS_COLORS.backface, label: "Back of a triangle" });
  if (analysis.normals) keys.push({ color: ANALYSIS_COLORS.normalTip, from: ANALYSIS_COLORS.normalBase, label: "Face normal, base to tip" });
  if (faults) {
    keys.push({ color: FAULT_COLORS.open, label: "Open edge" }, { color: FAULT_COLORS.overshared, label: "Edge on 3+ triangles" },
      { color: FAULT_COLORS.flipped, label: "Flipped edge" }, { color: FAULT_COLORS.degenerate, label: "Zero-area triangle" });
  }
  return map || keys.length ? { map, keys } : null;
}
