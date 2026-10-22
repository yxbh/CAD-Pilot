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

export function placeParts(model, amount, direction, fixedId, sequence = null) {
  const matrices = new Map();
  const parts = new Map(model.parts.map((part) => [part.id, part]));
  const modelCenter = center(model.bounds);
  const distance = Math.max(diagonal(model.bounds) * 0.55, 1) * amount;
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
    if (node.id !== fixedId && distance !== 0) {
      const partCenter = center(transformBounds(part.bounds, original));
      let vector = partCenter.map((value, axis) => value - modelCenter[axis]);
      if (direction !== "radial") {
        const axis = directionAxis[direction];
        const sign = vector[axis] < 0 ? -1 : 1;
        vector = [0, 0, 0];
        vector[axis] = sign * (0.6 + result.length * 0.18);
      } else {
        const length = Math.hypot(...vector);
        vector = length > 1e-9
          ? vector.map((value) => value / length)
          : [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0]][result.length % 4];
      }
      for (let axis = 0; axis < 3; axis++) matrix[12 + axis] += vector[axis] * distance;
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
