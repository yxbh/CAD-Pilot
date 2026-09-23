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

export function placeParts(model, amount, direction, fixedId) {
  const matrices = new Map();
  const parts = new Map(model.parts.map((part) => [part.id, part]));
  const modelCenter = center(model.bounds);
  const distance = Math.max(diagonal(model.bounds) * 0.55, 1) * amount;
  const result = [];
  for (const node of model.nodes) {
    const parent = node.parentId ? matrices.get(node.parentId) : null;
    if (node.parentId && !parent) throw new Error(`Missing parent for ${node.id}`);
    const original = parent ? multiply(parent, node.matrix) : [...node.matrix];
    matrices.set(node.id, original);
    if (!node.partId) continue;
    const part = parts.get(node.partId);
    if (!part) throw new Error(`Missing geometry for ${node.id}`);
    const matrix = [...original];
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
    result.push({ node, part, matrix, bounds: transformBounds(part.bounds, matrix) });
  }
  return result;
}

export function displayedWorldBounds(model, state) {
  const hidden = new Set(state.hiddenIds ?? []);
  return mergeBounds(placeParts(model, state.explode, state.direction, state.fixedId)
    .filter((placement) => !hidden.has(placement.node.id))
    .map((placement) => placement.bounds));
}
