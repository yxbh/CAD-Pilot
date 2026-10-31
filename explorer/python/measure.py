"""Measure mesh files: overall sizes, section outlines with circle and slot fits, distances and fault locations.

Files are read exactly as CAD Explorer reads them (mesh.py, with the same --units and --up options), so the
coordinates match the viewer's model-world axes and its section positions. Picked point references are
part-local: use the world point that `explorer.mjs inspect` reports. Results are JSON in millimetres.
Measurements describe the triangles in the file, which approximate the real object; fit residuals say how
well a circle or slot matches the outline, not how accurate the scan or export was.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mesh as meshes  # noqa: E402

AXES = {"x": 0, "y": 1, "z": 2}
# In-plane axes for each axis-aligned section, so outlines read in familiar drawing coordinates.
PLANE_AXES = {"x": ("y", "z"), "y": ("x", "z"), "z": ("x", "y")}
FIT_SAMPLES = 720
MAX_REPORTED = 50


class Occurrence:
    """One placed copy of a part in world millimetres."""

    def __init__(self, label: str, part: meshes.MeshPart, matrix: np.ndarray):
        self.label = label
        self.part = part
        self.vertices = part.positions.astype(np.float64) @ matrix[:3, :3].T + matrix[:3, 3]
        self.triangles = part.triangles.astype(np.int64)


def _round(value, digits: int = 4):
    if isinstance(value, dict):
        return {key: _round(item, digits) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round(item, digits) for item in value]
    if isinstance(value, (np.floating, float)):
        return round(float(value), digits) if math.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.ndarray):
        return _round(value.tolist(), digits)
    return value


def _bounds(points: np.ndarray) -> dict:
    low, high = points.min(axis=0), points.max(axis=0)
    return {"min": low, "max": high, "size": high - low}


def _vector(text: str, name: str) -> np.ndarray:
    try:
        values = np.asarray([float(item) for item in text.split(",")])
    except ValueError as error:
        raise meshes.MeshError(f"{name} must be three comma-separated numbers, like 10,0,2.5") from error
    if values.shape != (3,) or not np.isfinite(values).all():
        raise meshes.MeshError(f"{name} must be three comma-separated numbers, like 10,0,2.5")
    return values


def label_pattern(glob: str) -> re.Pattern:
    """A part name pattern as CAD Explorer reads one everywhere: * and ? are the only wildcards, all else is literal."""
    return re.compile("".join(".*" if char == "*" else "." if char == "?" else re.escape(char) for char in glob), re.DOTALL)


def occurrences(document: meshes.MeshDocument, part: str | None) -> list[Occurrence]:
    matcher = None if part is None else label_pattern(part)
    found = [Occurrence(node.label, document.parts[node.part], node.matrix) for node in document.nodes
             if matcher is None or any(matcher.fullmatch(name) for name in (node.label, document.parts[node.part].label))]
    if not found:
        names = sorted({node.label for node in document.nodes})
        raise meshes.MeshError(f"No part name matches {part!r}. Parts: {', '.join(names)}")
    return found


def size(document: meshes.MeshDocument, items: list[Occurrence]) -> dict:
    return {
        "bounds": _bounds(np.concatenate([item.vertices for item in items])),
        "parts": [{
            "name": item.label, "triangles": len(item.triangles), "vertices": len(item.vertices),
            "bounds": _bounds(item.vertices), "closed": item.part.closed, "area": item.part.area,
            "volume": item.part.volume,
            "faults": {
                "openEdges": len(item.part.open_edges), "oversharedEdges": len(item.part.overshared_edges),
                "flippedEdges": len(item.part.flipped_edges), "degenerateTriangles": len(item.part.degenerate_triangles),
            },
        } for item in items],
        "note": "Volume is given only for closed meshes. Bounds are of the triangles as placed in the file.",
    }


def _chains(pairs: list[tuple[int, int]]) -> list[tuple[list[int], bool]]:
    """Join segments that share an end into polylines; each is (keys, closed)."""
    links: dict[int, list[int]] = {}
    for index, (a, b) in enumerate(pairs):
        links.setdefault(a, []).append(index)
        links.setdefault(b, []).append(index)
    used = [False] * len(pairs)
    chains = []

    def walk(start: int, segment: int) -> tuple[list[int], bool]:
        keys = [start]
        current = start
        while segment is not None and not used[segment]:
            used[segment] = True
            a, b = pairs[segment]
            current = b if a == current else a
            keys.append(current)
            segment = next((item for item in links[current] if not used[item]), None)
        return keys, len(keys) > 2 and keys[0] == keys[-1]

    # Open runs start at an end used once; what remains are closed loops.
    for key, segments in links.items():
        if len(segments) == 1 and not used[segments[0]]:
            chains.append(walk(key, segments[0]))
    for index, (a, _) in enumerate(pairs):
        if not used[index]:
            chains.append(walk(a, index))
    return chains


def _resample(points: np.ndarray, closed: bool, count: int = FIT_SAMPLES) -> np.ndarray:
    path = np.vstack([points, points[:1]]) if closed else points
    lengths = np.linalg.norm(np.diff(path, axis=0), axis=1)
    distance = np.r_[0, np.cumsum(lengths)]
    if distance[-1] == 0:
        return points[:1]
    stations = np.linspace(0, distance[-1], count, endpoint=not closed)
    return np.column_stack([np.interp(stations, distance, path[:, axis]) for axis in range(path.shape[1])])


def _circle(points: np.ndarray) -> dict:
    x, y = points[:, 0], points[:, 1]
    solution, *_ = np.linalg.lstsq(np.column_stack([x, y, np.ones_like(x)]), -(x * x + y * y), rcond=None)
    centre = -solution[:2] / 2
    radius = math.sqrt(max(centre @ centre - solution[2], 0.0))
    fitted = least_squares(lambda p: np.hypot(x - p[0], y - p[1]) - p[2], [*centre, radius])
    centre, radius = fitted.x[:2], abs(fitted.x[2])
    residual = np.hypot(x - centre[0], y - centre[1]) - radius
    return {"center": centre, "diameter": 2 * radius, "rms": float(np.sqrt(np.mean(residual ** 2))), "maxDeviation": float(np.abs(residual).max())}


def _segment_distance(points: np.ndarray, centre: np.ndarray, direction: np.ndarray, half: float) -> np.ndarray:
    along = np.clip((points - centre) @ direction, -half, half)
    return np.linalg.norm(points - (centre + along[:, None] * direction), axis=1)


def _slot(points: np.ndarray) -> dict:
    """A stadium: every outline point is half the width from a straight centre segment."""
    centre = points.mean(axis=0)
    _, _, axes = np.linalg.svd(points - centre, full_matrices=False)
    angle = math.atan2(axes[0][1], axes[0][0])
    along = (points - centre) @ axes[0]
    across = (points - centre) @ axes[1]
    radius = (across.max() - across.min()) / 2
    half = max((along.max() - along.min()) / 2 - radius, 0.0)

    def residual(p):
        direction = np.array([math.cos(p[2]), math.sin(p[2])])
        return _segment_distance(points, p[:2], direction, abs(p[3])) - abs(p[4])

    fitted = least_squares(residual, [*centre, angle, half, radius])
    cx, cy, angle, half, radius = fitted.x
    direction = np.array([math.cos(angle), math.sin(angle)])
    error = residual(fitted.x)
    return {
        "center": [cx, cy], "axis": direction, "width": 2 * abs(radius), "length": 2 * abs(half) + 2 * abs(radius),
        "rms": float(np.sqrt(np.mean(error ** 2))), "maxDeviation": float(np.abs(error).max()),
    }


def _rectangle(points: np.ndarray) -> dict:
    """Smallest-area bounding rectangle, from the outline's convex hull edges."""
    from scipy.spatial import ConvexHull

    try:
        hull = points[ConvexHull(points).vertices]
    except Exception:  # Collinear or too few points: fall back to the axis-aligned box.
        size = points.max(axis=0) - points.min(axis=0)
        return {"length": float(size.max()), "width": float(size.min()), "angleDegrees": 0.0}
    best = None
    for edge in np.diff(np.vstack([hull, hull[:1]]), axis=0):
        length = np.linalg.norm(edge)
        if length == 0:
            continue
        u = edge / length
        v = np.array([-u[1], u[0]])
        a, b = hull @ u, hull @ v
        extent = (a.max() - a.min(), b.max() - b.min())
        if best is None or extent[0] * extent[1] < best[0]:
            best = (extent[0] * extent[1], extent, math.degrees(math.atan2(u[1], u[0])))
    (length, width), angle = sorted(best[1], reverse=True), best[2]
    return {"length": length, "width": width, "angleDegrees": angle % 180}


def _inside(point: np.ndarray, polygon: np.ndarray) -> bool:
    x, y = point
    xs, ys = polygon[:, 0], polygon[:, 1]
    xn, yn = np.roll(xs, -1), np.roll(ys, -1)
    crossing = ((ys > y) != (yn > y)) & (x < (xn - xs) * (y - ys) / np.where(yn == ys, 1, yn - ys) + xs)
    return bool(np.count_nonzero(crossing) % 2)


def _plane(args) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, tuple[str, str]]:
    for name in AXES:
        position = getattr(args, name)
        if position is not None:
            normal = np.eye(3)[AXES[name]]
            u_name, v_name = PLANE_AXES[name]
            return normal * position, normal, np.eye(3)[AXES[u_name]], np.eye(3)[AXES[v_name]], (u_name, v_name)
    if not args.plane:
        raise meshes.MeshError("Choose a plane: --x, --y or --z with a position, or --plane with a point and a normal.")
    origin, normal = _vector(args.plane[0], "Plane point"), _vector(args.plane[1], "Plane normal")
    if not np.linalg.norm(normal):
        raise meshes.MeshError("The plane normal must not be zero.")
    normal = normal / np.linalg.norm(normal)
    helper = np.eye(3)[np.argmin(np.abs(normal))]
    u = np.cross(normal, helper)
    u /= np.linalg.norm(u)
    return origin, normal, u, np.cross(normal, u), ("u", "v")


def section(items: list[Occurrence], args) -> dict:
    origin, normal, u, v, names = _plane(args)
    loops = []
    for item in items:
        distance = (item.vertices - origin) @ normal
        # A vertex on the plane counts as just above it, so every crossing edge has ends on both sides.
        above = distance >= 0
        tri = item.triangles
        sides = above[tri]
        crossing = tri[sides.any(axis=1) & ~sides.all(axis=1)]
        if not len(crossing):
            continue
        pairs = []
        points: dict[tuple[int, int], np.ndarray] = {}
        for corners in crossing:
            ends = []
            for a, b in ((corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[0])):
                if above[a] != above[b]:
                    key = (min(a, b), max(a, b))
                    if key not in points:
                        da, db = distance[key[0]], distance[key[1]]
                        points[key] = item.vertices[key[0]] + (item.vertices[key[1]] - item.vertices[key[0]]) * (da / (da - db))
                    ends.append(key)
            pairs.append((ends[0], ends[1]))
        keys = {key: index for index, key in enumerate(points)}
        coordinates = np.asarray(list(points.values()))
        for chain, closed in _chains([(keys[a], keys[b]) for a, b in pairs]):
            path = coordinates[chain[:-1] if closed else chain]
            if len(path) < 2:
                continue
            loops.append((item.label, path, closed))
    results = []
    for index, (label, path, closed) in enumerate(loops):
        flat = np.column_stack([(path - origin) @ u, (path - origin) @ v])
        segment_lengths = np.linalg.norm(np.diff(np.vstack([flat, flat[:1]]) if closed else flat, axis=0), axis=1)
        entry = {
            "index": index, "part": label, "closed": closed, "points": len(path), "length": float(segment_lengths.sum()),
            "bounds2d": _bounds(flat), "bounds": _bounds(path),
        }
        if closed and len(flat) >= 3:
            x, y = flat[:, 0], flat[:, 1]
            cross = x * np.roll(y, -1) - np.roll(x, -1) * y
            area = cross.sum() / 2
            centroid = (np.array([((x + np.roll(x, -1)) * cross).sum(), ((y + np.roll(y, -1)) * cross).sum()]) / (6 * area)
                        if area else flat.mean(axis=0))
            samples = _resample(flat, True)
            circle, slot = _circle(samples), _slot(samples)
            radius = circle["diameter"] / 2
            shape = ("circle" if radius and circle["rms"] < 0.01 * radius
                     else "slot" if slot["width"] and slot["rms"] < 0.015 * slot["width"] and slot["length"] > 1.1 * slot["width"]
                     else "outline")
            entry.update({
                "area": abs(area), "centroid2d": centroid, "centroid": origin + centroid[0] * u + centroid[1] * v,
                "shape": shape, "circle": circle, "slot": slot, "rectangle": _rectangle(flat),
            })
            entry["circle"]["center3d"] = origin + circle["center"][0] * u + circle["center"][1] * v
            entry["slot"]["center3d"] = origin + slot["center"][0] * u + slot["center"][1] * v
        if args.points:
            step = max(1, math.ceil(len(flat) / args.points))
            entry["outline2d"] = flat[::step]
        results.append((entry, flat))
    # A closed loop inside an odd number of other loops of the same part is a hole.
    for entry, flat in results:
        if entry["closed"]:
            containers = [other["index"] for other, polygon in results if other is not entry and other["closed"]
                          and other["part"] == entry["part"] and _inside(flat[0], polygon)]
            entry["insideOf"] = containers
            entry["hole"] = len(containers) % 2 == 1
    return {
        "plane": {"point": origin, "normal": normal, "axes2d": {names[0]: u, names[1]: v}},
        "loops": [entry for entry, _ in results],
        "note": ("Loops are where the plane cuts the triangles. 2D coordinates are measured along axes2d from the plane point. "
                 "shape is a guess from the fits: compare circle and slot residuals (rms, maxDeviation) with the size before relying on it. "
                 "An open loop means the mesh is open where the plane crosses it."),
    }


def _closest_on_triangles(point: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Closest points on many triangles to one point, or row by row to many (Ericson, Real-Time Collision Detection, 5.1.5)."""
    ab, ac, ap = b - a, c - a, point - a
    d1, d2 = np.einsum("ij,ij->i", ab, ap), np.einsum("ij,ij->i", ac, ap)
    bp, cp = point - b, point - c
    d3, d4 = np.einsum("ij,ij->i", ab, bp), np.einsum("ij,ij->i", ac, bp)
    d5, d6 = np.einsum("ij,ij->i", ab, cp), np.einsum("ij,ij->i", ac, cp)
    va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
    with np.errstate(divide="ignore", invalid="ignore"):
        total = va + vb + vc
        result = a + ab * (vb / total)[:, None] + ac * (vc / total)[:, None]
        edge_bc = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        # The scalar version tests A, B, AB, C, AC, BC, then the interior and stops at the first match;
        # applying the regions in reverse lets the earliest test overwrite the later ones.
        cases = [
            ((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0), b + (c - b) * edge_bc[:, None]),
            ((vb <= 0) & (d2 >= 0) & (d6 <= 0), a + ac * (d2 / (d2 - d6))[:, None]),
            ((d6 >= 0) & (d5 <= d6), c),
            ((vc <= 0) & (d1 >= 0) & (d3 <= 0), a + ab * (d1 / (d1 - d3))[:, None]),
            ((d3 >= 0) & (d4 <= d3), b),
            ((d1 <= 0) & (d2 <= 0), a),
        ]
    for mask, value in cases:
        result = np.where(mask[:, None], np.broadcast_to(value, result.shape), result)
    return result


def closest_point(items: list[Occurrence], point: np.ndarray) -> dict:
    best = None
    for item in items:
        corners = item.vertices[item.triangles]
        bound = np.linalg.norm(item.vertices - point, axis=1).min()
        low, high = corners.min(axis=1), corners.max(axis=1)
        gap = np.linalg.norm(np.maximum(0, np.maximum(low - point, point - high)), axis=1)
        # A triangle with a repeated corner has no surface of its own: its edges belong to its neighbours.
        candidates = np.setdiff1d(np.flatnonzero(gap <= bound + 1e-9), item.part.degenerate_triangles, assume_unique=True)
        if not len(candidates):
            continue
        nearest = _closest_on_triangles(point, *(corners[candidates, slot] for slot in range(3)))
        distances = _finite(np.linalg.norm(nearest - point, axis=1))
        index = int(np.argmin(distances))
        if best is None or distances[index] < best["distance"]:
            best = {"distance": float(distances[index]), "point": nearest[index], "part": item.label, "triangle": int(candidates[index])}
    return best


def _surface_samples(items: list[Occurrence], count: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vertices, triangle centres and area-weighted surface points, each tagged with its occurrence and triangle."""
    points, owners, triangles = [], [], []
    total = sum(item.part.area for item in items) or 1.0
    rng = np.random.default_rng(0)
    for index, item in enumerate(items):
        corners = item.vertices[item.triangles]
        area = np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1) / 2
        extra = int(count * item.part.area / total)
        chosen = rng.choice(len(area), size=extra, p=area / area.sum()) if extra and area.sum() else np.zeros(0, dtype=int)
        r1, r2 = np.sqrt(rng.random(len(chosen))), rng.random(len(chosen))
        weights = np.column_stack([1 - r1, r1 * (1 - r2), r1 * r2])
        sampled = np.einsum("ij,ijk->ik", weights, corners[chosen])
        incident = np.empty(len(item.vertices), dtype=np.int64)
        incident[item.triangles.ravel()] = np.repeat(np.arange(len(item.triangles)), 3)
        for group, tags in ((item.vertices, incident), (corners.mean(axis=1), np.arange(len(corners))), (sampled, chosen)):
            points.append(group)
            owners.append(np.full(len(group), index))
            triangles.append(tags)
    return np.concatenate(points), np.concatenate(owners), np.concatenate(triangles)


def surface_distance(source: list[Occurrence], target: list[Occurrence], neighbours: int = 6) -> dict:
    """How far source's vertices lie from target's surface: exact on the target triangles nearest each vertex."""
    points, owners, triangles = _surface_samples(target, 2_000_000)
    tree = cKDTree(points)
    queries = np.concatenate([item.vertices for item in source])
    distances = np.empty(len(queries))
    closest = np.empty((len(queries), 3))
    for start in range(0, len(queries), 50_000):
        chunk = queries[start:start + 50_000]
        _, found = tree.query(chunk, k=neighbours)
        best = np.full(len(chunk), np.inf)
        nearest = np.zeros((len(chunk), 3))
        for column in range(neighbours):
            hit = found[:, column]
            corners = np.empty((len(chunk), 3, 3))
            for index, item in enumerate(target):
                mask = owners[hit] == index
                corners[mask] = item.vertices[item.triangles[triangles[hit[mask]]]]
            candidates = _closest_on_rows(chunk, corners)
            length = _finite(np.linalg.norm(candidates - chunk, axis=1))
            better = length < best
            best[better], nearest[better] = length[better], candidates[better]
        distances[start:start + len(chunk)], closest[start:start + len(chunk)] = best, nearest
    worst = int(np.argmax(distances))
    least = int(np.argmin(distances))
    return {
        "minimum": {"distance": distances[least], "from": queries[least], "to": closest[least]},
        "maximum": {"distance": distances[worst], "from": queries[worst], "to": closest[worst]},
        "mean": float(distances.mean()), "p95": float(np.percentile(distances, 95)), "vertices": len(queries),
    }


def _finite(distances: np.ndarray) -> np.ndarray:
    """Zero-area triangles give no closest point (NaN); they must never win a minimum."""
    return np.where(np.isfinite(distances), distances, np.inf)


def _closest_on_rows(points: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """Closest point on each row's triangle to that row's point."""
    return _closest_on_triangles(points, corners[:, 0], corners[:, 1], corners[:, 2])


def faults(items: list[Occurrence]) -> dict:
    parts = []
    for item in items:
        part = item.part
        holes = []
        for chain, closed in _chains([tuple(edge) for edge in part.open_edges.tolist()]):
            path = item.vertices[chain]
            holes.append({"closed": closed, "edges": len(chain) - 1, "length": float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum()),
                          "center": path.mean(axis=0), "bounds": _bounds(path)})
        holes.sort(key=lambda hole: -hole["length"])
        midpoint = lambda edges: (item.vertices[edges[:MAX_REPORTED, 0]] + item.vertices[edges[:MAX_REPORTED, 1]]) / 2 if len(edges) else []
        corners = item.vertices[item.triangles[part.degenerate_triangles[:MAX_REPORTED]]]
        parts.append({
            "name": item.label, "closed": part.closed,
            "openEdges": {"count": len(part.open_edges), "boundaries": len(holes), "largest": holes[:MAX_REPORTED]},
            "oversharedEdges": {"count": len(part.overshared_edges), "midpoints": midpoint(part.overshared_edges)},
            "flippedEdges": {"count": len(part.flipped_edges), "midpoints": midpoint(part.flipped_edges)},
            "degenerateTriangles": {"count": len(part.degenerate_triangles), "triangles": part.degenerate_triangles[:MAX_REPORTED],
                                    "centers": corners.mean(axis=1) if len(corners) else []},
        })
    return {"parts": parts, "note": f"Lists keep the first {MAX_REPORTED} of each kind; counts are complete. Open boundaries are holes or the edge of an open surface."}


def _reading_options(parser: argparse.ArgumentParser, defaults: bool) -> None:
    """How to read the file and which parts to measure, given before or after the measurement's name."""
    default = (lambda value: value) if defaults else (lambda value: argparse.SUPPRESS)
    parser.add_argument("--units", default=default("auto"), choices=["auto", *meshes.UNITS])
    parser.add_argument("--up", default=default("auto"), choices=["auto", *meshes.UP_AXES])
    parser.add_argument("--part", default=default(None), help="only parts whose name, as the viewer lists it, matches; * and ? are wildcards")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("file", type=Path)
    _reading_options(parser, defaults=True)
    shared = argparse.ArgumentParser(add_help=False)
    _reading_options(shared, defaults=False)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("size", parents=[shared], help="overall and per-part sizes, triangle counts, closed or open, area and volume")
    cut = commands.add_parser("section", parents=[shared], help="outline loops where a plane cuts the mesh, with circle, slot and rectangle fits")
    for name in AXES:
        cut.add_argument(f"--{name}", type=float, help=f"plane at this {name.upper()} position (mm)")
    cut.add_argument("--plane", nargs=2, metavar=("POINT", "NORMAL"), help="any plane: a point and a normal, each as x,y,z")
    cut.add_argument("--points", type=int, default=0, help="include up to this many outline points per loop")
    span = commands.add_parser("distance", parents=[shared], help="between two points, from a point to the surface, or from this mesh to another file")
    span.add_argument("--from", dest="start", help="a world point x,y,z (mm)")
    span.add_argument("--to", help="a second world point x,y,z (mm); without it, the closest surface point")
    span.add_argument("--to-file", type=Path, help="another mesh file: how far this mesh's vertices lie from its surface")
    span.add_argument("--other-units", default="auto", choices=["auto", *meshes.UNITS])
    span.add_argument("--other-up", default="auto", choices=["auto", *meshes.UP_AXES])
    span.add_argument("--other-part")
    commands.add_parser("faults", parents=[shared], help="where the open, over-shared and flipped edges and zero-area triangles are")
    args = parser.parse_args(argv)
    try:
        document = meshes.load(args.file, args.units, args.up)
        items = occurrences(document, args.part)
        result: dict = {"file": document.name, "frame": document.frame}
        if args.command == "size":
            result.update(size(document, items))
        elif args.command == "section":
            result.update(section(items, args))
        elif args.command == "faults":
            result.update(faults(items))
        elif args.to_file:
            other = meshes.load(args.to_file, args.other_units, args.other_up)
            result["other"] = {"file": other.name, "frame": other.frame}
            result["deviation"] = surface_distance(items, occurrences(other, args.other_part))
            result["note"] = ("Distances from each vertex of this mesh to the other file's surface, both in their own files' frames. "
                              "Each is exact against the few triangles nearest it, which is the true closest for all but very coarse meshes.")
        elif args.start:
            start = _vector(args.start, "--from")
            if args.to:
                end = _vector(args.to, "--to")
                result.update({"from": start, "to": end, "distance": float(np.linalg.norm(end - start)), "delta": end - start})
            else:
                result.update({"from": start, "closest": closest_point(items, start)})
        else:
            raise meshes.MeshError("distance needs --from (with or without --to) or --to-file.")
    except (OSError, ValueError, MemoryError) as error:
        print(f"Mesh measurement failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(_round(result), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
