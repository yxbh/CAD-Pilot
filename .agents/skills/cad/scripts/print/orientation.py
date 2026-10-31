"""Print-orientation checks of one part as it sits on the bed: bed contact, overhangs that need
support, horizontal undersides (their span and the material above them), walls under two line
widths, and the holes layer outlines enclose (small ones, and ones that open to the outside at other
heights). These are measurements with stated methods and limits, not a printability verdict."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field

import numpy as np
from scipy import ndimage

from .bambu import setting
from .layout import Rect
from .meshes import PrintMesh, trimesh_module


ON_BED_MM = 1e-3
# Downward faces whose lowest point is this close above the bed print on support or air: usually a
# bed face split into slightly different heights.
LIFTED_MM = 1.0
# A tilt from vertical worth reviewing (the fdm-design skill's convention: 90 degrees is a horizontal
# underside). It flags, it does not decide.
REVIEW_TILT_DEG = 45.0
# Undersides within this many degrees of horizontal count as flat ceilings.
FLAT_DEG = 2.0
# Meshing tilts a face's triangles by up to about half a degree, so a modelled 45 degree chamfer is
# not past 45 degrees, nor a modelled 60 degree slope past the support angle.
TILT_TOLERANCE_DEG = 1.0
DEFAULT_BRIDGE_REVIEW_MM = 5.0
# The wall check rasterises sampled layers; it caps pixels per layer and layers per part.
WALL_PIXELS = 2_000_000
WALL_LAYERS = 120
WALL_EXTRA_LAYERS = 120
# Thin places shorter than this, such as the tapering edge of a chamfer or fillet, are counted, not listed.
WALL_MIN_HEIGHT_MM = 1.0
# Layer rasters reach this many pixels past the part, so the outside is one connected region.
LAYER_PAD = 2
# Enclosed holes narrower than the larger of these print close to the nozzle's own width.
SMALL_HOLE_MM = 1.0
SMALL_HOLE_NOZZLES = 2.5
# Enclosed voids of fewer pixels are rasterisation noise where outlines meet.
HOLE_MIN_PIXELS = 4
# Small holes shallower than this, such as a marking dimple, are counted, not listed.
HOLE_MIN_HEIGHT_MM = 1.0
# A hole runs to the outside at a neighbouring sampled layer when its footprint there joins the
# outside while at least this share of the material around it is still there; under a hole at the
# edge of an overhang there is nothing around it, and no step.
OPEN_WALL_SHARE = 0.5
# Each thin place is measured across the layer outline itself, on lines at this many headings through
# up to CHORD_POINTS of its deepest raster points, so its thickness does not depend on where the
# raster's pixels fall.
CHORD_HEADINGS = 36
CHORD_POINTS = 9
REPORTED = 5


@dataclass(frozen=True)
class CheckSettings:
    layer_height: float
    first_layer_height: float
    line_width: float
    # Bambu's support_threshold_angle: undersides sloping less than this from horizontal get support.
    support_threshold_deg: float
    nozzle_mm: float
    bridge_review_mm: float = DEFAULT_BRIDGE_REVIEW_MM

    @classmethod
    def from_settings(cls, settings: Mapping, *, bridge_review_mm: float = DEFAULT_BRIDGE_REVIEW_MM) -> "CheckSettings":
        def number(key: str) -> float:
            value = setting(settings[key])
            if value.endswith("%"):
                return float(value[:-1]) / 100 * number("nozzle_diameter")
            return float(value)

        threshold = number("support_threshold_angle")
        return cls(
            layer_height=number("layer_height"),
            first_layer_height=number("initial_layer_print_height"),
            line_width=max(number("outer_wall_line_width"), number("line_width")),
            # Bambu treats 0 as its 30 degree default.
            support_threshold_deg=threshold if threshold > 0 else 30.0,
            nozzle_mm=number("nozzle_diameter"),
            bridge_review_mm=bridge_review_mm,
        )

    @property
    def min_wall_mm(self) -> float:
        return 2 * self.line_width

    @property
    def small_hole_mm(self) -> float:
        return max(SMALL_HOLE_MM, SMALL_HOLE_NOZZLES * self.nozzle_mm)


@dataclass(frozen=True)
class Region:
    area_mm2: float
    print_z_mm: tuple[float, float]
    model_xyz_mm: tuple[float, float, float]


@dataclass(frozen=True)
class Underside:
    """A flat underside above the bed. A bridge is held from below on opposite sides and ``span_mm``
    is the distance between them; an overhang is held on one side only and ``span_mm`` is how far it
    reaches out; an island is held nowhere. ``thickness_mm`` is the thinnest material above it."""

    kind: str
    print_z_mm: float
    area_mm2: float
    span_mm: float | None
    thickness_mm: float | None
    model_xyz_mm: tuple[float, float, float]


@dataclass(frozen=True)
class ThinWall:
    """A place thinner than the limit, through ``height_mm`` of sampled layers."""

    thickness_mm: float
    print_z_mm: tuple[float, float]
    height_mm: float
    model_xyz_mm: tuple[float, float, float]


@dataclass(frozen=True)
class Hole:
    """An opening the layer outlines enclose through ``print_z_mm`` of sampled layers. ``across_mm`` is
    the widest round pin that fits it at its narrowest when that is under the small-hole limit, else
    None; ``opens_at_mm`` lists sampled heights where the same opening runs to the outside instead."""

    across_mm: float | None
    print_z_mm: tuple[float, float]
    model_xyz_mm: tuple[float, float, float]
    opens_at_mm: tuple[float, ...]


@dataclass
class OrientationReport:
    size_mm: tuple[float, float, float]
    bodies: int
    bed_contact_mm2: float
    bed_contact_islands: int
    lifted_near_bed: list[Region]
    overhang_review_mm2: float
    needs_support_mm2: float
    support_regions: list[Region]
    undersides: list[Underside]
    thin_walls: list[ThinWall]
    wall_check: dict
    holes: list[Hole]
    hole_check: dict
    limits: dict
    flags: list[str] = field(default_factory=list)

    @property
    def needs_support(self) -> bool:
        return self.needs_support_mm2 > 0

    def as_dict(self) -> dict:
        data = asdict(self)
        data["needs_support"] = self.needs_support
        return data


def _round(values, digits: int = 2):
    return tuple(round(float(v), digits) for v in values)


def _regions(mesh: PrintMesh, selected: np.ndarray, adjacency: np.ndarray) -> list[Region]:
    """Connected groups of the selected faces, largest first."""
    indices = np.flatnonzero(selected)
    if not len(indices):
        return []
    keep = selected[adjacency].all(axis=1)
    groups = trimesh_module().graph.connected_components(adjacency[keep], nodes=indices, min_len=1)
    regions = []
    for group in groups:
        group = np.asarray(group)
        areas = mesh.areas[group]
        tri = mesh.triangles[group]
        centre = (tri.mean(axis=1) * areas[:, None]).sum(axis=0) / max(areas.sum(), 1e-12)
        z = tri[:, :, 2]
        regions.append(
            Region(round(float(areas.sum()), 2), _round((z.min(), z.max())), _round(mesh.model_point(centre)))
        )
    return sorted(regions, key=lambda region: -region.area_mm2)


def _fill(segments: np.ndarray, origin: tuple[float, float], shape: tuple[int, int], pitch: float) -> np.ndarray:
    """The winding number of closed loops of directed 2D segments at each pixel centre; pixels with a
    nonzero one are inside. Loops with their inside on the left wind +1; overlapping solids stay filled."""
    rows_n, cols_n = shape
    outside = np.zeros(shape, dtype=np.int32)
    if not len(segments):
        return outside
    (ax, ay), (bx, by) = segments[:, 0].T, segments[:, 1].T
    first = np.ceil((np.minimum(ay, by) - origin[1]) / pitch - 0.5).astype(np.int64)
    stop = np.ceil((np.maximum(ay, by) - origin[1]) / pitch - 0.5).astype(np.int64)
    counts = np.clip(stop - first, 0, None)
    if not counts.sum():
        return outside
    owner = np.repeat(np.arange(len(segments)), counts)
    rows = first[owner] + np.arange(counts.sum()) - np.repeat(np.cumsum(counts) - counts, counts)
    y = origin[1] + (rows + 0.5) * pitch
    x = ax[owner] + (y - ay[owner]) * (bx[owner] - ax[owner]) / (by[owner] - ay[owner])
    columns = np.clip(np.ceil((x - origin[0]) / pitch - 0.5).astype(np.int64), 0, cols_n)
    winding = np.zeros((rows_n, cols_n + 1), dtype=np.int32)
    np.add.at(winding, (np.clip(rows, 0, rows_n - 1), columns), np.where(by[owner] > ay[owner], -1, 1))
    return np.cumsum(winding, axis=1)[:, :cols_n]


def _section(mesh: PrintMesh, z: float) -> np.ndarray:
    """The part's outline at height z as directed segments, inside on the left."""
    tri = mesh.triangles
    above = tri[:, :, 2] > z
    crossing = (above.sum(axis=1) % 3) != 0
    tri, above, normals = tri[crossing], above[crossing], mesh.normals[crossing]
    points, hits = [], []
    for i, j in ((0, 1), (1, 2), (2, 0)):
        hit = above[:, i] != above[:, j]
        dz = np.where(hit, tri[:, j, 2] - tri[:, i, 2], 1.0)
        t = (z - tri[:, i, 2]) / dz
        points.append(tri[:, i, :2] + t[:, None] * (tri[:, j, :2] - tri[:, i, :2]))
        hits.append(hit)
    segments = np.stack(points, axis=1)[np.stack(hits, axis=1)].reshape(-1, 2, 2)
    direction = segments[:, 1] - segments[:, 0]
    reverse = direction[:, 0] * -normals[:, 1] + direction[:, 1] * normals[:, 0] < 0
    segments[reverse] = segments[reverse][:, ::-1]
    return segments


def _raster(segments: np.ndarray, pitch: float, pad: int = 2) -> tuple[np.ndarray, tuple[float, float]]:
    """The segments' winding numbers on a grid of this pitch around them, and the grid's origin."""
    low = segments.reshape(-1, 2).min(axis=0) - pad * pitch
    high = segments.reshape(-1, 2).max(axis=0) + pad * pitch
    shape = (int(math.ceil((high[1] - low[1]) / pitch)), int(math.ceil((high[0] - low[0]) / pitch)))
    return _fill(segments, (float(low[0]), float(low[1])), shape, pitch), (float(low[0]), float(low[1]))


class _VerticalRays:
    """Rays straight up through a mesh. Triangles are bucketed once on an XY grid, so each ray tests
    only the triangles over its cell."""

    def __init__(self, mesh: PrintMesh) -> None:
        tri = mesh.triangles
        (x0, y0), (x1, y1), (x2, y2) = tri[:, 0, :2].T, tri[:, 1, :2].T, tri[:, 2, :2].T
        det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        # Walls seen edge-on from above cannot be crossed by a vertical ray.
        keep = np.flatnonzero(np.abs(det) > 1e-12)
        self.tri, self.det = tri[keep], det[keep]
        low, high = self.tri[:, :, :2].min(axis=1), self.tri[:, :, :2].max(axis=1)
        self.origin = low.min(axis=0) if len(keep) else np.zeros(2)
        extent = float((high.max(axis=0) - self.origin).max()) if len(keep) else 1.0
        self.cell = max(float(np.median((high - low).max(axis=1))) if len(keep) else 1.0, extent / 512, 1e-3)
        first = np.floor((low - self.origin) / self.cell).astype(np.int64)
        last = np.floor((high - self.origin) / self.cell).astype(np.int64)
        across, along = last[:, 0] - first[:, 0] + 1, last[:, 1] - first[:, 1] + 1
        counts = across * along
        owner = np.repeat(np.arange(len(keep)), counts)
        local = np.arange(counts.sum()) - np.repeat(np.cumsum(counts) - counts, counts)
        cx = first[owner, 0] + local % across[owner]
        cy = first[owner, 1] + local // across[owner]
        order = np.argsort(self._key(cx, cy), kind="stable")
        self.keys, self.owner = self._key(cx, cy)[order], owner[order]

    @staticmethod
    def _key(cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
        return cx * (1 << 32) + cy

    def heights_above(self, points: np.ndarray) -> np.ndarray:
        """For each (x, y, z) point, the distance up to the next surface (inf if none)."""
        points = np.asarray(points, dtype=float).reshape(-1, 3)
        result = np.full(len(points), np.inf)
        cells = np.floor((points[:, :2] - self.origin) / self.cell).astype(np.int64)
        keys = self._key(cells[:, 0], cells[:, 1])
        start, stop = np.searchsorted(self.keys, keys, "left"), np.searchsorted(self.keys, keys, "right")
        counts = stop - start
        if not counts.sum():
            return result
        ray = np.repeat(np.arange(len(points)), counts)
        candidate = self.owner[np.repeat(start, counts) + np.arange(counts.sum()) - np.repeat(np.cumsum(counts) - counts, counts)]
        t, d = self.tri[candidate], self.det[candidate]
        px, py, pz = points[ray, 0], points[ray, 1], points[ray, 2]
        a = ((t[:, 1, 1] - t[:, 2, 1]) * (px - t[:, 2, 0]) + (t[:, 2, 0] - t[:, 1, 0]) * (py - t[:, 2, 1])) / d
        b = ((t[:, 2, 1] - t[:, 0, 1]) * (px - t[:, 2, 0]) + (t[:, 0, 0] - t[:, 2, 0]) * (py - t[:, 2, 1])) / d
        c = 1 - a - b
        z = a * t[:, 0, 2] + b * t[:, 1, 2] + c * t[:, 2, 2]
        hit = (a >= -1e-9) & (b >= -1e-9) & (c >= -1e-9) & (z > pz + 1e-4)
        np.minimum.at(result, ray[hit], z[hit] - pz[hit])
        return result


def _anchor_pixels(segments: np.ndarray, origin: tuple[float, float], shape: tuple[int, int], pitch: float) -> np.ndarray:
    mask = np.zeros(shape, dtype=bool)
    for (ax, ay), (bx, by) in segments:
        steps = max(2, int(math.ceil(math.hypot(bx - ax, by - ay) / (pitch / 2))) + 1)
        t = np.linspace(0.0, 1.0, steps)
        cols = np.clip(((ax + t * (bx - ax) - origin[0]) / pitch).astype(int), 0, shape[1] - 1)
        rows = np.clip(((ay + t * (by - ay) - origin[1]) / pitch).astype(int), 0, shape[0] - 1)
        mask[rows, cols] = True
    return mask


def _undersides(mesh: PrintMesh, flat: np.ndarray, adjacency: np.ndarray, shared_edges: np.ndarray, rays: _VerticalRays) -> list[Underside]:
    """Each flat underside above the bed, measured on a raster: how far its points are from the
    edges where material below holds it, and the material above it, sampled with vertical rays."""
    found = []
    indices = np.flatnonzero(flat)
    if not len(indices):
        return found
    keep = flat[adjacency].all(axis=1)
    for group in trimesh_module().graph.connected_components(adjacency[keep], nodes=indices, min_len=1):
        group = np.asarray(group)
        member = np.zeros(len(mesh.faces), dtype=bool)
        member[group] = True
        # An edge is held when the face beyond it runs down from it: a wall or slope underneath.
        crossing = member[adjacency].sum(axis=1) == 1
        pairs, edges = adjacency[crossing], shared_edges[crossing]
        beyond = np.where(member[pairs[:, 0]], pairs[:, 1], pairs[:, 0])
        third = mesh.faces[beyond].sum(axis=1) - edges.sum(axis=1)
        edge_z = mesh.vertices[edges][:, :, 2].mean(axis=1)
        held = {tuple(edge) for edge in np.sort(edges[mesh.vertices[third, 2] < edge_z - 1e-6], axis=1)}
        faces = mesh.faces[group]
        directed = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
        _, inverse, counts = np.unique(np.sort(directed, axis=1), axis=0, return_inverse=True, return_counts=True)
        boundary = directed[counts[inverse.ravel()] == 1]
        segments = mesh.vertices[boundary][:, :, :2]
        extent = np.ptp(segments.reshape(-1, 2), axis=0)
        pitch = max(0.02, math.sqrt(float(extent[0] * extent[1]) / 250_000))
        winding, origin = _raster(segments, pitch)
        mask = winding != 0
        if not mask.any():
            continue
        anchored = np.array([tuple(edge) in held for edge in np.sort(boundary, axis=1)], dtype=bool)
        z = float(mesh.triangles[group][:, :, 2].mean())
        area = round(float(mesh.areas[group].sum()), 2)
        if anchored.any():
            anchors = _anchor_pixels(segments[anchored], origin, mask.shape, pitch)
            reach, nearest = ndimage.distance_transform_edt(~anchors, return_indices=True)
            reach = np.where(mask, reach, -1.0)
            row, col = np.unravel_index(int(np.argmax(reach)), reach.shape)
            to_nearest = np.array([nearest[0][row, col] - row, nearest[1][row, col] - col], dtype=float)
            others = np.argwhere(anchors) - (row, col)
            distance = np.linalg.norm(others, axis=1)
            facing = (others @ -to_nearest) > 0.5 * distance * max(np.linalg.norm(to_nearest), 1e-9)
            if facing.any():
                kind, span = "bridge", (float(reach[row, col]) + float(distance[facing].min())) * pitch
            else:
                kind, span = "overhang", float(reach[row, col]) * pitch
        else:
            inside = ndimage.distance_transform_edt(mask)
            row, col = np.unravel_index(int(np.argmax(inside)), inside.shape)
            kind, span = "island", None
        middle = (origin[0] + (col + 0.5) * pitch, origin[1] + (row + 0.5) * pitch, z)
        order = np.argsort(-mesh.areas[group])[:24]
        above = rays.heights_above(np.vstack([middle, mesh.triangles[group][order].mean(axis=1)]))
        thickness = round(float(above.min()), 2) if np.isfinite(above).any() else None
        found.append(
            Underside(kind, round(z, 2), area, None if span is None else round(span, 2), thickness, _round(mesh.model_point(middle)))
        )
    return sorted(found, key=lambda underside: -(underside.span_mm or 0))


def _layer_heights(mesh: PrintMesh, settings: CheckSettings, flat_heights: np.ndarray) -> np.ndarray:
    """Slice heights at layer centres: evenly sampled through the part, plus the layers just below
    and above every flat face, where short features start and end."""
    height = float(mesh.size[2])
    first, layer = settings.first_layer_height, settings.layer_height
    if height <= first:
        return np.array([height / 2])
    centres = np.concatenate([[first / 2], first + (np.arange(math.ceil((height - first) / layer)) + 0.5) * layer])
    centres = centres[centres < height]
    if len(centres) <= WALL_LAYERS:
        return centres
    chosen = set(np.linspace(0, len(centres) - 1, WALL_LAYERS).round().astype(int))
    nearby = np.searchsorted(centres, np.unique(flat_heights.round(4)))
    for index in np.unique(np.concatenate([nearby - 1, nearby]))[:WALL_EXTRA_LAYERS]:
        if 0 <= index < len(centres):
            chosen.add(int(index))
    return centres[sorted(chosen)]


def _union(a: Rect, b: Rect) -> Rect:
    return Rect(min(a.x0, b.x0), min(a.y0, b.y0), max(a.x1, b.x1), max(a.y1, b.y1))


def _thin_places(segments: np.ndarray, winding: np.ndarray, origin: tuple[float, float], pitch: float, limit: float, limit_px: float, window: int) -> list[tuple[float, tuple[float, float], Rect]]:
    """Places in a layer thinner than the limit: pixels of its raster (the outline ``segments``' winding
    numbers on a grid from ``origin``) with no point deeper than half the limit nearby, in groups at
    least about as long as the limit. Each comes with its thickness, the point where that was measured
    (its thickest, on the material) and its outline's box. The thickness is the shortest chord across
    the outline through the place's deepest pixels, the largest of those at a few of them, since a
    chord through a point near a corner cuts the corner."""
    mask = winding != 0
    if not mask.any():
        return []
    distance = ndimage.distance_transform_edt(mask)
    thin = mask & (ndimage.maximum_filter(distance, size=window) < (limit_px + 1) / 2)
    if not thin.any():
        return []
    labels, _ = ndimage.label(thin, structure=np.ones((3, 3)))
    pixels = np.flatnonzero(thin)
    label = labels.ravel()[pixels]
    depth = distance.ravel()[pixels]
    rows, cols = np.divmod(pixels, thin.shape[1])
    sizes = np.bincount(label)
    count = len(sizes)
    deepest = np.zeros(count)
    np.maximum.at(deepest, label, depth)
    low_rows, high_rows = np.full(count, thin.shape[0]), np.zeros(count, dtype=np.int64)
    low_cols, high_cols = np.full(count, thin.shape[1]), np.zeros(count, dtype=np.int64)
    np.minimum.at(low_rows, label, rows)
    np.maximum.at(high_rows, label, rows)
    np.minimum.at(low_cols, label, cols)
    np.maximum.at(high_cols, label, cols)

    def x(col) -> float:
        return origin[0] + (float(col) + 0.5) * pitch

    def y(row) -> float:
        return origin[1] + (float(row) + 0.5) * pitch

    places = []
    for index in np.flatnonzero(sizes * pitch * pitch >= limit * limit):
        tied = np.flatnonzero((label == index) & (depth == deepest[index]))
        measured = []
        for pixel in tied[np.unique(np.linspace(0, len(tied) - 1, min(len(tied), CHORD_POINTS)).round().astype(int))]:
            at = (x(cols[pixel]), y(rows[pixel]))
            chord = _chord(segments, np.array(at), int(winding[rows[pixel], cols[pixel]]), reach=2 * limit + 2 * pitch)
            if chord is not None:
                measured.append((chord, at))
        # The raster's own estimate, up to two pitches thin, only where no chord is that short.
        thickness, at = max(measured) if measured else (max(2 * float(deepest[index]) - 1, 1) * pitch, (x(cols[tied[0]]), y(rows[tied[0]])))
        box = Rect(x(low_cols[index]), y(low_rows[index]), x(high_cols[index]), y(high_rows[index]))
        places.append((thickness, at, box))
    return places


def _cross(p: np.ndarray, q: np.ndarray) -> np.ndarray:
    return p[..., 0] * q[..., 1] - p[..., 1] * q[..., 0]


def _chord(segments: np.ndarray, point: np.ndarray, winding: int, reach: float) -> float | None:
    """The shortest chord through ``point`` across the material of a layer outline: on lines through it
    at evenly spread headings, the distance between where the line leaves the material on either side,
    by the nonzero winding rule, ``winding`` being the point's own winding number. Only outline within
    ``reach`` of the point counts; None when no chord is that short."""
    near = segments[np.all(segments.min(axis=1) <= point + reach, axis=1) & np.all(segments.max(axis=1) >= point - reach, axis=1)]
    if not len(near) or winding == 0:
        return None
    # Half a step off the axes, so no line runs along an axis-aligned edge or through its corners.
    headings = (np.arange(2 * CHORD_HEADINGS) + 0.5) * math.pi / CHORD_HEADINGS
    ray = np.stack([np.cos(headings), np.sin(headings)], axis=1)[:, None, :]
    start, edge = near[None, :, 0], (near[:, 1] - near[:, 0])[None]
    offset = start - point
    across = _cross(ray, edge)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = _cross(offset, edge) / across
        s = _cross(offset, ray) / across
    hit = (np.abs(across) > 1e-12) & (t > 0) & (t <= reach) & (s >= 0) & (s < 1)
    distance = np.where(hit, t, np.inf)
    order = np.argsort(distance, axis=1)
    distance = np.take_along_axis(distance, order, axis=1)
    # Crossing an edge from its inside (left) to its outside lowers the winding number by one.
    level = winding + np.cumsum(np.take_along_axis(np.where(hit, -np.sign(across), 0), order, axis=1), axis=1)
    leaves = np.isfinite(distance) & (level == 0)
    exits = np.where(leaves.any(axis=1), distance[np.arange(len(headings)), leaves.argmax(axis=1)], np.inf)
    chord = float((exits[:CHORD_HEADINGS] + exits[CHORD_HEADINGS:]).min())
    return chord if math.isfinite(chord) else None


@dataclass
class _Layer:
    """One sampled layer's raster over its own outline, at ``offset`` (row, column) in the part's grid:
    its void regions labelled, the one around the part, and which are holes the outline encloses
    (``enclosed`` is None when there are none). Beyond its raster a layer is all outside."""

    z: float
    offset: tuple[int, int]
    mask: np.ndarray
    labels: np.ndarray
    outside: int
    enclosed: np.ndarray | None
    slices: list
    clusters: dict[int, dict] = field(default_factory=dict)

    def view(self, rows: tuple[int, int], cols: tuple[int, int], what: str) -> np.ndarray:
        """Its solid ``mask`` or its ``outside`` over grid rows and columns [start, stop)."""
        inside = what == "mask"
        full = np.full((rows[1] - rows[0], cols[1] - cols[0]), not inside)
        r0, c0 = self.offset
        r1, c1 = r0 + self.mask.shape[0], c0 + self.mask.shape[1]
        top, bottom, left, right = max(rows[0], r0), min(rows[1], r1), max(cols[0], c0), min(cols[1], c1)
        if top < bottom and left < right:
            own = (slice(top - r0, bottom - r0), slice(left - c0, right - c0))
            part = self.mask[own] if inside else self.labels[own] == self.outside
            full[top - rows[0] : bottom - rows[0], left - cols[0] : right - cols[0]] = part
        return full

    def window(self, hole: int, margin: int) -> tuple[tuple[int, int], tuple[int, int], tuple[slice, slice]]:
        """A hole's box with a margin: in grid rows and columns, and as a slice of this raster."""
        rows, cols = self.slices[hole - 1]
        local = (slice(max(rows.start - margin, 0), rows.stop + margin), slice(max(cols.start - margin, 0), cols.stop + margin))
        stop = (min(local[0].stop, self.mask.shape[0]), min(local[1].stop, self.mask.shape[1]))
        r0, c0 = self.offset
        return (r0 + local[0].start, r0 + stop[0]), (c0 + local[1].start, c0 + stop[1]), local


class _Holes:
    """Holes in sampled layer rasters, followed up through the layers: how narrow each is where it is
    under the small-hole limit, and the neighbouring sampled heights where the same opening runs to
    the outside instead."""

    def __init__(self, limit_mm: float, pitch: float, origin: tuple[float, float]) -> None:
        self.limit_mm, self.pitch, self.origin = limit_mm, pitch, origin
        # A square block of this many pixels inside a hole is a pin at least the limit across.
        self.block = max(1, math.ceil(limit_mm / pitch))
        self.clusters: list[dict] = []
        self.previous: _Layer | None = None

    def _point(self, layer: _Layer, row: float, col: float) -> tuple[float, float, float]:
        return (
            self.origin[0] + (layer.offset[1] + col + 0.5) * self.pitch,
            self.origin[1] + (layer.offset[0] + row + 0.5) * self.pitch,
            layer.z,
        )

    def _middle(self, layer: _Layer, hole: int) -> tuple[float, float, float]:
        rows, cols = layer.slices[hole - 1]
        return self._point(layer, (rows.start + rows.stop - 1) / 2, (cols.start + cols.stop - 1) / 2)

    def _narrow(self, layer: _Layer, holes: np.ndarray) -> dict[int, tuple[float, tuple[float, float, float]]]:
        """The holes under the limit across: each one's widest round pin and where it fits. Holes
        holding a block of the limit's size are wide, and are not measured."""
        k, labels = self.block, layer.labels
        rows, cols = (labels.shape[0] // k) * k, (labels.shape[1] // k) * k
        blocks = layer.enclosed[:rows, :cols].reshape(rows // k, k, cols // k, k).all(axis=(1, 3))
        wide = set(np.unique(labels[:rows:k, :cols:k][blocks]).tolist())
        narrow = {}
        for hole in holes.tolist():
            if hole in wide:
                continue
            # Holes never reach the raster's padded edge, so a pixel of margin around them stays in it.
            _, _, window = layer.window(hole, 1)
            depth = ndimage.distance_transform_edt(labels[window] == hole)
            row, col = np.unravel_index(int(np.argmax(depth)), depth.shape)
            # From the deepest pixel to the nearest solid pixel's centre: rasterised round holes measure
            # within a tenth of a millimetre of their size at the default pitch this way.
            across = (2 * float(depth[row, col]) + 0.5) * self.pitch
            if across < self.limit_mm:
                narrow[hole] = (across, self._point(layer, window[0].start + int(row), window[1].start + int(col)))
        return narrow

    def _continued(self, layer: _Layer, previous: _Layer) -> dict[int, dict]:
        """The clusters this layer's holes continue: those of the holes below whose footprints they overlap."""
        r0, c0 = max(layer.offset[0], previous.offset[0]), max(layer.offset[1], previous.offset[1])
        r1 = min(layer.offset[0] + layer.mask.shape[0], previous.offset[0] + previous.mask.shape[0])
        c1 = min(layer.offset[1] + layer.mask.shape[1], previous.offset[1] + previous.mask.shape[1])
        if r0 >= r1 or c0 >= c1:
            return {}

        def crop(each: _Layer, array: np.ndarray) -> np.ndarray:
            return array[r0 - each.offset[0] : r1 - each.offset[0], c0 - each.offset[1] : c1 - each.offset[1]]

        here, below = crop(layer, layer.labels), crop(previous, previous.labels)
        both = crop(layer, layer.enclosed) & crop(previous, previous.enclosed)
        base = len(previous.slices) + 1
        found: dict[int, dict] = {}
        for pair in np.flatnonzero(np.bincount(here[both].astype(np.int64) * base + below[both])).tolist():
            hole, under = divmod(pair, base)
            if under in previous.clusters:
                found.setdefault(hole, previous.clusters[under])
        return found

    def _opening(self, layer: _Layer, other: _Layer) -> None:
        """Mark the layer's holes whose footprint joins the outside in the other, neighbouring layer
        while most of the material around them is there too."""
        rows = (layer.offset[0], layer.offset[0] + layer.mask.shape[0])
        cols = (layer.offset[1], layer.offset[1] + layer.mask.shape[1])
        joined = np.flatnonzero(np.bincount(layer.labels[layer.enclosed & other.view(rows, cols, "outside")]))
        for hole in joined.tolist():
            if hole not in layer.clusters:
                continue
            rows, cols, local = layer.window(hole, 3)
            own = layer.labels[local] == hole
            ring = ndimage.binary_dilation(own, iterations=2) & ~own
            if ring.any() and float(other.view(rows, cols, "mask")[ring].mean()) >= OPEN_WALL_SHARE:
                layer.clusters[hole]["opens"].append((other.z, self._middle(layer, hole)))

    def gap(self) -> None:
        """A sampled height with no outline: nothing continues across it."""
        self.previous = None

    def add(self, z: float, mask: np.ndarray, offset: tuple[int, int]) -> None:
        labels, count = ndimage.label(~mask)
        outside = int(labels[0, 0])
        holes = np.empty(0, dtype=np.int64)
        if count > 1:
            sizes = np.bincount(labels.ravel(), minlength=count + 1)
            keep = sizes >= HOLE_MIN_PIXELS
            keep[[0, outside]] = False
            holes = np.flatnonzero(keep)
        enclosed = keep[labels] if len(holes) else None
        layer = _Layer(z, offset, mask, labels, outside, enclosed, ndimage.find_objects(labels) if len(holes) else [])
        previous = self.previous
        if enclosed is not None:
            narrow = self._narrow(layer, holes)
            # A hole continues a cluster from the sampled layer just below where their footprints overlap.
            below = self._continued(layer, previous) if previous is not None and previous.enclosed is not None else {}
            for hole in holes.tolist():
                cluster = below.get(hole)
                if cluster is None:
                    cluster = {"z": [z, z], "across": None, "at": self._middle(layer, hole), "opens": []}
                    self.clusters.append(cluster)
                cluster["z"][1] = z
                if hole in narrow and (cluster["across"] is None or narrow[hole][0] < cluster["across"]):
                    cluster["across"], cluster["at"] = narrow[hole]
                layer.clusters[hole] = cluster
        if previous is not None:
            if layer.enclosed is not None:
                self._opening(layer, previous)
            if previous.enclosed is not None:
                self._opening(previous, layer)
        self.previous = layer

    def report(self, mesh: PrintMesh, step: float) -> tuple[list[Hole], dict]:
        """Holes worth a look: small ones at least the listed height deep (a cluster stands for one
        sampling step more than its samples span), and ones that open to the outside."""
        holes, shallow = [], 0
        for cluster in self.clusters:
            if cluster["across"] is not None and not cluster["opens"] and cluster["z"][1] - cluster["z"][0] + step < HOLE_MIN_HEIGHT_MM:
                shallow += 1
                continue
            if cluster["across"] is None and not cluster["opens"]:
                continue
            at = cluster["opens"][0][1] if cluster["opens"] else cluster["at"]
            across = round(cluster["across"], 2) if cluster["across"] is not None else None
            holes.append(Hole(across, _round(cluster["z"]), _round(mesh.model_point(at)), tuple(sorted({round(z, 2) for z, _ in cluster["opens"]}))))
        holes.sort(key=lambda hole: (not hole.opens_at_mm, hole.across_mm or 0.0))
        check = {
            "enclosed": len(self.clusters),
            "small": sum(1 for hole in holes if hole.across_mm is not None),
            "small_shallow": shallow,
            "open_to_outside": sum(1 for hole in holes if hole.opens_at_mm),
            "small_limit_mm": round(self.limit_mm, 3),
            "pitch_mm": round(self.pitch, 3),
            "method": "openings each sampled layer outline encloses, followed through the sampled layers; width is the widest "
            "round pin that fits, within one pitch; holes under about two pitches across are not seen",
        }
        return holes, check


def _scan_layers(mesh: PrintMesh, settings: CheckSettings, flat_heights: np.ndarray) -> tuple[list[ThinWall], dict, list[Hole], dict]:
    """Walls thinner than two line widths and the holes outlines enclose, in sampled layers rasterised
    on one grid; both are grouped through consecutive sampled layers."""
    limit = settings.min_wall_mm
    width, depth, _ = mesh.size
    pitch = max(settings.line_width / 4, math.sqrt(float(width * depth) / WALL_PIXELS))
    limit_px = limit / pitch
    window = 2 * math.ceil(limit_px / 2) + 1
    # Layers are rasterised over their own outlines, on one grid starting just short of the part.
    low = mesh.bounds[0]
    origin = (float(low[0]) - LAYER_PAD * pitch, float(low[1]) - LAYER_PAD * pitch)
    heights = _layer_heights(mesh, settings, flat_heights)
    holes = _Holes(settings.small_hole_mm, pitch, origin)
    clusters: list[dict] = []
    active: list[dict] = []
    for z in heights:
        segments = _section(mesh, float(z))
        found = []
        if len(segments):
            points = segments.reshape(-1, 2)
            c0, r0 = np.floor((points.min(axis=0) - origin) / pitch).astype(int) - LAYER_PAD
            c1, r1 = np.ceil((points.max(axis=0) - origin) / pitch).astype(int) + LAYER_PAD
            c0, r0 = max(int(c0), 0), max(int(r0), 0)
            corner = (origin[0] + c0 * pitch, origin[1] + r0 * pitch)
            winding = _fill(segments, corner, (int(r1) - r0, int(c1) - c0), pitch)
            holes.add(float(z), winding != 0, (r0, c0))
            found = _thin_places(segments, winding, corner, pitch, limit, limit_px, window)
        else:
            holes.gap()
        # A place continues a group only from the sampled layer just below, where its outline overlaps.
        touched: list[dict] = []
        for thickness, at, box in found:
            cluster = next((c for c in active if box.overlaps(c["box"].grown(pitch))), None)
            if cluster is None:
                cluster = {"z": [float(z), float(z)], "thickness": thickness, "at": (*at, float(z))}
                clusters.append(cluster)
            cluster["z"][1] = float(z)
            if thickness < cluster["thickness"]:
                cluster.update(thickness=thickness, at=(*at, float(z)))
            cluster["next"] = box if cluster not in touched else _union(cluster["next"], box)
            if cluster not in touched:
                touched.append(cluster)
        for cluster in touched:
            cluster["box"] = cluster.pop("next")
        active = touched
    # A cluster stands for the layers between its samples, so add one sampling step to its extent.
    step = float(np.median(np.diff(heights))) if len(heights) > 1 else settings.layer_height
    walls = [
        ThinWall(round(c["thickness"], 2), _round(c["z"]), round(c["z"][1] - c["z"][0] + step, 2), _round(mesh.model_point(c["at"])))
        for c in sorted(clusters, key=lambda c: (c["z"][1] - c["z"][0] < WALL_MIN_HEIGHT_MM - step, c["thickness"]))
    ]
    method = {
        "limit_mm": round(limit, 3),
        "pitch_mm": round(pitch, 3),
        "layers_sampled": int(len(heights)),
        "thin_places": len(walls),
        "method": "layer outlines rasterised at layer centres; thickness is the shortest chord across the outline through a thin place's deepest raster points",
    }
    return walls, method, *holes.report(mesh, step)


def check_orientation(mesh: PrintMesh, settings: CheckSettings) -> OrientationReport:
    """Measure a mesh already turned into its print orientation (lowest point at z = 0)."""
    tri, normals, areas = mesh.triangles, mesh.normals, mesh.areas
    adjacency, shared_edges = trimesh_module().graph.face_adjacency(mesh.faces, return_edges=True)
    z_low, z_high = tri[:, :, 2].min(axis=1), tri[:, :, 2].max(axis=1)
    downward = normals[:, 2] < 0
    tilt = np.degrees(np.arcsin(np.clip(-normals[:, 2], -1.0, 1.0)))
    on_bed = (normals[:, 2] < -math.cos(math.radians(FLAT_DEG))) & (z_high <= ON_BED_MM)
    bed_islands = _regions(mesh, on_bed, adjacency)
    over = downward & ~on_bed
    needs = over & (tilt > 90.0 - settings.support_threshold_deg + TILT_TOLERANCE_DEG)
    flat = over & (tilt > 90.0 - FLAT_DEG)
    lifted = flat & (z_low > ON_BED_MM) & (z_low <= LIFTED_MM)
    flat_heights = z_low[(np.abs(normals[:, 2]) > math.cos(math.radians(FLAT_DEG)))]
    undersides = _undersides(mesh, flat, adjacency, shared_edges, _VerticalRays(mesh))
    walls, wall_check, holes, hole_check = _scan_layers(mesh, settings, flat_heights)
    report = OrientationReport(
        size_mm=_round(mesh.size),
        bodies=mesh.bodies,
        bed_contact_mm2=round(float(areas[on_bed].sum()), 2),
        bed_contact_islands=len(bed_islands),
        lifted_near_bed=_regions(mesh, lifted, adjacency)[:REPORTED],
        overhang_review_mm2=round(float(areas[over & (tilt > REVIEW_TILT_DEG + TILT_TOLERANCE_DEG)].sum()), 2),
        needs_support_mm2=round(float(areas[needs].sum()), 2),
        support_regions=_regions(mesh, needs, adjacency)[:REPORTED],
        undersides=undersides[:REPORTED],
        thin_walls=walls[:REPORTED],
        wall_check=wall_check,
        holes=holes[:REPORTED],
        hole_check=hole_check,
        limits={
            "support_beyond_tilt_deg": round(90.0 - settings.support_threshold_deg, 1),
            "review_tilt_deg": REVIEW_TILT_DEG,
            "bridge_review_mm": settings.bridge_review_mm,
            "min_wall_mm": round(settings.min_wall_mm, 3),
            "small_hole_mm": round(settings.small_hole_mm, 3),
            "layer_height_mm": settings.layer_height,
        },
    )
    report.flags = _flags(report, settings, undersides, walls, holes)
    return report


def _limited(lines: list[str], what: str) -> list[str]:
    if len(lines) <= REPORTED:
        return lines
    return lines[:REPORTED] + [f"{len(lines) - REPORTED} more {what} like these"]


def _flags(report: OrientationReport, settings: CheckSettings, undersides: list[Underside], walls: list[ThinWall], holes: list[Hole]) -> list[str]:
    """Findings worth a look; every underside, wall and hole counts, not just the ones listed."""
    flags = []
    if report.bodies > 1:
        flags.append(f"{report.bodies} separate solids print as one object, placed as in the file; split an assembly into one file per part")
    if report.bed_contact_mm2 <= 0:
        flags.append("nothing rests flat on the bed in this orientation")
    for region in report.lifted_near_bed:
        flags.append(
            f"{region.area_mm2} mm² of underside sits {region.print_z_mm[0]} mm above the bed near model {region.model_xyz_mm}: "
            "it prints on support or air; a bed face split into different heights?"
        )
    bridges = [
        f"bridge at print height {u.print_z_mm} mm spans {u.span_mm} mm (review limit {settings.bridge_review_mm} mm) near model "
        f"{u.model_xyz_mm}: it sags unsupported and carries support marks when supported; keep fit faces off it"
        for u in undersides
        if u.kind == "bridge" and u.span_mm >= settings.bridge_review_mm
    ]
    shelves = [
        f"only {u.thickness_mm} mm (about {u.thickness_mm / settings.layer_height:.0f} layers) of material above the underside at "
        f"print height {u.print_z_mm} mm near model {u.model_xyz_mm}: a thin shelf"
        for u in undersides
        if u.thickness_mm is not None and u.thickness_mm < settings.min_wall_mm
    ]
    tall = [wall for wall in walls if wall.height_mm >= WALL_MIN_HEIGHT_MM]
    thin = [
        f"wall about {w.thickness_mm} mm thick (under {settings.min_wall_mm:.2f} mm, two line widths) through print height "
        f"{w.print_z_mm[0]}–{w.print_z_mm[1]} mm near model {w.model_xyz_mm}"
        for w in tall
    ]
    small = [
        f"hole about {h.across_mm} mm across at its narrowest (under {settings.small_hole_mm:g} mm, the larger of "
        f"{SMALL_HOLE_MM:g} mm and {SMALL_HOLE_NOZZLES:g} × the {settings.nozzle_mm:g} mm nozzle) through print height "
        f"{h.print_z_mm[0]}–{h.print_z_mm[1]} mm near model {h.model_xyz_mm}"
        for h in holes
        if h.across_mm is not None
    ]
    stepped = [
        f"hole enclosed through print height {h.print_z_mm[0]}–{h.print_z_mm[1]} mm runs to the outside at print height "
        f"{', '.join(f'{z:g}' for z in h.opens_at_mm)} mm near model {h.model_xyz_mm}: hole compensation applies only "
        "where a layer encloses it, so it leaves a step there"
        for h in holes
        if h.opens_at_mm
    ]
    flags += _limited(bridges, "bridges") + _limited(shelves, "thin shelves") + _limited(thin, "thin walls")
    flags += _limited(small, "small holes") + _limited(stepped, "holes that open to the outside")
    if len(walls) > len(tall):
        flags.append(
            f"{len(walls) - len(tall)} thin place(s) shorter than {WALL_MIN_HEIGHT_MM:g} mm, such as the edge of a chamfer or fillet"
        )
    return flags
