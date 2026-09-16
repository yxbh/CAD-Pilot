import { Raycaster, Vector2, Vector3, type Camera, type Intersection, type Object3D } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";

export const EDGE_PICK_RADIUS = 6;

export function visibleEdgeHits(
  lines: LineSegments2, raycaster: Raycaster, surfaces: Object3D[], width: number, height: number, tolerance: number,
): Intersection[] {
  const camera = raycaster.camera;
  if (!camera) return [];
  lines.material.resolution.set(width, height);
  const previous = raycaster.params.Line2;
  const hits: Intersection[] = [];
  try {
    raycaster.params.Line2 = { threshold: EDGE_PICK_RADIUS * 2 - lines.material.linewidth };
    LineSegments2.prototype.raycast.call(lines, raycaster, hits);
  } finally {
    raycaster.params.Line2 = previous;
  }
  const visibility = new Raycaster();
  return hits.filter((hit) => {
    const point = hit.pointOnLine;
    if (!point) return false;
    const projected = point.clone().project(camera);
    visibility.setFromCamera(new Vector2(projected.x, projected.y), camera);
    visibility.far = Math.max(0, visibility.ray.origin.distanceTo(point) - tolerance);
    return visibility.intersectObjects(surfaces, false).length === 0;
  });
}

export function prioritizeEdges<T extends Intersection>(hits: T[], camera: Camera, pointer: Vector2, width: number, height: number): T[] {
  const distance = (hit: T) => {
    const point = (hit.pointOnLine ?? hit.point).clone().project(camera);
    return Math.hypot((point.x - pointer.x) * width / 2, (point.y - pointer.y) * height / 2);
  };
  return [...hits].sort((a, b) => {
    const aEdge = a.object.userData.cadEdges === true;
    const bEdge = b.object.userData.cadEdges === true;
    if (aEdge !== bEdge) return aEdge ? -1 : 1;
    return aEdge ? distance(a) - distance(b) || a.distance - b.distance : a.distance - b.distance;
  });
}

export function edgeScreenPoint(positions: number[], matrix: number[], origin: number[], camera: Camera, width: number, height: number): number[] | null {
  // A curve's center of mass can be in empty space; use a point on its sampled polyline.
  const offset = Math.floor((positions.length / 3 - 2) / 2) * 3;
  if (offset < 0) return null;
  const point = new Vector3();
  const midpoint = [0, 1, 2].map((axis) => (positions[offset + axis] + positions[offset + axis + 3]) / 2);
  for (let axis = 0; axis < 3; axis++) {
    point.setComponent(axis, matrix[axis] * midpoint[0] + matrix[4 + axis] * midpoint[1] +
      matrix[8 + axis] * midpoint[2] + matrix[12 + axis] - origin[axis]);
  }
  point.project(camera);
  return [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
}
