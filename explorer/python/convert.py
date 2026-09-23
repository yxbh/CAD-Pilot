"""Disposable native STEP preview converter, independent of imported CAD tooling.

Meshes retain the source's Z-up frame and use millimeters. Colors are linear RGB.
The JSON maps render triangles to CAD faces and ordered polylines to native CAD
edges, not editable design history.
Limits bound exported data, not the native reader's peak memory or execution time;
the caller should impose a process timeout and only open trusted local models.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher, Sequence_TDF_Label
from OCP.GProp import GProp_GProps
from OCP.GCPnts import GCPnts_AbscissaPoint, GCPnts_TangentialDeflection
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_ColorRGBA, Quantity_TOC_RGB
from OCP.Standard import Standard_Failure
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_Tool
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Trsf
from OCP.XCAFDoc import (
    XCAFDoc_ColorGen,
    XCAFDoc_ColorSurf,
    XCAFDoc_ColorTool,
    XCAFDoc_DocumentTool,
    XCAFDoc_ShapeTool,
)

MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_OUTPUT_BYTES = 128 * 1024 * 1024
MAX_ENTITIES = 1_000_000
MAX_VERTICES = 600_000
MAX_TRIANGLES = 1_000_000
MAX_FACES = 100_000
MAX_EDGES = 200_000
MAX_EDGE_POINTS = 1_000_000
MAX_NODES = 20_000
MAX_PARTS = 10_000
MAX_DEPTH = 64
MAX_WARNINGS = 100
DEFAULT_COLOR = [0.65, 0.69, 0.75]
LINEAR_DEFLECTION_MM = 0.15
ANGULAR_DEFLECTION_RADIANS = 0.35


class ConversionError(ValueError):
    """Input or geometry cannot be represented faithfully enough for this preview."""


class WarningLog:
    def __init__(self) -> None:
        self.items: list[str] = []
        # Counts cover reusable part geometry, not repeated assembly placements.
        self.cleanup = {"degenerateEdges": 0, "zeroAreaTriangles": 0}

    def add(self, message: str) -> None:
        if message not in self.items:
            if len(self.items) >= MAX_WARNINGS:
                raise ConversionError("Too many conversion warnings; refusing partial preview.")
            self.items.append(message)


def _entry(label: TDF_Label) -> str:
    value = TCollection_AsciiString()
    TDF_Tool.Entry_s(label, value)
    return value.ToCString()


def _name(label: TDF_Label) -> str | None:
    attribute = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
        text = attribute.Get().ToExtString().strip()
        if text and not text.startswith(("=>[", "Open CASCADE STEP translator")) and text.upper() not in {
            "SOLID", "SHELL", "COMPOUND", "ASSEMBLY", "SHAPE",
        }:
            return text
    return None


def _labels(sequence: Sequence_TDF_Label):
    for index in range(1, sequence.Length() + 1):
        yield sequence.Value(index)


def _diagnostics(checks, warnings: WarningLog, phase: str) -> None:
    checks.Start()
    while checks.More():
        check = checks.Value()
        if check.NbFails():
            raise ConversionError(f"STEP {phase} failed: {check.CFail(1)}")
        for index in range(1, check.NbWarnings() + 1):
            warnings.add(f"STEP {phase}: {check.CWarning(index)}")
        checks.Next()


def _read_bytes(path: Path) -> bytes:
    if path.suffix.lower() not in {".step", ".stp"}:
        raise ConversionError("Input must be an ordinary .step or .stp file.")
    if not path.is_file():
        raise ConversionError(f"Input STEP file does not exist or is not a file: {path}")
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ConversionError("Input exceeds the 100 MB STEP size limit.")
    with path.open("rb") as stream:
        data = stream.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ConversionError("Input exceeds the 100 MB STEP size limit.")
    if not data.strip():
        raise ConversionError("Input STEP file is empty.")
    # Mask strings/comments before inspecting Part 21 control sections.
    syntax = re.sub(rb"'(?:[^']|'')*'|/\*.*?\*/", b" ", data, flags=re.DOTALL)
    if not re.match(rb"\s*ISO-10303-21\s*;", syntax, flags=re.IGNORECASE):
        raise ConversionError("Input is not an ordinary ISO-10303-21 STEP file.")
    if not re.search(rb"END-ISO-10303-21\s*;\s*$", syntax, flags=re.IGNORECASE):
        raise ConversionError("STEP file is truncated or has unsupported trailing content.")
    if re.search(rb"\b(?:REFERENCE|ANCHOR)\s*;", syntax, flags=re.IGNORECASE):
        raise ConversionError("External references / Part 21 reference sections are unsupported.")
    return data


def _read_document(data: bytes, warnings: WarningLog):
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetSHUOMode(True)
    reader.SetGDTMode(False)
    reader.SetViewMode(False)
    reader.SetLayerMode(False)
    reader.SetMatMode(False)
    # Read the exact hashed bytes, not a second read of a potentially changed file.
    # No transfer (and hence no external-file resolution) happens before preflight.
    if reader.ReadStream("model.step", io.BytesIO(data)) != IFSelect_RetDone:
        raise ConversionError("Native STEP reader rejected the input.")
    basic = reader.ChangeReader()
    model = basic.Model()
    if model is None or not model.NbEntities():
        raise ConversionError("STEP file contains no entities.")
    if model.NbEntities() > MAX_ENTITIES:
        raise ConversionError("STEP entity limit exceeded.")
    _diagnostics(basic.WS().ModelCheckList(True), warnings, "parse")
    for index in range(1, model.NbEntities() + 1):
        kind = model.Value(index).DynamicType().Name()
        if any(token in kind for token in (
            "Document", "ExternalSource", "ExternallyDefined",
            "ExternalIdentification", "ExternalReference",
        )):
            raise ConversionError(
                f"External references/document associations are unsupported ({kind}); "
                "export a self-contained STEP file."
            )
    document = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 0.001)
    basic.SetSystemLengthUnit(1.0)
    if not reader.Transfer(document):
        raise ConversionError("Native STEP transfer failed.")
    process = basic.WS().TransferReader().TransientProcess()
    if process is not None:
        _diagnostics(process.CheckList(False), warnings, "transfer")
    return document


def _color(label: TDF_Label, warnings: WarningLog) -> list[float] | None:
    for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
        rgba = Quantity_ColorRGBA()
        if XCAFDoc_ColorTool.GetColor_s(label, kind, rgba):
            if rgba.Alpha() < 1.0:
                warnings.add("Transparency is unsupported; transparent parts are shown opaque.")
            return list(rgba.GetRGB().Values(Quantity_TOC_RGB))
    return None


def _part_color(label: TDF_Label, warnings: WarningLog) -> list[float] | None:
    direct = _color(label, warnings)
    subs = Sequence_TDF_Label()
    XCAFDoc_ShapeTool.GetSubShapes_s(label, subs)
    colors = []
    for sub in _labels(subs):
        value = _color(sub, warnings)
        if value is not None and value not in colors:
            colors.append(value)
    if len(colors) > 1 or (direct is not None and any(c != direct for c in colors)):
        warnings.add(
            "Per-face/subshape colors are unsupported; affected parts use a single RGB color."
        )
    return direct if direct is not None else (colors[0] if len(colors) == 1 else None)


def _matrix(location: TopLoc_Location) -> np.ndarray:
    transform = location.Transformation()
    result = np.eye(4)
    for row in range(3):
        for col in range(4):
            result[row, col] = transform.Value(row + 1, col + 1)
    if not np.isfinite(result).all():
        raise ConversionError("Non-finite occurrence transform.")
    return result


def _bounds(points: np.ndarray) -> dict:
    if not len(points) or not np.isfinite(points).all():
        raise ConversionError("Empty or non-finite geometry bounds.")
    return {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()}


def _corners(bounds: dict) -> np.ndarray:
    return np.array([
        [x, y, z] for x in (bounds["min"][0], bounds["max"][0])
        for y in (bounds["min"][1], bounds["max"][1])
        for z in (bounds["min"][2], bounds["max"][2])
    ])


def _box_extent(box: Bnd_Box) -> tuple[float, ...]:
    return (*box.CornerMin().Coord(), *box.CornerMax().Coord())


def _edges(shape, budget: dict, warnings: WarningLog) -> list[dict]:
    # An indexed native map deduplicates shared/seam edges by topology and location,
    # not by coincident coordinates or a triangulation's artificial diagonals.
    edges = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, edges)
    budget["edges"] += edges.Extent()
    if budget["edges"] > MAX_EDGES:
        raise ConversionError("CAD edge limit exceeded.")
    records = []
    for index in range(1, edges.Extent() + 1):
        edge = TopoDS.Edge(edges.FindKey(index))
        edge_id = f"e{index}"
        if BRep_Tool.Degenerated_s(edge):
            vertices = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
            TopExp.MapShapes_s(edge, TopAbs_VERTEX, vertices)
            points = np.asarray([
                BRep_Tool.Pnt_s(TopoDS.Vertex(vertices.FindKey(i))).Coord()
                for i in range(1, vertices.Extent() + 1)
            ])
            if not len(points) or not np.isfinite(points).all() or np.any(points != points[0]):
                raise ConversionError(f"Degenerate CAD edge {edge_id} is not a finite point.")
            warnings.cleanup["degenerateEdges"] += 1
            continue
        curve = BRepAdaptor_Curve(edge)
        if not all(map(math.isfinite, (curve.FirstParameter(), curve.LastParameter()))):
            raise ConversionError(f"CAD edge {edge_id} has an unbounded curve.")
        properties = GProp_GProps()
        BRepGProp.LinearProperties_s(edge, properties, False, False)
        # Fixed-order mass integration is noticeably inaccurate for some splines;
        # measure the native curve with an explicit adaptive length tolerance.
        length = GCPnts_AbscissaPoint.Length_s(curve, 1e-7)
        center = list(properties.CentreOfMass().Coord())
        if not math.isfinite(length) or length < 0 or not all(map(math.isfinite, center)):
            raise ConversionError(f"CAD edge {edge_id} has invalid native curve properties.")
        if length == 0:
            warnings.add(f"Zero-length CAD edge {edge_id} was omitted from edge selection.")
            continue
        samples = GCPnts_TangentialDeflection(
            curve, ANGULAR_DEFLECTION_RADIANS, LINEAR_DEFLECTION_MM
        )
        budget["edgePoints"] += samples.NbPoints()
        if budget["edgePoints"] > MAX_EDGE_POINTS:
            raise ConversionError("CAD edge point limit exceeded.")
        points = np.asarray([samples.Value(i).Coord() for i in range(1, samples.NbPoints() + 1)])
        if len(points) < 2 or not np.isfinite(points).all() or not np.any(points[1:] != points[0]):
            raise ConversionError(f"CAD edge {edge_id} could not be sampled; refusing partial preview.")
        if edge.Orientation() == TopAbs_REVERSED:
            points = points[::-1]
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(edge, box, False, True)
        if box.IsVoid() or box.IsOpen():
            raise ConversionError(f"CAD edge {edge_id} has unbounded native geometry.")
        extent = _box_extent(box)
        if not all(map(math.isfinite, extent)):
            raise ConversionError(f"CAD edge {edge_id} has non-finite native bounds.")
        records.append({
            "id": edge_id, "positions": points.ravel().tolist(),
            "curveType": str(curve.GetType()).split(".")[-1].removeprefix("GeomAbs_").lower(),
            "length": length, "center": center,
            "bounds": {"min": list(extent[:3]), "max": list(extent[3:])},
        })
    return records


def _mesh(shape, budget: dict, warnings: WarningLog) -> dict:
    if shape.IsNull() or not BRepCheck_Analyzer(shape).IsValid():
        raise ConversionError("Part contains null or invalid native geometry.")
    mesher = BRepMesh_IncrementalMesh(
        shape, LINEAR_DEFLECTION_MM, False, ANGULAR_DEFLECTION_RADIANS, False
    )
    if not mesher.IsDone() or mesher.GetStatusFlags():
        raise ConversionError(f"Part tessellation failed (status {mesher.GetStatusFlags()}).")
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    face_records: list[dict] = []
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    while faces.More():
        budget["faces"] += 1
        if budget["faces"] > MAX_FACES:
            raise ConversionError("Face limit exceeded.")
        face = TopoDS.Face(faces.Current())
        location = TopLoc_Location()
        mesh = BRep_Tool.Triangulation_s(face, location)
        if mesh is None or mesh.NbNodes() == 0 or mesh.NbTriangles() == 0:
            raise ConversionError("A face could not be tessellated; refusing partial preview.")
        budget["vertices"] += mesh.NbNodes()
        budget["triangles"] += mesh.NbTriangles()
        if budget["vertices"] > MAX_VERTICES or budget["triangles"] > MAX_TRIANGLES:
            raise ConversionError("Preview vertex/triangle limit exceeded.")
        if not mesh.HasNormals():
            mesh.ComputeNormals()
        transform = _matrix(location)
        points = np.array([mesh.Node(i).Coord() for i in range(1, mesh.NbNodes() + 1)])
        directions = np.array([mesh.Normal(i).Coord() for i in range(1, mesh.NbNodes() + 1)])
        points = points @ transform[:3, :3].T + transform[:3, 3]
        directions = directions @ np.linalg.inv(transform[:3, :3])
        reversed_face = face.Orientation() == TopAbs_REVERSED
        if reversed_face:
            directions *= -1
        lengths = np.linalg.norm(directions, axis=1)
        if not np.isfinite(points).all() or not np.isfinite(lengths).all() or np.any(lengths == 0):
            raise ConversionError("Tessellation contains non-finite positions or invalid normals.")
        directions /= lengths[:, None]
        offset = len(positions) // 3
        positions.extend(points.ravel().tolist())
        normals.extend(directions.ravel().tolist())
        reverse_winding = reversed_face != (np.linalg.det(transform[:3, :3]) < 0)
        triangles = np.array([
            mesh.Triangle(index).Get() for index in range(1, mesh.NbTriangles() + 1)
        ], dtype=np.int64) - 1
        if triangles.min() < 0 or triangles.max() >= mesh.NbNodes():
            raise ConversionError("Tessellation contains out-of-range triangle indices.")
        if reverse_winding:
            triangles = triangles[:, [0, 2, 1]]
        areas = np.linalg.norm(
            np.cross(points[triangles[:, 1]] - points[triangles[:, 0]],
                     points[triangles[:, 2]] - points[triangles[:, 0]]),
            axis=1,
        )
        if not np.isfinite(areas).all():
            raise ConversionError("Tessellation contains non-finite triangle areas.")
        if np.any(areas == 0):
            # Native sphere/cone pole meshes can contain collapsed triangles.
            warnings.cleanup["zeroAreaTriangles"] += int(np.count_nonzero(areas == 0))
            triangles = triangles[areas > 0]
        if not len(triangles):
            raise ConversionError("A face has no non-degenerate triangles; refusing partial preview.")
        properties = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, properties)
        area = properties.Mass()
        centroid = list(properties.CentreOfMass().Coord())
        if not math.isfinite(area) or area <= 0 or not all(math.isfinite(value) for value in centroid):
            raise ConversionError("A face has invalid native surface properties.")
        face_box = Bnd_Box()
        BRepBndLib.AddOptimal_s(face, face_box, False, True)
        if face_box.IsVoid() or face_box.IsOpen():
            raise ConversionError("A face has unbounded native geometry.")
        extent = _box_extent(face_box)
        face_bounds = {"min": list(extent[:3]), "max": list(extent[3:])}
        if not all(math.isfinite(value) for value in extent):
            raise ConversionError("A face has non-finite native geometry bounds.")
        face_records.append({
            "id": f"f{len(face_records) + 1}",
            "triangleStart": len(indices) // 3,
            "triangleCount": len(triangles),
            "surfaceType": str(BRepAdaptor_Surface(face).GetType()).split(".")[-1].removeprefix("GeomAbs_").lower(),
            "area": area,
            "center": centroid,
            "bounds": face_bounds,
        })
        indices.extend((triangles + offset).ravel().tolist())
        faces.Next()
    if not indices:
        raise ConversionError("Part has no tessellatable faces; wire/point-only STEP is unsupported.")
    if TopExp_Explorer(shape, TopAbs_VERTEX, TopAbs_EDGE).More():
        warnings.add("Standalone points are unsupported and are not drawn.")
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, True)
    if box.IsVoid() or box.IsOpen():
        raise ConversionError("Part has empty or unbounded native geometry.")
    bounds = _bounds(np.asarray(positions).reshape(-1, 3))
    native = _box_extent(box)
    bounds["min"] = [min(bounds["min"][i], native[i]) for i in range(3)]
    bounds["max"] = [max(bounds["max"][i], native[i + 3]) for i in range(3)]
    if not all(math.isfinite(v) for v in bounds["min"] + bounds["max"]):
        raise ConversionError("Part has non-finite native geometry bounds.")
    # Display caps are only meaningful when every face bounds a native solid; loose faces or shells stay uncapped.
    all_faces = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    solid_faces = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    solids = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, TopAbs_FACE, all_faces)
    TopExp.MapShapes_s(shape, TopAbs_SOLID, solids)
    for index in range(1, solids.Extent() + 1):
        TopExp.MapShapes_s(solids.FindKey(index), TopAbs_FACE, solid_faces)
    section_caps = solids.Extent() > 0 and solid_faces.Extent() == all_faces.Extent()
    return {"positions": positions, "normals": normals, "indices": indices, "bounds": bounds,
            "faces": face_records, "edges": _edges(shape, budget, warnings),
            "sectionCaps": section_caps}


def convert_step(input_path: str | Path) -> dict:
    """Read a self-contained STEP into the schemaVersion=2 face/edge-mapped contract."""
    path = Path(input_path)
    data = _read_bytes(path)
    warnings = WarningLog()
    document = _read_document(data, warnings)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    roots = Sequence_TDF_Label()
    shapes.GetFreeShapes(roots)
    if not roots.Length():
        raise ConversionError("STEP transfer produced no root parts or assemblies.")
    parts: dict[str, dict] = {}
    nodes = []
    world_corners = []
    budget = {"vertices": 0, "triangles": 0, "faces": 0, "edges": 0, "edgePoints": 0}

    def visit(label, parent_id, parent_world, inherited_color, ancestry, path_id):
        if len(nodes) >= MAX_NODES or len(ancestry) > MAX_DEPTH:
            raise ConversionError("Assembly node/depth limit exceeded.")
        definition = TDF_Label()
        is_reference = shapes.GetReferredShape_s(label, definition)
        if not is_reference:
            definition = label
        key = _entry(definition)
        if key in ancestry:
            raise ConversionError("Cyclic assembly references are unsupported.")
        definition_shape = shapes.GetShape_s(definition)
        if definition_shape.IsNull():
            raise ConversionError("Assembly contains an empty or unresolved component.")
        # Component placement is relative to its parent; the definition's own
        # location belongs here too, never baked into the reusable mesh.
        location = shapes.GetLocation_s(label)
        if is_reference:
            location = location.Multiplied(definition_shape.Location())
        local = _matrix(location)
        world = parent_world @ local
        node_id = f"node:{path_id}"
        assembly = shapes.IsAssembly_s(definition)
        label_text = _name(label) or _name(definition)
        if not label_text:
            label_text = path.stem if parent_id is None else (
                f"Assembly {len(nodes) + 1}" if assembly else f"Part {len(parts) + 1}"
            )
        own_color = _color(label, warnings)
        definition_color = _part_color(definition, warnings) if not assembly else _color(definition, warnings)
        color = own_color or definition_color or inherited_color or DEFAULT_COLOR.copy()
        instance_transform = gp_Trsf()
        instance_transform.SetValues(*world[:3, :].ravel().tolist())
        world_shape = definition_shape.Located(TopLoc_Location(instance_transform))
        for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
            instance_rgba = Quantity_ColorRGBA()
            if colors.GetInstanceColor(world_shape, kind, instance_rgba):
                color = list(instance_rgba.GetRGB().Values(Quantity_TOC_RGB))
                if instance_rgba.Alpha() < 1:
                    warnings.add("Transparency is unsupported; transparent parts are shown opaque.")
                break
        if not colors.IsVisible_s(label) or not colors.IsVisible_s(definition):
            warnings.add("STEP visibility flags are unsupported; hidden parts are shown.")
        part_id = None
        if not assembly:
            part_id = f"part:{key}"
            if part_id not in parts:
                if len(parts) >= MAX_PARTS:
                    raise ConversionError("Reusable part limit exceeded.")
                parts[part_id] = {
                    "id": part_id,
                    "label": _name(definition) or label_text,
                    "color": definition_color or DEFAULT_COLOR.copy(),
                    **_mesh(definition_shape.Located(TopLoc_Location()), budget, warnings),
                }
            transformed = _corners(parts[part_id]["bounds"]) @ world[:3, :3].T + world[:3, 3]
            world_corners.extend(transformed.tolist())
        nodes.append({
            "id": node_id, "label": label_text, "parentId": parent_id,
            "partId": part_id, "matrix": local.ravel(order="F").tolist(), "color": color,
        })
        if assembly:
            children = Sequence_TDF_Label()
            shapes.GetComponents_s(definition, children, False)
            if not children.Length():
                raise ConversionError("Assembly contains no components.")
            for child in _labels(children):
                visit(child, node_id, world, color, ancestry + (key,), f"{path_id}/{_entry(child)}")

    for root in _labels(roots):
        visit(root, None, np.eye(4), None, (), _entry(root))
    if not parts:
        raise ConversionError("STEP contains no drawable parts.")
    return {
        "schemaVersion": 2,
        "source": {"name": path.name, "sha256": hashlib.sha256(data).hexdigest()},
        "units": "mm",
        "parts": list(parts.values()),
        "nodes": nodes,
        "bounds": _bounds(np.asarray(world_corners)),
        "warnings": warnings.items,
        "cleanup": warnings.cleanup,
    }


def write_json(model: dict, output: Path) -> None:
    """Serialize fully before touching the explicit destination."""
    payload = json.dumps(model, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
    if len(payload) > MAX_OUTPUT_BYTES:
        raise ConversionError("Preview exceeds the 128 MB JSON output limit.")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if (args.input.resolve() == args.output.resolve()
                or (args.output.exists() and args.input.exists() and args.input.samefile(args.output))):
            raise ConversionError("Output must not overwrite the input STEP file.")
        model = convert_step(args.input)
        write_json(model, args.output)
    except (OSError, RuntimeError, ValueError, Standard_Failure) as error:
        print(f"STEP conversion failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
