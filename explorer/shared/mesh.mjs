// File types the Explorer opens. STEP is converted to exact CAD faces and edges; meshes are shown as they are.
export const STEP_EXTENSIONS = Object.freeze([".step", ".stp"]);
export const MESH_EXTENSIONS = Object.freeze({ ".stl": "stl", ".obj": "obj", ".3mf": "3mf", ".ply": "ply", ".glb": "glb" });
export const MESH_FORMATS = Object.freeze(Object.values(MESH_EXTENSIONS));
export const MODEL_EXTENSIONS = Object.freeze([...STEP_EXTENSIONS, ...Object.keys(MESH_EXTENSIONS)]);
export const MESH_UNITS = Object.freeze(["auto", "um", "mm", "cm", "m", "in", "ft"]);
export const MESH_UP_AXES = Object.freeze(["auto", "z", "y"]);

export function modelFormat(file) {
  const extension = /\.[^./\\]+$/.exec(String(file))?.[0].toLowerCase() ?? "";
  return STEP_EXTENSIONS.includes(extension) ? "step" : MESH_EXTENSIONS[extension] ?? null;
}

// Mesh parts keep their geometry in one binary file beside a small JSON manifest. These typed views are attached
// as non-enumerable properties so the manifest still serializes as plain JSON and the arrays are never copied.
export const MESH_BUFFERS = Object.freeze({
  positions: Float32Array, indices: Uint32Array, outlines: Uint32Array,
  openEdges: Uint32Array, oversharedEdges: Uint32Array, flippedEdges: Uint32Array, degenerateTriangles: Uint32Array,
});
export const MESH_FAULTS = Object.freeze(["openEdges", "oversharedEdges", "flippedEdges", "degenerateTriangles"]);

export const isMeshPart = (part) => !!part?.buffers;

// `bytes` is an ArrayBuffer or a Node Buffer holding the whole geometry file; offsets are relative to its start.
export function meshViews(part, bytes) {
  let buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  let base = bytes instanceof ArrayBuffer ? 0 : bytes.byteOffset;
  if (base % 4) {
    buffer = bytes.buffer.slice(base, base + bytes.byteLength);
    base = 0;
  }
  const views = {};
  for (const [name, Type] of Object.entries(MESH_BUFFERS)) {
    const { offset, count } = part.buffers[name];
    views[name] = new Type(buffer, base + offset, count);
  }
  return views;
}

export function attachMeshGeometry(part, views) {
  for (const [name, value] of [["positions", views.positions], ["indices", views.indices], ["mesh", views]]) {
    Object.defineProperty(part, name, { value, enumerable: false, configurable: true, writable: false });
  }
  return part;
}

// Copy a mesh part's manifest fields while keeping its attached geometry views.
export function copyMeshPart(part, changes) {
  const copy = { ...part, ...changes };
  return isMeshPart(part) && part.mesh ? attachMeshGeometry(copy, part.mesh) : copy;
}

export function meshFaultCount(part) {
  return MESH_FAULTS.reduce((sum, name) => sum + (part.faults?.[name] ?? 0), 0);
}

const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const along = (origin, direction, t) => origin.map((value, axis) => value + direction[axis] * t);

function distanceToSegment(p, a, b) {
  const ab = sub(b, a);
  const length = dot(ab, ab);
  const t = length > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / length)) : 0;
  return Math.hypot(...sub(p, along(a, ab, t)));
}

// Closest distance from a point to a triangle (Ericson, Real-Time Collision Detection, 5.1.5). A triangle whose
// corners are collinear or coincide has no interior, so it is measured as its three edges.
export function distanceToTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const edges = () => Math.min(distanceToSegment(p, a, b), distanceToSegment(p, b, c), distanceToSegment(p, c, a));
  if (!(dot(normal, normal) > 0)) return edges();
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let closest;
  if (d1 <= 0 && d2 <= 0) closest = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) closest = b;
    else if (d6 >= 0 && d5 <= d6) closest = c;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) closest = along(a, ab, d1 / (d1 - d3));
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) closest = along(a, ac, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) closest = along(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    else {
      const total = va + vb + vc;
      closest = along(along(a, ab, vb / total), ac, vc / total);
    }
  }
  const distance = Math.hypot(...sub(p, closest));
  return Number.isFinite(distance) ? distance : edges();
}

// A triangle's corners from a part whose positions and indices are in memory.
export function triangleCorners(part, triangle) {
  return [0, 1, 2].map((slot) => {
    const vertex = part.indices[triangle * 3 + slot] * 3;
    return [part.positions[vertex], part.positions[vertex + 1], part.positions[vertex + 2]];
  });
}

// Picked points are kept to the micrometre, so they may sit a little off their triangle; anything further is not on it.
export const pointTolerance = (bounds) => 0.002 + Math.hypot(...sub(bounds.max, bounds.min)) * 1e-6;

// The point's distance from its triangle when it lies on it, otherwise null.
export function pointOnTriangle(corners, point, bounds) {
  const distance = distanceToTriangle(point, ...corners);
  return Number.isFinite(distance) && distance <= pointTolerance(bounds) ? distance : null;
}
