import { multiply } from "./matrix.mjs";

const directionAxis = { x: 0, y: 1, z: 2 };

export function center(bounds) {
  return bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
}

export function diagonal(bounds) {
  return Math.hypot(...bounds.min.map((value, axis) => bounds.max[axis] - value));
}

export function transformBounds(bounds, matrix) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = [0, 1, 2].map((axis) => (corner & (1 << axis) ? bounds.max : bounds.min)[axis]);
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * point[0] + matrix[4 + axis] * point[1] +
        matrix[8 + axis] * point[2] + matrix[12 + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

export function mergeBounds(bounds) {
  if (!bounds.length) return null;
  return {
    min: [0, 1, 2].map((axis) => Math.min(...bounds.map((item) => item.min[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...bounds.map((item) => item.max[axis]))),
  };
}

export const STEP_MODES = ["exploded", "buildup"];

// A committed or animating assembly-sequence position for placeParts, or null when the sequence is off.
export function sequencePose(state, position = state.step) {
  if (!state.assembly?.steps?.length || position === null || position === undefined) return null;
  return { steps: state.assembly.steps, position, mode: state.stepMode ?? "exploded" };
}

// Position k means steps 1..k are installed; a fractional position animates the next step.
// Each part waits at the sum of the offsets of the steps that still have to bring it in, so a part
// named again in a later step is carried by it. Build-up hides parts whose first step has not started.
export function sequenceOffsets(sequence) {
  const offsets = new Map();
  const hidden = new Set();
  if (!sequence) return { offsets, hidden };
  sequence.steps.forEach((step, index) => {
    const remaining = 1 - Math.min(1, Math.max(0, sequence.position - index));
    for (const id of step.nodeIds) {
      if (!offsets.has(id) && sequence.mode === "buildup" && remaining === 1) hidden.add(id);
      const offset = offsets.get(id) ?? [0, 0, 0];
      offsets.set(id, offset.map((value, axis) => value + step.from[axis] * remaining));
    }
  });
  return { offsets, hidden };
}

// Automatic explode, adapted from text-to-cad's explodedView.js (MIT, Copyright (c) 2026 Thompson Labs LLC;
// see explorer/README.md#provenance). Each level of the occurrence tree moves its child groups away from their
// parent's centre over its own share of the 0..1 slider, so subassemblies separate as units before their parts
// spread. X, Y and Z stack the same groups along that axis in the order they sit instead.
const EPSILON = 1e-6;
// Occurrences nested deeper move rigidly with their third-level ancestor.
const MAX_LEVELS = 3;
// A group moves by its assembled offset from its parent × SPREAD plus its radius × CLEARANCE, less at each deeper level.
const SPREAD = 1.5;
const CLEARANCE = 0.45;
const LEVEL_FALLOFF = 0.8;
// Within this fraction of its parent's radius a group is centred on the parent: it has no outward direction or side.
const CONCENTRIC = 0.05;
// Along an explode axis, groups whose centres are this close (as a fraction of the parent's radius) share a layer.
const LAYER = 0.01;
// The gap kept between separated siblings, as a fraction of their parent's radius.
const MARGIN = 0.05;
const MAX_PASSES = 10;
// Each level's share of the slider overlaps the next level's by this fraction.
const WINDOW_OVERLAP = 0.5;
// Models are not changed once loaded, so a layout is measured once per model and direction, when it first explodes.
const layouts = new WeakMap();

const extents = (bounds) => bounds.min.map((value, axis) => bounds.max[axis] - value);
const shifted = (bounds, vector) => vector
  ? { min: bounds.min.map((value, axis) => value + vector[axis]), max: bounds.max.map((value, axis) => value + vector[axis]) }
  : bounds;

// How far two boxes overlap on each of the given axes, or null when they are apart on any of them.
function overlap(a, b, axes = [0, 1, 2], slack = 0) {
  const amounts = axes.map((axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]));
  return amounts.every((amount) => amount > slack) ? amounts : null;
}

// The occurrence tree as explode groups, each with its part occurrences and their assembled bounds.
function explodeTree(model) {
  const parts = new Map(model.parts.map((part) => [part.id, part]));
  const matrices = new Map();
  const groups = new Map();
  const root = { ids: [], box: null, children: [] };
  for (const node of model.nodes) {
    // placeParts reports a missing parent or part.
    if (node.parentId && !groups.has(node.parentId)) continue;
    const matrix = node.parentId ? multiply(matrices.get(node.parentId), node.matrix) : node.matrix;
    matrices.set(node.id, matrix);
    const part = node.partId ? parts.get(node.partId) : null;
    const group = { ids: part ? [node.id] : [], box: part ? transformBounds(part.bounds, matrix) : null, children: [] };
    groups.set(node.id, group);
    (node.parentId ? groups.get(node.parentId) : root).children.push(group);
  }
  const summarize = (group) => {
    const boxes = group.box ? [group.box] : [];
    for (const child of group.children) {
      summarize(child);
      if (!child.bounds) continue;
      for (const id of child.ids) group.ids.push(id);
      boxes.push(child.bounds);
    }
    group.bounds = mergeBounds(boxes);
  };
  summarize(root);
  return root;
}

function layoutNode(group, bounds, levels) {
  const node = { ids: group.ids, bounds, center: center(bounds), radius: diagonal(bounds) / 2, children: [] };
  let children = group.children.filter((child) => child.bounds);
  // A wrapper holding a single group does not use up a level.
  while (children.length === 1 && children[0].children.length) children = children[0].children.filter((child) => child.bounds);
  if (levels > 0 && children.length > 1) node.children = children.map((child) => layoutNode(child, child.bounds, levels - 1));
  return node;
}

// Each child moves straight out from its parent's centre. Children centred on the parent have no outward direction,
// so they stack along one axis as an axis explode would: the axis their centres spread along most for the parent's
// size (plates stacked on a turntable) or, when they share a centre, the longest side of the largest one that has to
// come out (a shaft in a housing).
function radialVectors(node, level) {
  const falloff = LEVEL_FALLOFF ** (level - 1);
  const vectors = new Map();
  const centred = [];
  for (const child of node.children) {
    const relative = child.center.map((value, axis) => value - node.center[axis]);
    const distance = Math.hypot(...relative);
    if (distance <= Math.max(node.radius * CONCENTRIC, EPSILON)) {
      centred.push(child);
      continue;
    }
    const length = (distance * SPREAD + child.radius * CLEARANCE) * falloff;
    vectors.set(child, relative.map((value) => value / distance * length));
  }
  if (centred.length > 1) {
    const size = extents(node.bounds);
    const spread = size.map((extent, axis) => {
      const positions = centred.map((child) => child.center[axis]);
      return (Math.max(...positions) - Math.min(...positions)) / Math.max(extent, EPSILON);
    });
    let axis = spread.indexOf(Math.max(...spread));
    if (spread[axis] <= LAYER) {
      const sides = extents([...centred].sort((a, b) => b.radius - a.radius)[1].bounds);
      axis = sides.indexOf(Math.max(...sides));
    }
    for (const [child, vector] of axisVectors({ ...node, children: centred }, level, axis)) vectors.set(child, vector);
  }
  separate(node, vectors);
  return vectors;
}

// Proportional offsets alone can leave large neighbours with nearby centres intersecting, so push the outer of each
// overlapping pair further along its own direction until every pair clears. A child that stays is never pushed.
function separate(node, vectors) {
  const gap = Math.max(node.radius * MARGIN, EPSILON);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let pushed = false;
    for (let i = 0; i < node.children.length; i++) {
      for (let j = i + 1; j < node.children.length; j++) {
        const a = node.children[i];
        const b = node.children[j];
        const va = vectors.get(a);
        const vb = vectors.get(b);
        if (!va && !vb) continue;
        const amounts = overlap(shifted(a.bounds, va), shifted(b.bounds, vb));
        if (!amounts) continue;
        const target = !va ? b : !vb ? a : Math.hypot(...va) >= Math.hypot(...vb) ? a : b;
        const vector = vectors.get(target);
        const length = Math.hypot(...vector);
        if (length <= EPSILON) continue;
        const unit = vector.map((value) => value / length);
        // The travel along its own direction that clears the cheapest axis it moves substantially along.
        const travel = Math.min(...unit.map((value, axis) => Math.abs(value) > 0.25 ? (amounts[axis] + gap) / Math.abs(value) : Infinity));
        if (!Number.isFinite(travel)) continue;
        vectors.set(target, vector.map((value, axis) => value + unit[axis] * travel));
        pushed = true;
      }
    }
    if (!pushed) return;
  }
}

// Children stack along the axis in the order they sit. Children at the same height form a layer that moves as one,
// and the layer at the parent's centre stays. Each layer further out moves at least as far as the one inside it, and
// far enough to clear anything it would meet along the axis. A child inside a larger one at the same height gets a
// layer of its own beside it and telescopes out, alternately each way.
function axisVectors(node, level, axis) {
  const falloff = LEVEL_FALLOFF ** (level - 1);
  const tolerance = Math.max(node.radius * LAYER, EPSILON);
  const gap = Math.max(node.radius * MARGIN, EPSILON);
  const origin = node.center[axis];
  const across = [0, 1, 2].filter((other) => other !== axis);
  const layers = [];
  for (const child of [...node.children].sort((a, b) => a.center[axis] - b.center[axis])) {
    const layer = layers.at(-1);
    if (layer && child.center[axis] - layer.position <= tolerance) layer.children.push(child);
    else layers.push({ position: child.center[axis], children: [child] });
  }
  const ordered = [];
  let anchor = null;
  for (const { position, children } of layers) {
    const kept = [];
    const nested = [];
    for (const child of [...children].sort((a, b) => b.radius - a.radius)) {
      (kept.some((other) => overlap(child.bounds, other.bounds, undefined, tolerance)) ? nested : kept).push(child);
    }
    const host = { position, children: kept };
    const distance = Math.abs(position - origin);
    if (distance <= Math.max(node.radius * CONCENTRIC, EPSILON) && (!anchor || distance < Math.abs(anchor.position - origin))) anchor = host;
    const below = nested.filter((_, index) => index % 2).reverse().map((child) => ({ position, children: [child] }));
    const above = nested.filter((_, index) => index % 2 === 0).map((child) => ({ position, children: [child] }));
    ordered.push(...below, host, ...above);
  }
  const split = anchor ? ordered.indexOf(anchor) : ordered.findIndex((layer) => layer.position >= origin);
  const end = split < 0 ? ordered.length : split;
  const vectors = new Map();
  const placed = anchor ? anchor.children.map((child) => [child, 0]) : [];
  for (const [side, outward] of [[1, ordered.slice(anchor ? end + 1 : end)], [-1, ordered.slice(0, end).reverse()]]) {
    let previous = 0;
    for (const { position, children } of outward) {
      const radius = Math.max(...children.map((child) => child.radius));
      let distance = Math.max((Math.abs(position - origin) * SPREAD + radius * CLEARANCE) * falloff, previous);
      for (const child of children) {
        for (const [other, moved] of placed) {
          if (!overlap(child.bounds, other.bounds, across, tolerance)) continue;
          distance = Math.max(distance, side > 0
            ? other.bounds.max[axis] + moved - child.bounds.min[axis] + gap
            : child.bounds.max[axis] - other.bounds.min[axis] - moved + gap);
        }
      }
      const vector = [0, 0, 0];
      vector[axis] = side * distance;
      for (const child of children) {
        placed.push([child, vector[axis]]);
        vectors.set(child, vector);
      }
      previous = distance;
    }
  }
  return vectors;
}

// For each occurrence, the offset each level adds to it. Of the n levels that move anything, the ith adds its offsets
// over its own window of the slider.
function explodeLayout(model, direction) {
  const cached = layouts.get(model) ?? new Map();
  layouts.set(model, cached);
  if (cached.has(direction)) return cached.get(direction);
  const axis = directionAxis[direction];
  const moves = new Map();
  const moving = new Set();
  const queue = [{ node: layoutNode(explodeTree(model), model.bounds, MAX_LEVELS), level: 1 }];
  for (const { node, level } of queue) {
    const vectors = axis === undefined ? radialVectors(node, level) : axisVectors(node, level, axis);
    for (const child of node.children) {
      const vector = vectors.get(child);
      if (vector && Math.hypot(...vector) > EPSILON) {
        moving.add(level);
        for (const id of child.ids) {
          const list = moves.get(id) ?? [];
          list.push({ vector, level });
          moves.set(id, list);
        }
      }
      if (child.children.length) queue.push({ node: child, level: level + 1 });
    }
  }
  const span = 1 / (1 + Math.max(moving.size - 1, 0) * (1 - WINDOW_OVERLAP));
  const windows = new Map([...moving].sort((a, b) => a - b).map((level, index) => {
    const start = index * span * (1 - WINDOW_OVERLAP);
    return [level, [start, Math.min(start + span, 1)]];
  }));
  const layout = { moves, windows };
  cached.set(direction, layout);
  return layout;
}

// Smoothstepped within each window, so every stage starts and lands softly.
function explodeOffset(layout, id, amount) {
  const offset = [0, 0, 0];
  for (const { vector, level } of layout.moves.get(id) ?? []) {
    const [start, end] = layout.windows.get(level);
    const t = Math.min(Math.max((amount - start) / (end - start), 0), 1);
    for (let axis = 0; axis < 3; axis++) offset[axis] += vector[axis] * t * t * (3 - 2 * t);
  }
  return offset;
}

export function placeParts(model, amount, direction, fixedId, sequence = null) {
  const matrices = new Map();
  const parts = new Map(model.parts.map((part) => [part.id, part]));
  const layout = amount > 0 ? explodeLayout(model, direction) : null;
  // The fixed occurrence stays put and everything else keeps the same separation from it.
  const fixed = layout && fixedId ? explodeOffset(layout, fixedId, amount) : [0, 0, 0];
  const { offsets, hidden } = sequenceOffsets(sequence);
  const result = [];
  for (const node of model.nodes) {
    const parent = node.parentId ? matrices.get(node.parentId) : null;
    if (node.parentId && !parent) throw new Error(`Missing parent for ${node.id}`);
    const original = parent ? multiply(parent, node.matrix) : [...node.matrix];
    matrices.set(node.id, original);
    if (!node.partId || hidden.has(node.id)) continue;
    const part = parts.get(node.partId);
    if (!part) throw new Error(`Missing geometry for ${node.id}`);
    const matrix = [...original];
    const offset = offsets.get(node.id);
    if (offset) for (let axis = 0; axis < 3; axis++) matrix[12 + axis] += offset[axis];
    if (layout) {
      const exploded = explodeOffset(layout, node.id, amount);
      for (let axis = 0; axis < 3; axis++) matrix[12 + axis] += exploded[axis] - fixed[axis];
    }
    result.push({ node, part, matrix, bounds: transformBounds(part.bounds, matrix), offset: offset ?? null });
  }
  return result;
}

export function displayedWorldBounds(model, state) {
  const hidden = new Set(state.hiddenIds ?? []);
  return mergeBounds(placeParts(model, state.explode, state.direction, state.fixedId, sequencePose(state))
    .filter((placement) => !hidden.has(placement.node.id))
    .map((placement) => placement.bounds));
}
