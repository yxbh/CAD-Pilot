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
// Siblings overlapping by less than this fraction of their parent's radius only touch: STEP conversion leaves boxes
// that meet overlapping by about a micrometre.
const CONTACT = 1e-5;
// Separation sweeps per group. Each sweep compares only boxes that could touch.
const MAX_PASSES = 32;
// A pile with more overlapping pairs than this (hundreds of parts all overlapping one another) keeps the offsets it has:
// pushing it apart pair by pair would stall the viewer.
const MAX_OVERLAPS = 100_000;
// A side is a part's own axis when it is at least this many times longer or shorter than both of its other sides.
const DISTINCT = 1.25;
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

// For each box, the indices of the boxes it overlaps on the given axes by more than slack. Boxes are binned into grid
// cells about the size of a typical box and compared only with boxes sharing a cell, so parts laid out side by side
// cost close to linear time; a box spanning many cells is compared with every box instead.
function overlappingPairs(boxes, slack, axes = [0, 1, 2]) {
  const partners = boxes.map(() => []);
  const sizes = boxes.map((box) => Math.max(...axes.map((axis) => box.max[axis] - box.min[axis]))).sort((a, b) => a - b);
  const cell = Math.max(sizes[sizes.length >> 1] ?? 0, EPSILON);
  const grid = new Map();
  const large = [];
  const cells = boxes.map((box, index) => {
    const spans = axes.map((axis) => [Math.floor(box.min[axis] / cell), Math.floor(box.max[axis] / cell)]);
    if (spans.some(([low, high]) => high - low > 3)) {
      large.push(index);
      return [];
    }
    // Keys may collide; a collision only adds a candidate that the exact test then rejects.
    let keys = [0];
    for (const [low, high] of spans) {
      const next = [];
      for (const key of keys) for (let at = low; at <= high; at++) next.push(Math.imul(key ^ at, 0x9e3779b1) >>> 0);
      keys = next;
    }
    for (const key of keys) {
      const members = grid.get(key);
      if (members) members.push(index);
      else grid.set(key, [index]);
    }
    return keys;
  });
  const add = (index, other) => {
    if (!overlap(boxes[index], boxes[other], axes, slack)) return;
    partners[index].push(other);
    partners[other].push(index);
  };
  // Each pair of binned boxes is tested once, from its lower index, however many cells they share.
  const compared = new Int32Array(boxes.length).fill(-1);
  boxes.forEach((_, index) => {
    for (const key of cells[index]) {
      for (const other of grid.get(key)) {
        if (other <= index || compared[other] === index) continue;
        compared[other] = index;
        add(index, other);
      }
    }
  });
  const unbinned = new Set(large);
  for (const index of large) {
    for (let other = 0; other < boxes.length; other++) {
      if (other !== index && !(unbinned.has(other) && other < index)) add(index, other);
    }
  }
  return partners;
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

// A part's own axis: the side unlike its other two, such as a shaft's length or a bearing's thickness, or its longest
// side when no side stands out.
function ownAxis(bounds) {
  const sides = extents(bounds);
  const logs = sides.map((side) => Math.log(Math.max(side, EPSILON)));
  const contrast = logs.map((side, axis) => Math.min(...logs.filter((_, other) => other !== axis).map((other) => Math.abs(side - other))));
  const axis = contrast.indexOf(Math.max(...contrast));
  return contrast[axis] >= Math.log(DISTINCT) ? axis : sides.indexOf(Math.max(...sides));
}

// Each child moves straight out from its parent's centre. Children centred on the parent have no outward direction, so
// they stack along an axis as an axis explode would. Centres spread along an axis (plates stacked on a turntable) stack
// along it; when they share a centre, the largest stays and each other one slides out along its own axis (a bearing and
// a shaft out of a housing).
function radialVectors(node, level) {
  const falloff = LEVEL_FALLOFF ** (level - 1);
  const vectors = new Map();
  const centred = [];
  for (const child of node.children) {
    const relative = child.center.map((value, axis) => value - node.center[axis]);
    const distance = Math.hypot(...relative);
    // Only a child that reaches its parent's centre is centred on it; a small part merely near the centre still has a
    // direction out.
    if (distance <= Math.max(Math.min(node.radius * CONCENTRIC, child.radius), EPSILON)) {
      centred.push(child);
      continue;
    }
    const length = (distance * SPREAD + child.radius * CLEARANCE) * falloff;
    vectors.set(child, relative.map((value) => value / distance * length));
  }
  const stack = (children, axis) => {
    for (const [child, vector] of axisVectors({ ...node, children }, level, axis)) vectors.set(child, vector);
  };
  if (centred.length > 1) {
    const spread = extents(node.bounds).map((extent, axis) => {
      const positions = centred.map((child) => child.center[axis]);
      return (Math.max(...positions) - Math.min(...positions)) / Math.max(extent, EPSILON);
    });
    const axis = spread.indexOf(Math.max(...spread));
    if (spread[axis] > LAYER) stack(centred, axis);
    else {
      const [core, ...others] = [...centred].sort((a, b) => b.radius - a.radius);
      for (const along of [0, 1, 2]) {
        const sliding = others.filter((child) => ownAxis(child.bounds) === along);
        if (sliding.length) stack([core, ...sliding], along);
      }
    }
  }
  separate(node, vectors);
  return vectors;
}

// Proportional offsets alone can leave large neighbours with nearby centres intersecting, so push the outer of each
// overlapping pair further along its own direction until every pair clears. A child that stays is never pushed. Each
// child is the box its own parts fill once they spread, so cousins clear each other too.
function separate(node, vectors) {
  const gap = Math.max(node.radius * MARGIN, EPSILON);
  const contact = Math.max(node.radius * CONTACT, EPSILON);
  const children = node.children;
  const box = (child) => shifted(child.envelope, vectors.get(child));
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let pushed = false;
    const pairs = overlappingPairs(children.map(box), contact);
    if (pairs.reduce((sum, partners) => sum + partners.length, 0) / 2 > MAX_OVERLAPS) return;
    pairs.forEach((partners, i) => {
      for (const j of partners) {
        if (j < i) continue;
        const a = children[i];
        const b = children[j];
        const va = vectors.get(a);
        const vb = vectors.get(b);
        if (!va && !vb) continue;
        // An earlier push in this sweep may already have cleared the pair.
        const amounts = overlap(box(a), box(b), undefined, contact);
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
    });
    if (!pushed) return;
  }
}

// Children stack along the axis in the order they sit. Children at the same height form a layer that moves as one,
// and the layer at the parent's centre stays. Each layer further out moves at least as far as the one inside it, and
// far enough to clear anything it would meet along the axis. A child that overlaps a larger one at the same height
// gets a layer of its own beside it and telescopes out, alternately each way. Each child is the box its own parts fill
// once they spread. Beside lays every child out along the axis instead, when nothing would otherwise separate along
// it: the largest stays and the others alternate either side, clear of everything already placed.
function axisVectors(node, level, axis, beside = false) {
  const falloff = LEVEL_FALLOFF ** (level - 1);
  const tolerance = Math.max(node.radius * LAYER, EPSILON);
  const gap = Math.max(node.radius * MARGIN, EPSILON);
  const contact = Math.max(node.radius * CONTACT, EPSILON);
  const origin = node.center[axis];
  const children = node.children;
  const index = new Map(children.map((child, at) => [child, at]));
  const envelopes = children.map((child) => child.envelope);
  const touching = overlappingPairs(envelopes, contact);
  const meeting = beside ? null : overlappingPairs(envelopes, contact, [0, 1, 2].filter((other) => other !== axis));
  const layers = [];
  if (beside) layers.push({ position: origin, children });
  else {
    for (const child of [...children].sort((a, b) => a.center[axis] - b.center[axis])) {
      const layer = layers.at(-1);
      if (layer && child.center[axis] - layer.position <= tolerance) layer.children.push(child);
      else layers.push({ position: child.center[axis], children: [child] });
    }
  }
  const ordered = [];
  let anchor = null;
  for (const { position, children: members } of layers) {
    const kept = new Set();
    const nested = [];
    for (const child of [...members].sort((a, b) => b.radius - a.radius)) {
      const inside = beside ? kept.size > 0 : touching[index.get(child)].some((other) => kept.has(children[other]));
      if (inside) nested.push(child);
      else kept.add(child);
    }
    const host = { position, children: [...kept] };
    const distance = Math.abs(position - origin);
    if (distance <= Math.max(node.radius * CONCENTRIC, EPSILON) && (!anchor || distance < Math.abs(anchor.position - origin))) anchor = host;
    const below = nested.filter((_, at) => at % 2).reverse().map((child) => ({ position, children: [child] }));
    const above = nested.filter((_, at) => at % 2 === 0).map((child) => ({ position, children: [child] }));
    ordered.push(...below, host, ...above);
  }
  const split = anchor ? ordered.indexOf(anchor) : ordered.findIndex((layer) => layer.position >= origin);
  const end = split < 0 ? ordered.length : split;
  const vectors = new Map();
  const moved = new Map();
  let low = Infinity;
  let high = -Infinity;
  const place = (child, offset) => {
    moved.set(child, offset);
    low = Math.min(low, child.envelope.min[axis] + offset);
    high = Math.max(high, child.envelope.max[axis] + offset);
  };
  for (const child of anchor?.children ?? []) place(child, 0);
  for (const [side, outward] of [[1, ordered.slice(anchor ? end + 1 : end)], [-1, ordered.slice(0, end).reverse()]]) {
    let previous = 0;
    for (const { position, children: members } of outward) {
      const radius = Math.max(...members.map((child) => child.radius));
      let distance = Math.max((Math.abs(position - origin) * SPREAD + radius * CLEARANCE) * falloff, previous);
      for (const child of members) {
        const own = child.envelope;
        if (beside && moved.size) distance = Math.max(distance, side > 0 ? high - own.min[axis] + gap : own.max[axis] - low + gap);
        for (const at of meeting?.[index.get(child)] ?? []) {
          const other = children[at];
          if (!moved.has(other)) continue;
          const offset = moved.get(other);
          distance = Math.max(distance, side > 0
            ? other.envelope.max[axis] + offset - own.min[axis] + gap
            : own.max[axis] - other.envelope.min[axis] - offset + gap);
        }
      }
      const vector = [0, 0, 0];
      vector[axis] = side * distance;
      for (const child of members) {
        place(child, vector[axis]);
        vectors.set(child, vector);
      }
      previous = distance;
    }
  }
  return vectors;
}

// Lays out a node's children from the deepest level up, so each child's clearance covers the room its own parts take
// once they spread, and returns the box the node's parts fill at full explode.
function layOut(node, level, axis, layout) {
  for (const child of node.children) child.envelope = child.children.length ? layOut(child, level + 1, axis, layout) : child.bounds;
  const vectors = axis === undefined ? radialVectors(node, level) : axisVectors(node, level, axis);
  record(layout, node, vectors, level);
  return mergeBounds(node.children.map((child) => shifted(child.envelope, vectors.get(child))));
}

function record(layout, node, vectors, level) {
  for (const child of node.children) {
    const vector = vectors.get(child);
    if (!vector || Math.hypot(...vector) <= EPSILON) continue;
    layout.levels.add(level);
    for (const id of child.ids) {
      const list = layout.moves.get(id) ?? [];
      list.push({ vector, level });
      layout.moves.set(id, list);
    }
  }
}

// For each occurrence, the offset each level adds to it. Of the n levels that move anything, the ith adds its offsets
// over its own window of the slider.
function explodeLayout(model, direction) {
  const cached = layouts.get(model) ?? new Map();
  layouts.set(model, cached);
  if (cached.has(direction)) return cached.get(direction);
  const axis = directionAxis[direction];
  const layout = { moves: new Map(), levels: new Set(), windows: null };
  const root = layoutNode(explodeTree(model), model.bounds, MAX_LEVELS);
  if (root.children.length) layOut(root, 1, axis, layout);
  // An axis along which nothing separates lays the top level out side by side along it rather than doing nothing.
  if (axis !== undefined && !layout.moves.size && root.children.length) record(layout, root, axisVectors(root, 1, axis, true), 1);
  const span = 1 / (1 + Math.max(layout.levels.size - 1, 0) * (1 - WINDOW_OVERLAP));
  layout.windows = new Map([...layout.levels].sort((a, b) => a - b).map((level, index) => {
    const start = index * span * (1 - WINDOW_OVERLAP);
    return [level, [start, Math.min(start + span, 1)]];
  }));
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
