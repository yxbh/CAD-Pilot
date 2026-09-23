import {
  DoubleSide,
  Mesh,
  Plane,
  Raycaster,
  Vector3,
  type Intersection,
} from "three";
import type { SectionSettings } from "../shared/section.mjs";
import { sectionAxisIndex, sectionDistance } from "../shared/section.mjs";
import type { CadEdge, CadFace, Part } from "./model.ts";
import type { EdgeRange } from "./resources.ts";

export type ClippedEdges = { positions: number[]; ranges: EdgeRange[] };

export function sceneSectionPlane(section: SectionSettings, origin: number[]): Plane | null {
  if (!section.enabled) return null;
  const axis = sectionAxisIndex(section.axis);
  const sign = section.flipped ? 1 : -1;
  const normal = new Vector3();
  normal.setComponent(axis, sign);
  return new Plane(normal, -sign * (section.position - origin[axis]));
}

function interpolate(a: number[], b: number[], amount: number): number[] {
  return a.map((value, axis) => value + (b[axis] - value) * amount);
}

function clippedSegment(a: number[], b: number[], matrix: number[], section: SectionSettings): number[] | null {
  const da = sectionDistance(a, matrix, section);
  const db = sectionDistance(b, matrix, section);
  const tolerance = 1e-8;
  const aVisible = da <= tolerance;
  const bVisible = db <= tolerance;
  if (aVisible && bVisible) return [...a, ...b];
  if (!aVisible && !bVisible) return null;
  const amount = da / (da - db);
  const cut = interpolate(a, b, amount);
  return aVisible ? [...a, ...cut] : [...cut, ...b];
}

export function clipCadEdges(edges: CadEdge[], matrix: number[], section: SectionSettings): ClippedEdges {
  const positions: number[] = [];
  const ranges: EdgeRange[] = [];
  for (const edge of edges) {
    const start = positions.length / 6;
    for (let offset = 0; offset + 5 < edge.positions.length; offset += 3) {
      const segment = section.enabled
        ? clippedSegment(
          edge.positions.slice(offset, offset + 3),
          edge.positions.slice(offset + 3, offset + 6),
          matrix,
          section,
        )
        : edge.positions.slice(offset, offset + 6);
      if (segment && segment.some((value, index) => index >= 3 && Math.abs(value - segment[index - 3]) > 1e-10)) {
        positions.push(...segment);
      }
    }
    const count = positions.length / 6 - start;
    if (count) ranges.push({ edge, start, count });
  }
  return { positions, ranges };
}

export function sectionOutlineSegments(part: Part, matrix: number[], section: SectionSettings): number[] {
  if (!section.enabled) return [];
  const result: number[] = [];
  const tolerance = 1e-8;
  for (let offset = 0; offset < part.indices.length; offset += 3) {
    const points = [0, 1, 2].map((slot) => {
      const vertex = part.indices[offset + slot] * 3;
      return part.positions.slice(vertex, vertex + 3);
    });
    const distances = points.map((point) => sectionDistance(point, matrix, section));
    const cuts: number[][] = [];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const da = distances[a];
      const db = distances[b];
      if (Math.abs(da) <= tolerance) cuts.push(points[a]);
      if ((da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance)) {
        cuts.push(interpolate(points[a], points[b], da / (da - db)));
      }
    }
    const unique = cuts.filter((point, index) => cuts.findIndex((candidate) =>
      candidate.every((value, axis) => Math.abs(value - point[axis]) <= tolerance)) === index);
    if (unique.length >= 2 && unique[0].some((value, axis) => Math.abs(value - unique[1][axis]) > tolerance)) {
      result.push(...unique[0], ...unique[1]);
    }
  }
  return result;
}

export function visibleFaceTriangleCount(part: Part, face: CadFace, matrix: number[], section: SectionSettings): number {
  if (!section.enabled) return face.triangleCount;
  let visible = 0;
  const first = face.triangleStart * 3;
  for (let triangle = 0; triangle < face.triangleCount; triangle++) {
    const offset = first + triangle * 3;
    if ([0, 1, 2].some((slot) => {
      const vertex = part.indices[offset + slot] * 3;
      return sectionDistance(part.positions.slice(vertex, vertex + 3), matrix, section) <= 1e-8;
    })) visible++;
  }
  return visible;
}

export function visibleFacePoint(part: Part, face: CadFace, matrix: number[], section: SectionSettings): number[] | null {
  if (!section.enabled) return face.center;
  const first = face.triangleStart * 3;
  for (let triangle = 0; triangle < face.triangleCount; triangle++) {
    const offset = first + triangle * 3;
    let polygon = [0, 1, 2].map((slot) => {
      const vertex = part.indices[offset + slot] * 3;
      return part.positions.slice(vertex, vertex + 3);
    });
    const clipped: number[][] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      const da = sectionDistance(a, matrix, section);
      const db = sectionDistance(b, matrix, section);
      if (da <= 1e-8) clipped.push(a);
      if ((da < -1e-8 && db > 1e-8) || (da > 1e-8 && db < -1e-8)) {
        clipped.push(interpolate(a, b, da / (da - db)));
      }
    }
    polygon = clipped;
    if (polygon.length >= 3) {
      return [0, 1, 2].map((axis) => polygon.reduce((sum, point) => sum + point[axis], 0) / polygon.length);
    }
  }
  return null;
}

function uniqueIntersectionDistances(hits: Intersection[], maximum: number): number[] {
  const tolerance = Math.max(1e-7, maximum * 1e-8);
  const distances = hits.map((hit) => hit.distance).filter((distance) => distance < maximum - tolerance).sort((a, b) => a - b);
  return distances.filter((distance, index) => index === 0 || Math.abs(distance - distances[index - 1]) > tolerance);
}

export function sectionMeshRaycast(mesh: Mesh, raycaster: Raycaster, intersections: Intersection[], plane: Plane | null) {
  if (!plane) {
    Mesh.prototype.raycast.call(mesh, raycaster, intersections);
    return;
  }
  const material = mesh.material;
  const materials = Array.isArray(material) ? material : [material];
  const sides = materials.map((entry) => entry.side);
  materials.forEach((entry) => { entry.side = DoubleSide; });
  const raw: Intersection[] = [];
  try { Mesh.prototype.raycast.call(mesh, raycaster, raw); }
  finally { materials.forEach((entry, index) => { entry.side = sides[index]; }); }

  const originDistance = plane.distanceToPoint(raycaster.ray.origin);
  const denominator = plane.normal.dot(raycaster.ray.direction);
  if (originDistance < -1e-8 && denominator > 1e-12) {
    const planeDistance = -originDistance / denominator;
    if (planeDistance >= 0 && uniqueIntersectionDistances(raw, planeDistance).length % 2 === 1) {
      intersections.push({
        distance: planeDistance,
        point: raycaster.ray.at(planeDistance, new Vector3()),
        object: mesh,
        face: null,
        faceIndex: -1,
      });
    }
  }
  for (const hit of raw) if (plane.distanceToPoint(hit.point) >= -1e-8) intersections.push(hit);
}
