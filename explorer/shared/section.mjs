import { displayedWorldBounds, placeParts, sequencePose } from "./placement.mjs";

export const SECTION_AXES = ["x", "y", "z"];
const axisIndex = { x: 0, y: 1, z: 2 };

const midpoint = (bounds, axis) => (bounds.min[axis] + bounds.max[axis]) / 2;

export function defaultSection(bounds) {
  return { enabled: false, axis: "x", position: midpoint(bounds, 0), flipped: false };
}

export function validateSection(value, bounds) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["enabled", "axis", "position", "flipped"].includes(key)) ||
      typeof value.enabled !== "boolean" || !SECTION_AXES.includes(value.axis) ||
      typeof value.position !== "number" || !Number.isFinite(value.position) ||
      typeof value.flipped !== "boolean") {
    throw new TypeError("Section settings must contain a finite position, X/Y/Z axis, enabled flag and flipped flag.");
  }
  if (bounds) {
    const index = axisIndex[value.axis];
    if (value.position < bounds.min[index] || value.position > bounds.max[index]) {
      throw new RangeError(`Section position must be between ${bounds.min[index]} and ${bounds.max[index]} mm on ${value.axis.toUpperCase()}.`);
    }
  }
  return { enabled: value.enabled, axis: value.axis, position: value.position, flipped: value.flipped };
}

export function sectionAxisIndex(axis) {
  if (!SECTION_AXES.includes(axis)) throw new TypeError("Section axis must be X, Y or Z.");
  return axisIndex[axis];
}

// Open meshes and surface parts are cut without caps; only caches made before closed-solid metadata existed,
// whose parts may or may not be closed, cannot be cut until the file is opened again.
export function sectionSupport(model) {
  const parts = model?.parts ?? [];
  if (!parts.length || parts.some((part) => typeof part.sectionCaps !== "boolean")) {
    return { supported: false, reason: "unknown_solids", message: "This preview was cached without closed-solid metadata. Reopen the STEP to enable section view." };
  }
  return { supported: true, reason: null, message: "" };
}

export function sameSection(a, b) {
  return !!a && !!b && a.enabled === b.enabled && a.axis === b.axis &&
    a.position === b.position && a.flipped === b.flipped;
}

export function sectionDistance(point, matrix, section) {
  const axis = sectionAxisIndex(section.axis);
  const world = matrix[axis] * point[0] + matrix[4 + axis] * point[1] +
    matrix[8 + axis] * point[2] + matrix[12 + axis];
  return section.flipped ? section.position - world : world - section.position;
}

export function sectionPointVisible(point, matrix, section, tolerance = 1e-8) {
  return !section.enabled || sectionDistance(point, matrix, section) <= tolerance;
}

export function sectionPlacements(model, state) {
  return placeParts(model, state.explode, state.direction, state.fixedId, sequencePose(state));
}

export function reconcileSectionWithDisplay(state, model) {
  const bounds = displayedWorldBounds(model, state);
  if (!bounds) return state;
  const axis = sectionAxisIndex(state.section.axis);
  const position = Math.min(bounds.max[axis], Math.max(bounds.min[axis], state.section.position));
  return position === state.section.position ? state : {
    ...state,
    section: { ...state.section, position },
  };
}

function vertexVisible(positions, vertex, matrix, section) {
  return sectionPointVisible([positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]], matrix, section);
}

function partVisible(part, matrix, section) {
  for (let vertex = 0; vertex < part.positions.length / 3; vertex++) if (vertexVisible(part.positions, vertex, matrix, section)) return true;
  return false;
}

function faceVisible(part, face, matrix, section) {
  const end = (face.triangleStart + face.triangleCount) * 3;
  for (let slot = face.triangleStart * 3; slot < end; slot++) if (vertexVisible(part.positions, part.indices[slot], matrix, section)) return true;
  return false;
}

function edgeVisible(edge, matrix, section) {
  for (let vertex = 0; vertex < edge.positions.length / 3; vertex++) if (vertexVisible(edge.positions, vertex, matrix, section)) return true;
  return false;
}

export function sectionEntityVisible(model, state, nodeId, faceId = null, edgeId = null, point = null) {
  if (!state.section?.enabled) return true;
  const placement = sectionPlacements(model, state).find((item) => item.node.id === nodeId);
  return entityVisibleAt(placement, state.section, faceId, edgeId, point);
}

function entityVisibleAt(placement, section, faceId = null, edgeId = null, point = null) {
  if (!placement) return false;
  if (point) return sectionPointVisible(point, placement.matrix, section);
  if (faceId) {
    const face = placement.part.faces.find((item) => item.id === faceId);
    return !!face && faceVisible(placement.part, face, placement.matrix, section);
  }
  if (edgeId) {
    const edge = placement.part.edges?.find((item) => item.id === edgeId);
    return !!edge && edgeVisible(edge, placement.matrix, section);
  }
  return partVisible(placement.part, placement.matrix, section);
}

export function pruneSectionSelection(state, model) {
  if (!state.section?.enabled) return state;
  const placements = new Map(sectionPlacements(model, state).map((placement) => [placement.node.id, placement]));
  const visible = (nodeId, faceId = null, edgeId = null) =>
    entityVisibleAt(placements.get(nodeId), state.section, faceId, edgeId);
  let selectedFace = state.selectedFace;
  let selectedEdge = state.selectedEdge;
  let selectedIds = state.selectedIds.filter((id) => visible(id));
  if (selectedFace && !visible(selectedFace.nodeId, selectedFace.faceId)) {
    selectedIds = selectedIds.filter((id) => id !== selectedFace.nodeId);
    selectedFace = null;
  }
  if (selectedEdge && !visible(selectedEdge.nodeId, null, selectedEdge.edgeId)) {
    selectedIds = selectedIds.filter((id) => id !== selectedEdge.nodeId);
    selectedEdge = null;
  }
  let selectedPoint = state.selectedPoint ?? null;
  if (selectedPoint && !entityVisibleAt(placements.get(selectedPoint.nodeId), state.section, null, null, selectedPoint.point)) {
    selectedIds = selectedIds.filter((id) => id !== selectedPoint.nodeId);
    selectedPoint = null;
  }
  return { ...state, selectedIds, selectedFace, selectedEdge, selectedPoint };
}
