// Per-part data for the analysis views, computed from the triangles the view draws, the same way for STEP previews
// and mesh files. The geometry worker runs these off the page's main thread; each takes the part's own positions
// (mm, part frame) and triangle corners and returns typed arrays it can hand back without copying.
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";
import { niceScale, type AnalysisField } from "../../shared/analysis.mjs";

// A vertex with no value: no opposite wall, or an open border where curvature is undefined. Shaders test for it.
export const NO_VALUE = Math.fround(1e30);
// Normal arrows are this fraction of the part's diagonal long, at most one per cell of 1.5 arrow lengths and facing.
const ARROW_FRACTION = 0.05;
const ARROW_SPACING = 1.5;
// Triangles less equilateral than this (see wallThickness) are slivers.
const SLIVER = 1e-3;

export type FieldResults = {
  thickness: { values: Float32Array; thinnest: number | null };
  curvature: { mean: Float32Array; gaussian: Float32Array };
  edges: { pairs: Uint32Array };
  normals: { segments: Float32Array };
};

function boundsOf(positions: ArrayLike<number>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[offset + axis]);
      max[axis] = Math.max(max[axis], positions[offset + axis]);
    }
  }
  return { min, diagonal: positions.length ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0 };
}

// Every corner pair of every triangle as min * vertexCount + max, sorted, so equal edges sit together.
function sortedEdgeKeys(indices: ArrayLike<number>, vertexCount: number): Float64Array {
  const keys = new Float64Array(indices.length);
  let used = 0;
  for (let corner = 0; corner < indices.length; corner++) {
    const a = indices[corner];
    const b = indices[corner % 3 === 2 ? corner - 2 : corner + 1];
    if (a !== b) keys[used++] = a < b ? a * vertexCount + b : b * vertexCount + a;
  }
  return keys.subarray(0, used).sort();
}

/** Each triangle edge once, as pairs of vertex numbers. */
export function triangleEdges(indices: ArrayLike<number>, vertexCount: number): Uint32Array {
  const keys = sortedEdgeKeys(indices, vertexCount);
  let unique = 0;
  for (let index = 0; index < keys.length; index++) if (index === 0 || keys[index] !== keys[index - 1]) unique++;
  const pairs = new Uint32Array(unique * 2);
  let slot = 0;
  for (let index = 0; index < keys.length; index++) {
    if (index && keys[index] === keys[index - 1]) continue;
    const low = Math.floor(keys[index] / vertexCount);
    pairs[slot++] = low;
    pairs[slot++] = keys[index] - low * vertexCount;
  }
  return pairs;
}

/** For each vertex, the first vertex at exactly its position: a STEP preview repeats a vertex on each face meeting there. */
export function weldVertices(positions: ArrayLike<number>): Uint32Array {
  const count = positions.length / 3;
  const bits = new Uint32Array(Float32Array.from(positions).buffer);
  let size = 16;
  while (size < count * 2) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const first = new Uint32Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    const [x, y, z] = [bits[vertex * 3], bits[vertex * 3 + 1], bits[vertex * 3 + 2]];
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
    for (;;) {
      const held = table[slot];
      if (held < 0) { table[slot] = vertex; first[vertex] = vertex; break; }
      if (bits[held * 3] === x && bits[held * 3 + 1] === y && bits[held * 3 + 2] === z) { first[vertex] = held; break; }
      slot = (slot + 1) & (size - 1);
    }
  }
  return first;
}

/**
 * Mean (1/mm, positive where convex) and Gaussian (1/mm^2) curvature at each vertex, estimated from the triangles with
 * the cotangent formula and angle deficit over each vertex's mixed Voronoi area (Meyer et al. 2003). Vertices at the
 * same position are joined first; vertices on an open or over-shared border get NO_VALUE.
 */
export function curvatures(positions: ArrayLike<number>, indices: ArrayLike<number>): FieldResults["curvature"] {
  const count = positions.length / 3;
  const welded = weldVertices(positions);
  // A triangle with two corners at one position has no area and no edges of its own: counting its edges would make the
  // edge it lies along over-shared, and its vertices a border.
  const corners = Uint32Array.from(Array.from({ length: indices.length / 3 }, (_, triangle) => [0, 1, 2].map((corner) => welded[indices[triangle * 3 + corner]]))
    .filter(([a, b, c]) => a !== b && b !== c && a !== c).flat());
  const area = new Float64Array(count);
  const angles = new Float64Array(count);
  const laplacian = new Float64Array(count * 3);
  const normal = new Float64Array(count * 3);
  const border = new Uint8Array(count);
  const keys = sortedEdgeKeys(corners, count);
  for (let start = 0, end = 0; start < keys.length; start = end) {
    while (end < keys.length && keys[end] === keys[start]) end++;
    if (end - start !== 2) {
      const low = Math.floor(keys[start] / count);
      border[low] = border[keys[start] - low * count] = 1;
    }
  }
  const point = (vertex: number) => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
  const minus = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (let triangle = 0; triangle < corners.length / 3; triangle++) {
    const ids = [corners[triangle * 3], corners[triangle * 3 + 1], corners[triangle * 3 + 2]];
    const p = ids.map(point);
    const twice = cross(minus(p[1], p[0]), minus(p[2], p[0]));
    const doubled = Math.hypot(...twice);
    if (doubled < 1e-20) continue;
    // At each corner: the angle, its cotangent and the two edges leaving it.
    const cot = [0, 0, 0];
    const angle = [0, 0, 0];
    for (let corner = 0; corner < 3; corner++) {
      const u = minus(p[(corner + 1) % 3], p[corner]);
      const v = minus(p[(corner + 2) % 3], p[corner]);
      const sine = Math.hypot(...cross(u, v));
      cot[corner] = dot(u, v) / sine;
      angle[corner] = Math.atan2(sine, dot(u, v));
    }
    const obtuse = angle.findIndex((value) => value > Math.PI / 2);
    for (let corner = 0; corner < 3; corner++) {
      const [vertex, next] = [ids[corner], ids[(corner + 1) % 3]];
      const [here, toNext, toPrevious] = [p[corner], p[(corner + 1) % 3], p[(corner + 2) % 3]];
      angles[vertex] += angle[corner];
      for (let axis = 0; axis < 3; axis++) normal[vertex * 3 + axis] += twice[axis];
      if (obtuse < 0) {
        const nextSide = minus(toNext, here);
        const previousSide = minus(toPrevious, here);
        area[vertex] += (dot(nextSide, nextSide) * cot[(corner + 2) % 3] + dot(previousSide, previousSide) * cot[(corner + 1) % 3]) / 8;
      } else area[vertex] += doubled / (obtuse === corner ? 4 : 8);
      // The edge to the next corner, weighted by the cotangent of the angle opposite it.
      const weight = cot[(corner + 2) % 3];
      for (let axis = 0; axis < 3; axis++) {
        const along = here[axis] - toNext[axis];
        laplacian[vertex * 3 + axis] += weight * along;
        laplacian[next * 3 + axis] -= weight * along;
      }
    }
  }
  const mean = new Float32Array(count);
  const gaussian = new Float32Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    const source = welded[vertex];
    if (source !== vertex) { mean[vertex] = mean[source]; gaussian[vertex] = gaussian[source]; continue; }
    const length = Math.hypot(normal[vertex * 3], normal[vertex * 3 + 1], normal[vertex * 3 + 2]);
    if (border[vertex] || area[vertex] <= 0 || length === 0) { mean[vertex] = gaussian[vertex] = NO_VALUE; continue; }
    const along = (laplacian[vertex * 3] * normal[vertex * 3] + laplacian[vertex * 3 + 1] * normal[vertex * 3 + 1] + laplacian[vertex * 3 + 2] * normal[vertex * 3 + 2]) / length;
    mean[vertex] = along / (4 * area[vertex]);
    gaussian[vertex] = (2 * Math.PI - angles[vertex]) / area[vertex];
  }
  return { mean, gaussian };
}

/**
 * Wall thickness at each vertex: a ray from each triangle's centre straight inward (against its normal) to the first
 * surface it meets, through a bounding-volume tree, and at each vertex the thinnest of the triangles meeting there.
 * A ray counts only where it leaves through the back of a surface, as it does from inside a closed part. Slivers,
 * whose normals rounding decides, cast none. Vertices with no counted ray get NO_VALUE.
 */
export function wallThickness(positions: Float32Array, indices: Uint32Array): FieldResults["thickness"] {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // Indirect trees leave the index alone, so the triangle numbers stay the part's own.
  const tree = new MeshBVH(geometry, { indirect: true });
  // Hits closer than this are the triangle itself, within rounding.
  const near = Math.max(boundsOf(positions).diagonal * 1e-5, 1e-6);
  const ray = new Ray();
  const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
  const values = new Float32Array(positions.length / 3).fill(NO_VALUE);
  let thinnest = Infinity;
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    a.fromArray(positions, indices[triangle * 3] * 3);
    b.fromArray(positions, indices[triangle * 3 + 1] * 3);
    c.fromArray(positions, indices[triangle * 3 + 2] * 3);
    ray.origin.copy(a).add(b).add(c).divideScalar(3);
    // Against the normal, (c - b) x (a - b) as three.js orients it.
    const edges = c.distanceToSquared(b) + a.distanceToSquared(b) + a.distanceToSquared(c);
    ray.direction.crossVectors(c.sub(b), a.sub(b)).negate();
    // Twice the area against the sides: 4√3·area / (sum of squared sides) is 1 for an equilateral triangle.
    if (2 * Math.sqrt(3) * ray.direction.length() < SLIVER * edges) continue;
    ray.direction.normalize();
    const hit = tree.raycastFirst(ray, DoubleSide, near);
    if (!hit || hit.faceIndex === triangle || !hit.face || hit.face.normal.dot(ray.direction) <= 0) continue;
    thinnest = Math.min(thinnest, hit.distance);
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle * 3 + corner];
      values[vertex] = Math.min(values[vertex], hit.distance);
    }
  }
  return { values, thinnest: Number.isFinite(thinnest) ? thinnest : null };
}

/**
 * Short lines along the triangles' normals from their centres, sized to the part: in each cell, one for each of the
 * six directions a triangle can mostly face, from its largest such triangle, so both sides of a thin wall keep theirs.
 */
export function normalArrows(positions: ArrayLike<number>, indices: ArrayLike<number>): FieldResults["normals"] {
  const { min, diagonal } = boundsOf(positions);
  const length = diagonal * ARROW_FRACTION;
  const cell = length * ARROW_SPACING;
  const chosen = new Map<number, { triangle: number; area: number }>();
  const corner = (index: number, axis: number) => positions[indices[index] * 3 + axis];
  const centre = [0, 0, 0];
  const normal = [0, 0, 0];
  const measure = (triangle: number) => {
    const u = [0, 1, 2].map((axis) => corner(triangle * 3 + 1, axis) - corner(triangle * 3, axis));
    const v = [0, 1, 2].map((axis) => corner(triangle * 3 + 2, axis) - corner(triangle * 3, axis));
    normal[0] = u[1] * v[2] - u[2] * v[1]; normal[1] = u[2] * v[0] - u[0] * v[2]; normal[2] = u[0] * v[1] - u[1] * v[0];
    for (let axis = 0; axis < 3; axis++) centre[axis] = (corner(triangle * 3, axis) + corner(triangle * 3 + 1, axis) + corner(triangle * 3 + 2, axis)) / 3;
    return Math.hypot(normal[0], normal[1], normal[2]);
  };
  if (!(cell > 0)) return { segments: new Float32Array() };
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const area = measure(triangle);
    if (area < 1e-20) continue;
    // About 20 cells span the part, so 1024 per axis keeps keys distinct; the facing is the normal's largest component.
    const facing = [0, 1, 2].reduce((best, axis) => Math.abs(normal[axis]) > Math.abs(normal[best]) ? axis : best, 0);
    const key = centre.reduce((sum, value, axis) => sum * 1024 + Math.floor((value - min[axis]) / cell), 0) * 6 + facing * 2 + (normal[facing] > 0 ? 1 : 0);
    const held = chosen.get(key);
    if (!held || area > held.area) chosen.set(key, { triangle, area });
  }
  const segments = new Float32Array(chosen.size * 6);
  let slot = 0;
  for (const { triangle } of chosen.values()) {
    const area = measure(triangle);
    for (let axis = 0; axis < 3; axis++) {
      segments[slot + axis] = centre[axis];
      segments[slot + 3 + axis] = centre[axis] + normal[axis] / area * length;
    }
    slot += 6;
  }
  return { segments };
}

/**
 * The curvature at either end of the colour scale when none is set: the 90th percentile of its size over the shown
 * parts' vertices, each part counted by its vertices, rounded to a clean number.
 */
export function fittedCurvatureScale(fields: Float32Array[]): number {
  const total = fields.reduce((sum, values) => sum + values.length, 0);
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(total / 50_000));
  for (const values of fields) {
    for (let index = 0; index < values.length; index += stride) if (values[index] < NO_VALUE) sample.push(Math.abs(values[index]));
  }
  if (!sample.length) return 1;
  sample.sort((x, y) => x - y);
  return niceScale(sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.9))]);
}

export function computeField(field: AnalysisField, positions: Float32Array, indices: Uint32Array): FieldResults[AnalysisField] {
  switch (field) {
    case "thickness": return wallThickness(positions, indices);
    case "curvature": return curvatures(positions, indices);
    case "edges": return { pairs: triangleEdges(indices, positions.length / 3) };
    case "normals": return normalArrows(positions, indices);
  }
}
