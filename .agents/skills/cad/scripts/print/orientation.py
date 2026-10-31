"""Print-orientation checks of one part as it sits on the bed: bed contact, overhangs that need
support, horizontal undersides (their span and the material above them) and walls under two line
widths. These are measurements with stated methods and limits, not a printability verdict."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field

import numpy as np
from scipy import ndimage
from trimesh.graph import connected_components, face_adjacency

from .bambu import setting
from .meshes import PrintMesh


ON_BED_MM = 1e-3
# Downward faces whose lowest point is this close above the bed print on support or air: usually a
# bed face split into slightly different heights.
LIFTED_MM = 1.0
# A tilt from vertical worth reviewing (the fdm-design skill's convention: 90 degrees is a horizontal
# underside). It flags, it does not decide.
REVIEW_TILT_DEG = 45.0
# Undersides within this many degrees of horizontal count as flat ceilings.
FLAT_DEG = 2.0
DEFAULT_BRIDGE_REVIEW_MM = 5.0
# The wall check rasterises sampled layers; it caps pixels per layer and layers per part.
WALL_PIXELS = 2_000_000
WALL_LAYERS = 120
WALL_EXTRA_LAYERS = 120
# Thin places shorter than this, such as the tapering edge of a chamfer or fillet, are counted, not listed.
WALL_MIN_HEIGHT_MM = 1.0
REPORTED = 5


@dataclass(frozen=True)
class CheckSettings:
    layer_height: float
    first_layer_height: float
    line_width: float
    # Bambu's support_threshold_angle: undersides sloping less than this from horizontal get support.
    support_threshold_deg: float
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
            bridge_review_mm=bridge_review_mm,
        )

    @property
    def min_wall_mm(self) -> float:
        return 2 * self.line_width


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
    groups = connected_components(adjacency[keep], nodes=indices, min_len=1)
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
    """Pixels inside closed loops of directed 2D segments by the nonzero winding rule, sampled at
    pixel centres. Loops with their inside on the left wind +1; overlapping solids stay filled."""
    rows_n, cols_n = shape
    mask = np.zeros(shape, dtype=bool)
    if not len(segments):
        return mask
    (ax, ay), (bx, by) = segments[:, 0].T, segments[:, 1].T
    first = np.ceil((np.minimum(ay, by) - origin[1]) / pitch - 0.5).astype(np.int64)
    stop = np.ceil((np.maximum(ay, by) - origin[1]) / pitch - 0.5).astype(np.int64)
    counts = np.clip(stop - first, 0, None)
    if not counts.sum():
        return mask
    owner = np.repeat(np.arange(len(segments)), counts)
    rows = first[owner] + np.arange(counts.sum()) - np.repeat(np.cumsum(counts) - counts, counts)
    y = origin[1] + (rows + 0.5) * pitch
    x = ax[owner] + (y - ay[owner]) * (bx[owner] - ax[owner]) / (by[owner] - ay[owner])
    columns = np.clip(np.ceil((x - origin[0]) / pitch - 0.5).astype(np.int64), 0, cols_n)
    winding = np.zeros((rows_n, cols_n + 1), dtype=np.int32)
    np.add.at(winding, (np.clip(rows, 0, rows_n - 1), columns), np.where(by[owner] > ay[owner], -1, 1))
    return np.cumsum(winding, axis=1)[:, :cols_n] != 0


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
    low = segments.reshape(-1, 2).min(axis=0) - pad * pitch
    high = segments.reshape(-1, 2).max(axis=0) + pad * pitch
    shape = (int(math.ceil((high[1] - low[1]) / pitch)), int(math.ceil((high[0] - low[0]) / pitch)))
    return _fill(segments, (float(low[0]), float(low[1])), shape, pitch), (float(low[0]), float(low[1]))


def _heights_above(mesh: PrintMesh, points: np.ndarray) -> np.ndarray:
    """For each (x, y, z) point, the distance up to the next surface of the mesh (inf if none)."""
    tri = mesh.triangles
    low, high = tri[:, :, :2].min(axis=1), tri[:, :, :2].max(axis=1)
    (x0, y0), (x1, y1), (x2, y2) = tri[:, 0, :2].T, tri[:, 1, :2].T, tri[:, 2, :2].T
    det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    usable = np.abs(det) > 1e-12
    result = np.full(len(points), np.inf)
    for index, (px, py, pz) in enumerate(points):
        near = usable & (low[:, 0] <= px) & (px <= high[:, 0]) & (low[:, 1] <= py) & (py <= high[:, 1])
        if not near.any():
            continue
        t, d = tri[near], det[near]
        a = ((t[:, 1, 1] - t[:, 2, 1]) * (px - t[:, 2, 0]) + (t[:, 2, 0] - t[:, 1, 0]) * (py - t[:, 2, 1])) / d
        b = ((t[:, 2, 1] - t[:, 0, 1]) * (px - t[:, 2, 0]) + (t[:, 0, 0] - t[:, 2, 0]) * (py - t[:, 2, 1])) / d
        c = 1 - a - b
        inside = (a >= -1e-9) & (b >= -1e-9) & (c >= -1e-9)
        z = a * t[:, 0, 2] + b * t[:, 1, 2] + c * t[:, 2, 2]
        above = z[inside & (z > pz + 1e-4)]
        if len(above):
            result[index] = above.min() - pz
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


def _undersides(mesh: PrintMesh, flat: np.ndarray, adjacency: np.ndarray, shared_edges: np.ndarray) -> list[Underside]:
    """Each flat underside above the bed, measured on a raster: how far its points are from the
    edges where material below holds it, and the material above it, sampled with vertical rays."""
    found = []
    indices = np.flatnonzero(flat)
    if not len(indices):
        return found
    keep = flat[adjacency].all(axis=1)
    for group in connected_components(adjacency[keep], nodes=indices, min_len=1):
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
        mask, origin = _raster(segments, pitch)
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
        above = _heights_above(mesh, np.vstack([middle, mesh.triangles[group][order].mean(axis=1)]))
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


def _thin_walls(mesh: PrintMesh, settings: CheckSettings, flat_heights: np.ndarray) -> tuple[list[ThinWall], dict]:
    """Walls thinner than two line widths in sampled layer outlines: pixels with no point deeper
    than half that width nearby, in groups at least about as long as the limit."""
    limit = settings.min_wall_mm
    width, depth, _ = mesh.size
    pitch = max(settings.line_width / 4, math.sqrt(float(width * depth) / WALL_PIXELS))
    limit_px = limit / pitch
    window = 2 * math.ceil(limit_px / 2) + 1
    heights = _layer_heights(mesh, settings, flat_heights)
    findings: list[tuple[float, float, float, float, float]] = []
    for z in heights:
        segments = _section(mesh, float(z))
        if not len(segments):
            continue
        mask, origin = _raster(segments, pitch)
        distance = ndimage.distance_transform_edt(mask)
        thin = mask & (ndimage.maximum_filter(distance, size=window) < (limit_px + 1) / 2)
        if not thin.any():
            continue
        labels, _ = ndimage.label(thin, structure=np.ones((3, 3)))
        pixels = np.flatnonzero(thin)
        label = labels.ravel()[pixels]
        rows, cols = np.divmod(pixels, thin.shape[1])
        sizes = np.bincount(label)
        deepest = np.zeros(len(sizes))
        np.maximum.at(deepest, label, distance.ravel()[pixels])
        centre_rows = np.bincount(label, weights=rows) / np.maximum(sizes, 1)
        centre_cols = np.bincount(label, weights=cols) / np.maximum(sizes, 1)
        for index in np.flatnonzero(sizes * pitch * pitch >= limit * limit):
            thickness = max(2 * float(deepest[index]) - 1, 1) * pitch
            x = origin[0] + (centre_cols[index] + 0.5) * pitch
            y = origin[1] + (centre_rows[index] + 0.5) * pitch
            findings.append((thickness, float(z), x, y, float(sizes[index])))
    clusters: list[dict] = []
    for thickness, z, x, y, _ in sorted(findings, key=lambda item: item[1]):
        cluster = next((c for c in clusters if math.hypot(c["x"] - x, c["y"] - y) <= 2.0), None)
        if cluster is None:
            clusters.append({"x": x, "y": y, "z": [z, z], "thickness": thickness, "at": (x, y, z)})
            continue
        cluster["z"][1] = z
        if thickness < cluster["thickness"]:
            cluster.update(thickness=thickness, at=(x, y, z))
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
        "method": "layer outlines rasterised at layer centres; thickness is within one pitch",
    }
    return walls, method


def check_orientation(mesh: PrintMesh, settings: CheckSettings) -> OrientationReport:
    """Measure a mesh already turned into its print orientation (lowest point at z = 0)."""
    tri, normals, areas = mesh.triangles, mesh.normals, mesh.areas
    adjacency, shared_edges = face_adjacency(mesh.faces, return_edges=True)
    z_low, z_high = tri[:, :, 2].min(axis=1), tri[:, :, 2].max(axis=1)
    downward = normals[:, 2] < 0
    tilt = np.degrees(np.arcsin(np.clip(-normals[:, 2], -1.0, 1.0)))
    on_bed = (normals[:, 2] < -math.cos(math.radians(FLAT_DEG))) & (z_high <= ON_BED_MM)
    bed_islands = _regions(mesh, on_bed, adjacency)
    lifted = downward & ~on_bed & (tilt > REVIEW_TILT_DEG) & (z_low > ON_BED_MM) & (z_low <= LIFTED_MM)
    over = downward & ~on_bed
    needs = over & (tilt > 90.0 - settings.support_threshold_deg)
    flat = over & (tilt > 90.0 - FLAT_DEG)
    flat_heights = z_low[(np.abs(normals[:, 2]) > math.cos(math.radians(FLAT_DEG)))]
    undersides = _undersides(mesh, flat, adjacency, shared_edges)
    walls, wall_check = _thin_walls(mesh, settings, flat_heights)
    report = OrientationReport(
        size_mm=_round(mesh.size),
        bodies=mesh.bodies,
        bed_contact_mm2=round(float(areas[on_bed].sum()), 2),
        bed_contact_islands=len(bed_islands),
        lifted_near_bed=_regions(mesh, lifted, adjacency)[:REPORTED],
        overhang_review_mm2=round(float(areas[over & (tilt > REVIEW_TILT_DEG)].sum()), 2),
        needs_support_mm2=round(float(areas[needs].sum()), 2),
        support_regions=_regions(mesh, needs, adjacency)[:REPORTED],
        undersides=undersides[:REPORTED],
        thin_walls=walls[:REPORTED],
        wall_check=wall_check,
        limits={
            "support_beyond_tilt_deg": round(90.0 - settings.support_threshold_deg, 1),
            "review_tilt_deg": REVIEW_TILT_DEG,
            "bridge_review_mm": settings.bridge_review_mm,
            "min_wall_mm": round(settings.min_wall_mm, 3),
            "layer_height_mm": settings.layer_height,
        },
    )
    report.flags = _flags(report, settings, undersides, walls)
    return report


def _limited(lines: list[str], what: str) -> list[str]:
    if len(lines) <= REPORTED:
        return lines
    return lines[:REPORTED] + [f"{len(lines) - REPORTED} more {what} like these"]


def _flags(report: OrientationReport, settings: CheckSettings, undersides: list[Underside], walls: list[ThinWall]) -> list[str]:
    """Findings worth a look; every underside and wall counts, not just the ones listed."""
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
    flags += _limited(bridges, "bridges") + _limited(shelves, "thin shelves") + _limited(thin, "thin walls")
    if len(walls) > len(tall):
        flags.append(
            f"{len(walls) - len(tall)} thin place(s) shorter than {WALL_MIN_HEIGHT_MM:g} mm, such as the edge of a chamfer or fillet"
        )
    return flags
