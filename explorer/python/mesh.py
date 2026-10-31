"""Mesh files as CAD Explorer references: STL, OBJ, 3MF, PLY and GLB, read directly and never turned into B-rep.

Geometry comes out in millimetres with Z up. Units and the up axis come from the file when its format
declares them (3MF units; glTF is metres and Y up), otherwise from format conventions and the model's size,
and can always be given explicitly. Vertices that coincide exactly are merged so the file's own connectivity
can be checked. Nothing is repaired: open edges, edges shared by more than two triangles, edges whose two
triangles wind the same way and zero-area triangles are reported where they are. Triangle numbers are the
file's own order (polygons are split into fans), so a picked triangle can be found in the source again.

The converter writes a JSON manifest and one little-endian binary file with every part's float32 positions,
uint32 triangles, outline edges and fault lists. Limits bound the work done, not peak memory; only open
trusted local files.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys

import numpy as np

FORMATS = {".stl": "stl", ".obj": "obj", ".3mf": "3mf", ".ply": "ply", ".glb": "glb"}
UNITS = {"um": 0.001, "mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "ft": 304.8}
UNIT_NAMES = {"um": "micrometres", "mm": "millimetres", "cm": "centimetres", "m": "metres", "in": "inches", "ft": "feet"}
DECLARED_UNITS = {
    "micron": "um", "micrometer": "um", "millimeter": "mm", "millimeters": "mm", "mm": "mm",
    "centimeter": "cm", "centimeters": "cm", "cm": "cm", "meter": "m", "meters": "m", "m": "m",
    "inch": "in", "inches": "in", "in": "in", "foot": "ft", "feet": "ft", "ft": "ft",
}
UP_AXES = ("z", "y")
MAX_INPUT_BYTES = 300 * 1024 * 1024
# Reading peaks at about 460 bytes per triangle for binary STL (about 1.9 GB at this cap) and 700 for OBJ.
MAX_TRIANGLES = 4_000_000
MAX_PARTS = 1_000
MAX_NODES = 10_000
MAX_OUTLINE_SEGMENTS = 250_000
# Exported CAD keeps sharp edges to a small share of all edges; a scan's noise makes them common everywhere.
MAX_OUTLINE_SHARE = 0.1
FEATURE_ANGLE_DEGREES = 30.0
# Print models are rarely under 2.5 mm across; scans saved in metres rarely exceed 2.5 m.
METRE_GUESS_EXTENT = 2.5
PALETTE = [[0.40, 0.46, 0.52], [0.62, 0.38, 0.20], [0.26, 0.45, 0.36], [0.42, 0.34, 0.56], [0.56, 0.50, 0.26]]
# Y-up to Z-up: +Y becomes +Z and glTF's front (+Z) becomes the Explorer's front (-Y).
Y_UP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])


class MeshError(ValueError):
    """The file cannot be read as a mesh reference."""


@dataclass
class SourcePart:
    label: str
    vertices: np.ndarray
    triangles: np.ndarray
    color: list[float] | None = None


@dataclass
class SourceNode:
    label: str
    part: int
    matrix: np.ndarray


@dataclass
class MeshPart:
    label: str
    positions: np.ndarray
    triangles: np.ndarray
    color: list[float]
    bounds: dict
    area: float
    volume: float | None
    closed: bool
    outlines: np.ndarray
    open_edges: np.ndarray
    overshared_edges: np.ndarray
    flipped_edges: np.ndarray
    degenerate_triangles: np.ndarray


@dataclass
class MeshDocument:
    name: str
    format: str
    sha256: str
    frame: dict
    parts: list[MeshPart]
    nodes: list[SourceNode]
    bounds: dict
    warnings: list[str] = field(default_factory=list)


def _srgb_to_linear(rgb) -> list[float]:
    srgb = np.clip(np.asarray(rgb, dtype=float)[:3] / 255.0, 0, 1)
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4).tolist()


def _read(path: Path) -> tuple[str, bytes]:
    fmt = FORMATS.get(path.suffix.lower())
    if fmt is None:
        raise MeshError(f"Choose an {', '.join(sorted(FORMATS))} file.")
    if not path.is_file():
        raise MeshError(f"Mesh file does not exist or is not a file: {path}")
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise MeshError("Mesh file exceeds the 300 MB limit.")
    data = path.read_bytes()
    if len(data) > MAX_INPUT_BYTES:
        raise MeshError("Mesh file exceeds the 300 MB limit.")
    if not data.strip():
        raise MeshError("Mesh file is empty.")
    return fmt, data


def _stl(data: bytes, stem: str) -> list[SourcePart]:
    if len(data) >= 84:
        count = int(np.frombuffer(data, "<u4", 1, 80)[0])
        if len(data) == 84 + 50 * count:
            record = np.dtype([("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
            corners = np.frombuffer(data, record, count, 84)["vertices"].reshape(-1, 3)
            return [SourcePart(stem, corners, np.arange(len(corners), dtype=np.int32).reshape(-1, 3))]
    text = data.decode("utf-8", errors="replace")
    if not re.match(r"\s*solid\b", text):
        raise MeshError("This STL is neither binary (its size does not match its triangle count) nor ASCII.")
    parts = []
    # Anchored to line starts, so a solid named "bracket_solid" ends where its own endsolid line is.
    for match in re.finditer(r"^[ \t]*solid[ \t]*([^\r\n]*)(.*?)^[ \t]*endsolid", text, re.S | re.M):
        numbers = re.findall(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", match.group(2))
        if not numbers:
            continue
        try:
            corners = np.asarray(numbers, dtype=np.float64)
        except ValueError as error:
            raise MeshError("ASCII STL contains a vertex that is not a number.") from error
        if len(corners) % 3:
            raise MeshError("ASCII STL has a facet without exactly three vertices.")
        parts.append(SourcePart(match.group(1).strip() or stem, corners, np.arange(len(corners), dtype=np.int32).reshape(-1, 3)))
    if not parts:
        raise MeshError("ASCII STL contains no facets.")
    return parts


def _numbers(text: str, dtype) -> np.ndarray:
    """Whitespace-separated numbers, parsed in C. A malformed token gives an empty result, which callers detect by count."""
    try:
        return np.fromstring(text, dtype=dtype, sep=" ")
    except ValueError:
        return np.empty(0, dtype)


def _obj(data: bytes, stem: str) -> list[SourcePart]:
    vertices: list[str] = []
    objects: list[tuple[str, list[str], list[int]]] = []
    splitter = "o" if re.search(rb"(?m)^o[ \t]", data) else "g"
    current = (stem, [], [])
    # Lines are read one at a time and numbers parsed in bulk, so a million faces cost arrays, not string lists.
    for line in io.StringIO(data.decode("utf-8", errors="replace")):
        if "#" in line:
            line = line.split("#", 1)[0]
        if line[:1] in (" ", "\t"):
            line = line.lstrip()
        if len(line) < 2 or line[1] not in " \t":
            continue
        kind = line[0]
        if kind == "v":
            vertices.append(line[2:].strip())
        elif kind == "f":
            current[1].append(line[2:].strip())
            current[2].append(len(vertices))
        elif kind == splitter:
            if current[1]:
                objects.append(current)
            current = (line[2:].strip() or stem, [], [])
    if current[1]:
        objects.append(current)
    if not vertices or not objects:
        raise MeshError("OBJ file contains no vertices or faces.")
    width = len(vertices[0].split())
    flat = _numbers(" ".join(vertices), np.float64)
    if width >= 3 and flat.size == width * len(vertices):
        points = flat.reshape(-1, width)[:, :3].copy()
    else:
        # Rows of different widths (optional w or colours): parse each row's first three numbers.
        try:
            points = np.asarray([row.split()[:3] for row in vertices], dtype=np.float64)
        except ValueError as error:
            raise MeshError("OBJ file contains a vertex that is not three numbers.") from error
        if points.ndim != 2 or points.shape[1] != 3:
            raise MeshError("OBJ file contains a vertex that is not three numbers.")
    del vertices, flat
    parts = []
    for name, faces, defined in objects:
        counts = np.fromiter((len(face.split()) for face in faces), dtype=np.int64, count=len(faces))
        if counts.min() < 3:
            raise MeshError(f"OBJ object {name!r} has a face with fewer than three vertices.")
        text = " ".join(faces)
        if "/" in text:
            text = re.sub(r"/\S*", "", text)
        index = _numbers(text, np.int64)
        if index.size != counts.sum():
            raise MeshError(f"OBJ object {name!r} has a face index that is not a whole number.")
        # Negative indices count back from the vertices defined so far.
        available = np.repeat(np.asarray(defined, dtype=np.int64), counts)
        index = np.where(index < 0, available + index, index - 1)
        if index.min() < 0 or index.max() >= len(points):
            raise MeshError(f"OBJ object {name!r} refers to a vertex that does not exist.")
        starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
        # Fan each polygon from its first corner, keeping polygons in file order.
        fans = np.repeat(starts, counts - 2)
        steps = np.arange(int((counts - 2).sum())) - np.repeat(np.cumsum(counts - 2) - (counts - 2), counts - 2)
        triangles = np.stack([index[fans], index[fans + steps + 1], index[fans + steps + 2]], axis=1)
        used = np.unique(triangles)
        remap = np.full(len(points), -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        parts.append(SourcePart(name, points[used], remap[triangles]))
    return parts


def _visual_color(geometry) -> list[float] | None:
    try:
        visual = geometry.visual
        if visual.kind in ("face", "vertex"):
            return _srgb_to_linear(visual.main_color)
        material = getattr(visual, "material", None)
        color = getattr(material, "main_color", None)
        return None if color is None else _srgb_to_linear(color)
    except Exception:  # Colors are cosmetic; an unusual visual must not block the geometry.
        return None


def _scene(data: bytes, fmt: str, stem: str, warnings: list[str]) -> tuple[list[SourcePart], list[SourceNode], str | None]:
    import trimesh

    try:
        scene = trimesh.load(io.BytesIO(data), file_type=fmt, force="scene", process=False)
    except Exception as error:
        raise MeshError(f"Could not read the {fmt.upper()} file: {error}") from error
    parts: list[SourcePart] = []
    nodes: list[SourceNode] = []
    definitions: dict[str, int] = {}
    for node in scene.graph.nodes_geometry:
        matrix, name = scene.graph[node]
        geometry = scene.geometry[name]
        if not isinstance(geometry, trimesh.Trimesh):
            if "Points and lines are not shown." not in warnings:
                warnings.append("Points and lines are not shown.")
            continue
        if name not in definitions:
            label = stem if fmt == "ply" or name == "geometry_0" else name
            definitions[name] = len(parts)
            parts.append(SourcePart(label, np.asarray(geometry.vertices, dtype=np.float64),
                                    np.asarray(geometry.faces, dtype=np.int64), _visual_color(geometry)))
        nodes.append(SourceNode(stem if fmt == "ply" else str(node), definitions[name], np.asarray(matrix, dtype=np.float64)))
    return parts, nodes, scene.units


def _frame(fmt: str, declared: str | None, extent: float, units: str, up: str) -> dict:
    if units != "auto":
        unit, source = units, "option"
        reason = "as requested"
    elif declared and declared.lower() in DECLARED_UNITS:
        unit, source = DECLARED_UNITS[declared.lower()], "file"
        reason = "declared by the file" if fmt != "glb" else "glTF files are in metres"
    elif fmt == "glb":
        unit, source, reason = "m", "format", "glTF files are in metres"
    elif extent < METRE_GUESS_EXTENT:
        unit, source = "m", "size"
        reason = f"guessed because the model is only {extent:.3g} units across"
    else:
        unit, source, reason = "mm", "default", "the usual unit for print files without declared units"
    if up != "auto":
        axis, up_source, up_reason = up, "option", "as requested"
    elif fmt in ("glb", "obj"):
        axis, up_source = "y", "format"
        up_reason = "glTF files are Y-up" if fmt == "glb" else "OBJ files from modelling and scanning apps are usually Y-up"
    else:
        axis, up_source, up_reason = "z", "default", "print files are Z-up"
    note = f"Read as {UNIT_NAMES[unit]} ({reason}) with {axis.upper()} up ({up_reason})."
    if source in ("size", "default") or up_source == "format":
        note += " Open it again with other units or another up axis if the size or orientation looks wrong."
    return {
        "units": unit, "unitsFrom": source, "scale": UNITS[unit],
        "up": axis, "upFrom": up_source, "sourceExtent": extent, "note": note,
    }


def _weld(positions: np.ndarray, triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    # Merge exactly equal float32 vertices only; near misses stay apart and show up as open edges.
    positions = np.ascontiguousarray(positions + np.float32(0))
    bits = positions.view(np.uint32).reshape(-1, 3)
    # Sorting one 64-bit hash is much faster than sorting 12-byte records; a stable sort keeps the first copy first.
    with np.errstate(over="ignore"):
        hashed = bits[:, 0].astype(np.uint64) * np.uint64(0x9E3779B97F4A7C15)
        hashed ^= bits[:, 1].astype(np.uint64) * np.uint64(0xC2B2AE3D27D4EB4F)
        hashed ^= bits[:, 2].astype(np.uint64) * np.uint64(0x165667B19E3779F9)
    order = np.argsort(hashed, kind="stable")
    ordered = bits[order]
    differs = np.any(ordered[1:] != ordered[:-1], axis=1)
    if np.any(differs & (hashed[order][1:] == hashed[order][:-1])):
        order = np.lexsort((bits[:, 2], bits[:, 1], bits[:, 0]))
        ordered = bits[order]
        differs = np.any(ordered[1:] != ordered[:-1], axis=1)
    del hashed, ordered
    starts = np.r_[True, differs]
    del differs
    group = np.cumsum(starts, dtype=np.int32) - 1
    first = order[starts]
    rank = np.argsort(np.argsort(first)).astype(np.int32)
    inverse = np.empty(len(positions), dtype=np.int32)
    inverse[order] = rank[group]
    del order, group, rank
    welded = inverse[triangles]
    used = np.zeros(len(first), dtype=bool)
    used[welded.ravel()] = True
    remap = np.cumsum(used) - 1
    return positions[np.sort(first)][used], remap[welded].astype(np.uint32)


def _analyse(label: str, positions: np.ndarray, triangles: np.ndarray, warnings: list[str]) -> dict:
    # Peak memory matters at millions of triangles: gather corners per column, keep edge work in 32 bits
    # except the 64-bit edge key, and free each array once it has been used.
    a, b, c = (positions[triangles[:, corner]].astype(np.float64) for corner in range(3))
    cross = np.cross(b - a, c - a)
    doubled = np.linalg.norm(cross, axis=1)
    signed_volume = float(np.einsum("ij,ij->", a, cross) / 6)
    del a, b, c
    extent = float(np.linalg.norm(positions.max(axis=0) - positions.min(axis=0))) or 1.0
    repeated = (triangles[:, 0] == triangles[:, 1]) | (triangles[:, 1] == triangles[:, 2]) | (triangles[:, 2] == triangles[:, 0])
    degenerate = repeated | (doubled <= 1e-12 * extent * extent)
    # A triangle with a repeated corner is a line or a point: it bounds nothing, so it takes no part in the edge
    # pairing (it would otherwise pair its one real edge with itself); it is still reported as zero-area.
    valid = np.flatnonzero(~repeated).astype(np.int32)
    kept = triangles[valid]
    start = kept.ravel()
    end = kept[:, [1, 2, 0]].ravel()
    del kept
    owner = np.repeat(valid, 3)
    forward = start < end
    low, high = np.minimum(start, end), np.maximum(start, end)
    del start, end
    key = low.astype(np.int64) * len(positions) + high
    order = np.argsort(key, kind="stable")
    key = key[order]
    starts = np.flatnonzero(np.r_[True, key[1:] != key[:-1]])
    del key
    counts = np.diff(np.r_[starts, len(order)])
    first = order[starts]
    pairs = np.stack([low[first], high[first]], axis=1).astype(np.uint32)
    del low, high, first
    open_edges = pairs[counts == 1]
    overshared = pairs[counts > 2]
    two = counts == 2
    side_a, side_b = order[starts[two]], order[starts[two] + 1]
    del order, starts
    same_way = forward[side_a] == forward[side_b]
    del forward
    flipped = pairs[two][same_way]
    # Only edges with exactly two triangles need their normals compared.
    face_a, face_b = owner[side_a], owner[side_b]
    del owner, side_a, side_b
    unit = lambda faces: cross[faces] / np.where(doubled[faces] > 0, doubled[faces], 1)[:, None]
    cosine = np.einsum("ij,ij->i", unit(face_a), unit(face_b))
    del cross, face_a, face_b
    sharp = ~same_way & (cosine < math.cos(math.radians(FEATURE_ANGLE_DEGREES)))
    outlines = np.concatenate([pairs[two][sharp], open_edges])
    if len(outlines) > min(MAX_OUTLINE_SEGMENTS, max(2_000, MAX_OUTLINE_SHARE * len(pairs))):
        # Outlining every sharp edge of a noisy surface would only speckle it.
        outlines = outlines[:0]
    closed = not len(open_edges) and not len(overshared) and not len(flipped) and len(triangles) > int(degenerate.sum())
    volume = signed_volume if closed else None
    if volume is not None and volume < 0:
        warnings.append(f"{label}: its triangles face inwards, so its volume is negative.")
    return {
        "area": float(doubled.sum() / 2), "volume": volume, "closed": closed,
        "outlines": outlines, "open_edges": open_edges, "overshared_edges": overshared, "flipped_edges": flipped,
        "degenerate_triangles": np.flatnonzero(degenerate).astype(np.uint32),
    }


def _bounds(points: np.ndarray) -> dict:
    if not len(points) or not np.isfinite(points).all():
        raise MeshError("Mesh has empty or non-finite bounds.")
    return {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()}


def _corners(bounds: dict) -> np.ndarray:
    return np.array([[x, y, z] for x in (bounds["min"][0], bounds["max"][0])
                     for y in (bounds["min"][1], bounds["max"][1]) for z in (bounds["min"][2], bounds["max"][2])])


def load(path: str | Path, units: str = "auto", up: str = "auto", name: str | None = None) -> MeshDocument:
    """Read a mesh file into millimetres, Z up, with welded vertices and its faults measured.

    name is the file's own name when path is a renamed copy; unnamed parts are called after it.
    """
    if units != "auto" and units not in UNITS:
        raise MeshError(f"Units must be auto or one of {', '.join(UNITS)}.")
    if up != "auto" and up not in UP_AXES:
        raise MeshError("Up must be auto, z or y.")
    path = Path(path)
    fmt, data = _read(path)
    sha256 = hashlib.sha256(data).hexdigest()
    name = name or path.name
    stem = Path(name).stem
    warnings: list[str] = []
    declared = None
    if fmt == "stl":
        parts = _stl(data, stem)
        nodes = [SourceNode(part.label, index, np.eye(4)) for index, part in enumerate(parts)]
    elif fmt == "obj":
        parts = _obj(data, stem)
        nodes = [SourceNode(part.label, index, np.eye(4)) for index, part in enumerate(parts)]
    else:
        parts, nodes, declared = _scene(data, fmt, stem, warnings)
    # Binary STL vertices are views of the file's bytes; those go once each part has been converted.
    del data
    if not parts or not nodes:
        raise MeshError("The file contains no triangles.")
    if len(parts) > MAX_PARTS or len(nodes) > MAX_NODES:
        raise MeshError("The file has more parts or placements than the viewer supports.")
    if sum(len(part.triangles) for part in parts) > MAX_TRIANGLES:
        raise MeshError(f"The file has more than {MAX_TRIANGLES:,} triangles.")
    for part in parts:
        if not len(part.triangles) or not np.isfinite(part.vertices).all():
            raise MeshError(f"{part.label}: no triangles, or a vertex that is not a finite number.")
    world = np.concatenate([_corners(_bounds(parts[node.part].vertices)) @ node.matrix[:3, :3].T + node.matrix[:3, 3] for node in nodes])
    extent = float((world.max(axis=0) - world.min(axis=0)).max())
    frame = _frame(fmt, declared, extent, units, up)
    rotation = Y_UP if frame["up"] == "y" else np.eye(3)
    scale = frame["scale"]
    transform = np.eye(4)
    transform[:3, :3] = rotation * scale
    inverse = np.linalg.inv(transform)

    mesh_parts = []
    for index, part in enumerate(parts):
        unchanged = scale == 1 and frame["up"] == "z"
        positions = part.vertices.astype(np.float32) if unchanged else ((part.vertices * scale) @ rotation.T).astype(np.float32)
        if not np.isfinite(positions).all():
            raise MeshError(f"{part.label}: coordinates overflow after unit conversion.")
        positions, triangles = _weld(positions, part.triangles)
        part.vertices = part.triangles = None
        facts = _analyse(part.label, positions, triangles, warnings)
        mesh_parts.append(MeshPart(
            label=part.label, positions=positions, triangles=triangles,
            color=part.color or PALETTE[index % len(PALETTE)], bounds=_bounds(positions), **facts,
        ))
    placed = []
    corners = []
    for node in nodes:
        matrix = transform @ node.matrix @ inverse
        if not np.isfinite(matrix).all() or abs(np.linalg.det(matrix[:3, :3])) < 1e-12:
            raise MeshError(f"{node.label}: its placement is not a finite, invertible transform.")
        placed.append(SourceNode(node.label, node.part, matrix))
        corners.append(_corners(mesh_parts[node.part].bounds) @ matrix[:3, :3].T + matrix[:3, 3])
    return MeshDocument(
        name=name, format=fmt, sha256=sha256, frame=frame,
        parts=mesh_parts, nodes=placed, bounds=_bounds(np.concatenate(corners)), warnings=warnings,
    )


BUFFERS = ("positions", "indices", "outlines", "openEdges", "oversharedEdges", "flippedEdges", "degenerateTriangles")


def write(document: MeshDocument, output_dir: Path) -> None:
    """Write model.json and geometry.bin for the Explorer; both are complete before either is used."""
    chunks: list[bytes] = []
    offset = 0
    parts = []
    for index, part in enumerate(document.parts):
        arrays = dict(zip(BUFFERS, (
            part.positions.astype("<f4"), part.triangles.astype("<u4"), part.outlines.astype("<u4"),
            part.open_edges.astype("<u4"), part.overshared_edges.astype("<u4"), part.flipped_edges.astype("<u4"),
            part.degenerate_triangles.astype("<u4"),
        )))
        buffers = {}
        for name, array in arrays.items():
            raw = np.ascontiguousarray(array).ravel().tobytes()
            buffers[name] = {"offset": offset, "count": int(array.size)}
            chunks.append(raw)
            offset += len(raw)
        parts.append({
            "id": f"mesh:{index + 1}", "label": part.label, "color": [float(value) for value in part.color],
            "bounds": part.bounds, "vertexCount": int(len(part.positions)), "triangleCount": int(len(part.triangles)),
            "area": part.area, "volume": part.volume, "closed": part.closed, "sectionCaps": part.closed,
            "faults": {
                "openEdges": int(len(part.open_edges)), "oversharedEdges": int(len(part.overshared_edges)),
                "flippedEdges": int(len(part.flipped_edges)), "degenerateTriangles": int(len(part.degenerate_triangles)),
            },
            "buffers": buffers, "faces": [],
        })
    geometry = b"".join(chunks)
    manifest = {
        "schemaVersion": 2, "kind": "mesh",
        "source": {"name": document.name, "sha256": document.sha256, "format": document.format},
        "units": "mm", "frame": document.frame,
        "geometry": {"bytes": len(geometry), "sha256": hashlib.sha256(geometry).hexdigest()},
        "parts": parts,
        "nodes": [{
            "id": f"node:{index + 1}", "label": node.label, "parentId": None, "partId": f"mesh:{node.part + 1}",
            "matrix": node.matrix.ravel(order="F").tolist(), "color": parts[node.part]["color"],
        } for index, node in enumerate(document.nodes)],
        "bounds": document.bounds, "warnings": document.warnings,
    }
    payload = json.dumps(manifest, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "geometry.bin").write_bytes(geometry)
    (output_dir / "model.json").write_bytes(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("input", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--units", default="auto", choices=["auto", *UNITS])
    parser.add_argument("--up", default="auto", choices=["auto", *UP_AXES])
    parser.add_argument("--name", help="the file's own name, when the input is a renamed copy")
    args = parser.parse_args(argv)
    try:
        write(load(args.input, args.units, args.up, args.name), args.output_dir)
    except (OSError, ValueError, MemoryError) as error:
        print(f"Mesh import failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
