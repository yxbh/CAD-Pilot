"""Native STEP contract checks; fixtures and subprocess outputs stay disposable."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import numpy as np
import pytest
from OCP.Bnd import Bnd_Box
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
from OCP.collections import Array1_gp_Pnt, IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher
from OCP.IFSelect import IFSelect_RetDone
from OCP.Geom import Geom_BezierCurve
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.Standard import Standard_Failure
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

PYTHON_DIR = Path(__file__).resolve().parents[1] / "python"


def _module(name):
    spec = importlib.util.spec_from_file_location(f"prototype_{name}", PYTHON_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


converter = _module("convert")
demo = _module("create_demo")


def test_native_box_extent_includes_tolerance_gap():
    box = Bnd_Box()
    box.Update(1, 2, 3, 4, 5, 6)
    box.SetGap(0.25)
    assert converter._box_extent(box) == pytest.approx((0.75, 1.75, 2.75, 4.25, 5.25, 6.25))


@pytest.fixture
def workdir():
    with tempfile.TemporaryDirectory(prefix="converter-test-", dir=PYTHON_DIR) as folder:
        yield Path(folder)


def _name(label, text):
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(text))


def _location(x=0, y=0, z=0, angle=0):
    transform = gp_Trsf()
    transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), angle)
    transform.SetTranslationPart(gp_Vec(x, y, z))
    return TopLoc_Location(transform)


def _document():
    document = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 0.001)
    return (
        document,
        XCAFDoc_DocumentTool.ShapeTool_s(document.Main()),
        XCAFDoc_DocumentTool.ColorTool_s(document.Main()),
    )


def _write_document(document, path):
    XCAFDoc_DocumentTool.ShapeTool_s(document.Main()).UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    assert writer.Transfer(document)
    assert writer.Write(str(path)) == IFSelect_RetDone


def _write_direct(path, shape=None):
    if shape is None:
        shape = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
    writer = STEPControl_Writer()
    assert writer.Transfer(shape, STEPControl_AsIs) == IFSelect_RetDone
    assert writer.Write(str(path)) == IFSelect_RetDone


def _run(script, *args, cwd):
    return subprocess.run(
        [sys.executable, "-B", str(PYTHON_DIR / script), *map(str, args)],
        cwd=cwd, capture_output=True, text=True, timeout=90, check=False,
    )


def _assert_contract(model):
    assert set(model) == {"schemaVersion", "source", "units", "parts", "nodes", "bounds", "warnings", "cleanup"}
    assert model["schemaVersion"] == 2
    assert model["units"] == "mm"
    assert set(model["source"]) == {"name", "sha256"}
    assert isinstance(model["source"]["name"], str)
    assert len(model["source"]["sha256"]) == 64
    assert model["parts"] and model["nodes"]
    assert all(isinstance(w, str) for w in model["warnings"])
    assert set(model["cleanup"]) == {"degenerateEdges", "zeroAreaTriangles"}
    assert all(type(count) is int and count >= 0 for count in model["cleanup"].values())
    part_map = {part["id"]: part for part in model["parts"]}
    assert len(part_map) == len(model["parts"])
    all_ids = list(part_map)
    for part in model["parts"]:
        assert set(part) == {"id", "label", "color", "positions", "normals", "indices", "bounds", "faces", "edges"}
        assert isinstance(part["label"], str) and part["label"]
        points = np.array(part["positions"]).reshape(-1, 3)
        normals = np.array(part["normals"]).reshape(-1, 3)
        triangles = np.array(part["indices"]).reshape(-1, 3)
        assert points.shape == normals.shape
        assert np.isfinite(points).all() and np.isfinite(normals).all()
        np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1, atol=1e-7)
        assert all(type(i) is int for i in part["indices"])
        assert triangles.min() >= 0 and triangles.max() < len(points)
        assert np.all(points >= np.array(part["bounds"]["min"]) - 1e-9)
        assert np.all(points <= np.array(part["bounds"]["max"]) + 1e-9)
        cross = np.cross(points[triangles[:, 1]] - points[triangles[:, 0]],
                         points[triangles[:, 2]] - points[triangles[:, 0]])
        assert np.all(np.linalg.norm(cross, axis=1) > 0)
        assert np.all(np.sum(cross * normals[triangles].mean(axis=1), axis=1) > 0)
        assert len(part["color"]) == 3 and all(0 <= c <= 1 for c in part["color"])
        next_triangle = 0
        for index, face in enumerate(part["faces"], start=1):
            assert face["id"] == f"f{index}"
            assert face["triangleStart"] == next_triangle
            assert face["triangleCount"] > 0
            next_triangle += face["triangleCount"]
            assert np.isfinite(face["area"]) and face["area"] > 0
            assert len(face["center"]) == 3 and np.isfinite(face["center"]).all()
            assert face["surfaceType"]
        assert next_triangle == len(triangles)
        assert len({edge["id"] for edge in part["edges"]}) == len(part["edges"])
        for edge in part["edges"]:
            assert set(edge) == {"id", "positions", "curveType", "length", "center", "bounds"}
            assert edge["id"].startswith("e") and int(edge["id"][1:]) > 0
            edge_points = np.asarray(edge["positions"]).reshape(-1, 3)
            assert len(edge_points) >= 2 and np.isfinite(edge_points).all()
            assert edge["curveType"] and np.isfinite(edge["length"]) and edge["length"] > 0
            assert len(edge["center"]) == 3 and np.isfinite(edge["center"]).all()
            assert np.all(edge_points >= np.asarray(edge["bounds"]["min"]) - 1e-6)
            assert np.all(edge_points <= np.asarray(edge["bounds"]["max"]) + 1e-6)
    worlds = {}
    for node in model["nodes"]:
        assert set(node) == {"id", "label", "parentId", "partId", "matrix", "color"}
        assert node["label"]
        assert len(node["matrix"]) == 16
        assert np.isfinite(node["matrix"]).all()
        assert len(node["color"]) == 3 and all(0 <= c <= 1 for c in node["color"])
        local = np.array(node["matrix"]).reshape(4, 4, order="F")
        np.testing.assert_allclose(local[3], [0, 0, 0, 1])
        if node["parentId"] is not None:
            assert node["parentId"] in worlds
        world = worlds.get(node["parentId"], np.eye(4)) @ local
        worlds[node["id"]] = world
        all_ids.append(node["id"])
        if node["partId"]:
            part = part_map[node["partId"]]
            points = np.array(part["positions"]).reshape(-1, 3) @ world[:3, :3].T + world[:3, 3]
            assert np.all(points >= np.array(model["bounds"]["min"]) - 1e-9)
            assert np.all(points <= np.array(model["bounds"]["max"]) + 1e-9)
    assert len(all_ids) == len(set(all_ids))
    for bounds in [model["bounds"], *(p["bounds"] for p in model["parts"])]:
        assert set(bounds) == {"min", "max"}
        assert len(bounds["min"]) == len(bounds["max"]) == 3
        assert np.isfinite([bounds["min"], bounds["max"]]).all()
        assert np.all(np.array(bounds["min"]) <= bounds["max"])
    json.dumps(model, allow_nan=False)
    return worlds


def test_direct_step_exact_bytes_and_finite_contract(workdir):
    path = workdir / "plain block.STP"
    _write_direct(path)
    model = converter.convert_step(path)
    _assert_contract(model)
    assert len(model["parts"]) == len(model["nodes"]) == 1
    assert model["nodes"][0]["label"] == "plain block"
    assert model["nodes"][0]["parentId"] is None
    assert model["nodes"][0]["partId"] == model["parts"][0]["id"]
    assert model["source"] == {"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    np.testing.assert_allclose(model["bounds"]["min"], [0, 0, 0], atol=1e-6)
    np.testing.assert_allclose(model["bounds"]["max"], [10, 20, 30], atol=1e-6)
    assert len(model["parts"][0]["faces"]) == 6
    assert all(face["surfaceType"] == "plane" for face in model["parts"][0]["faces"])
    assert all(face["triangleCount"] == 2 for face in model["parts"][0]["faces"])
    assert sorted(face["area"] for face in model["parts"][0]["faces"]) == pytest.approx([200, 200, 300, 300, 600, 600])
    edges = model["parts"][0]["edges"]
    assert len(edges) == 12
    assert all(edge["curveType"] == "line" and len(edge["positions"]) == 6 for edge in edges)
    assert sorted(edge["length"] for edge in edges) == pytest.approx([10] * 4 + [20] * 4 + [30] * 4)
    for edge in edges:
        points = np.asarray(edge["positions"]).reshape(-1, 3)
        np.testing.assert_allclose(edge["center"], points.mean(axis=0), atol=1e-9)


def test_circular_edges_are_native_unique_closed_curves_with_exact_length(workdir):
    path = workdir / "cylinder.step"
    _write_direct(path, BRepPrimAPI_MakeCylinder(12, 25).Shape())
    model = converter.convert_step(path)
    _assert_contract(model)
    edges = model["parts"][0]["edges"]
    assert len(edges) == 3, "Two shared circular boundaries and one seam, not tessellation facets"
    circles = [edge for edge in edges if edge["curveType"] == "circle"]
    assert len(circles) == 2
    for edge in circles:
        points = np.asarray(edge["positions"]).reshape(-1, 3)
        assert len(points) > 12
        np.testing.assert_allclose(points[0], points[-1], atol=1e-8)
        np.testing.assert_allclose(np.linalg.norm(points[:, :2], axis=1), 12, atol=1e-8)
        assert edge["length"] == pytest.approx(24 * np.pi)
        assert np.linalg.norm(np.diff(points, axis=0), axis=1).sum() < edge["length"]
        np.testing.assert_allclose(edge["center"][:2], [0, 0], atol=1e-8)
        np.testing.assert_allclose(edge["bounds"]["min"][:2], [-12, -12], atol=1e-6)
        np.testing.assert_allclose(edge["bounds"]["max"][:2], [12, 12], atol=1e-6)


def test_edges_deduplicate_shared_topology_not_coincident_or_located_geometry():
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    box = BRepPrimAPI_MakeBox(2, 3, 4).Shape()
    builder.Add(compound, box)
    builder.Add(compound, box)
    builder.Add(compound, BRepPrimAPI_MakeBox(2, 3, 4).Shape())
    builder.Add(compound, box.Moved(_location(10, 20, 30, np.pi / 2)))
    warnings = converter.WarningLog()
    edges = converter._edges(compound, {"edges": 0, "edgePoints": 0}, warnings)
    assert len(edges) == 36
    assert not warnings.items
    for original, located in zip(edges[:12], edges[24:]):
        points = np.asarray(original["positions"]).reshape(-1, 3)
        expected = points @ np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]]) + [10, 20, 30]
        np.testing.assert_allclose(np.asarray(located["positions"]).reshape(-1, 3), expected, atol=1e-8)
        assert original["length"] == pytest.approx(located["length"])


def test_spline_edge_sampling_preserves_order_and_uses_native_curve_length():
    poles = Array1_gp_Pnt(1, 3)
    for index, point in enumerate([(0, 0, 0), (5, 10, 0), (10, 0, 0)], start=1):
        poles.SetValue(index, gp_Pnt(*point))
    shape = BRepBuilderAPI_MakeEdge(Geom_BezierCurve(poles)).Shape()
    edge, = converter._edges(shape, {"edges": 0, "edgePoints": 0}, converter.WarningLog())
    points = np.asarray(edge["positions"]).reshape(-1, 3)
    assert edge["curveType"] == "beziercurve"
    assert len(points) > 3
    np.testing.assert_allclose(points[[0, -1]], [[0, 0, 0], [10, 0, 0]], atol=1e-9)
    assert np.all(np.diff(points[:, 0]) > 0)
    assert edge["length"] == pytest.approx(5 * np.sqrt(5) + 2.5 * np.arcsinh(2), rel=1e-6)
    assert np.linalg.norm(np.diff(points, axis=0), axis=1).sum() < edge["length"]


def test_demo_reuses_spacers_and_preserves_local_frames(workdir):
    path = workdir / "demo.step"
    demo.create_demo(path)
    model = converter.convert_step(path)
    worlds = _assert_contract(model)
    assert len(model["parts"]) == 3
    assert len(model["nodes"]) == 8
    nodes = {n["label"]: n for n in model["nodes"]}
    support = nodes["Four spacers"]
    assert support["partId"] is None
    assert support["matrix"][12:15] == [0, 0, 4]
    spacers = [nodes[f"Spacer {i}"] for i in range(1, 5)]
    assert len({n["partId"] for n in spacers}) == 1
    assert all(n["parentId"] == support["id"] for n in spacers)
    for node, xy in zip(spacers, demo.SPACER_CENTERS):
        assert node["matrix"][12:15] == [*xy, 0]
        np.testing.assert_allclose(worlds[node["id"]][:3, 3], [*xy, 4])
    np.testing.assert_allclose(nodes["Base plate"]["color"], [0.12, 0.32, 0.65], atol=1e-6)
    np.testing.assert_allclose(nodes["Spacer 1"]["color"], [0.85, 0.46, 0.08], atol=1e-6)
    np.testing.assert_allclose(nodes["Cover plate"]["color"], [0.18, 0.62, 0.39], atol=1e-6)
    np.testing.assert_allclose(model["bounds"]["min"], [-50, -32.5, 0], atol=1e-6)
    np.testing.assert_allclose(model["bounds"]["max"], [50, 32.5, 35], atol=1e-6)
    spacer = next(p for p in model["parts"] if p["id"] == spacers[0]["partId"])
    np.testing.assert_allclose(spacer["bounds"]["min"], [-4, -4, 0], atol=1e-6)
    np.testing.assert_allclose(spacer["bounds"]["max"], [4, 4, 27], atol=1e-6)


def test_rotated_nested_repeated_assemblies_and_occurrence_color(workdir):
    document, shapes, colors = _document()
    root = shapes.NewShape()
    sub = shapes.NewShape()
    part = shapes.AddShape(BRepPrimAPI_MakeBox(2, 3, 4).Shape(), False)
    _name(root, "Root")
    _name(sub, "Reusable group")
    _name(part, "Local block")
    leaf = shapes.AddComponent(sub, part, _location(5, 7, 11, np.pi / 2))
    _name(leaf, "Offset block")
    colors.SetColor(part, Quantity_Color(0.2, 0.4, 0.6, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    first = shapes.AddComponent(root, sub, _location(100, 50, 30, np.pi / 2))
    second = shapes.AddComponent(root, sub, _location(-20, -30, -40))
    _name(first, "Turned group")
    _name(second, "Second group")
    alternate = shapes.AddComponent(root, part, _location(0, -50, 0))
    _name(alternate, "Red occurrence")
    colors.SetColor(alternate, Quantity_Color(0.8, 0.1, 0.1, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    path = workdir / "hierarchy.step"
    _write_document(document, path)
    model = converter.convert_step(path)
    worlds = _assert_contract(model)
    assert len(model["parts"]) == 1
    assert len(model["nodes"]) == 6
    groups = {n["label"]: n for n in model["nodes"] if n["partId"] is None}
    leaves = [n for n in model["nodes"] if n["label"] == "Offset block"]
    assert len(leaves) == 2
    assert leaves[0]["partId"] == leaves[1]["partId"]
    first_leaf = next(n for n in leaves if n["parentId"] == groups["Turned group"]["id"])
    second_leaf = next(n for n in leaves if n["parentId"] == groups["Second group"]["id"])
    assert first_leaf["matrix"][12:15] == [5, 7, 11]
    np.testing.assert_allclose(worlds[first_leaf["id"]][:3, 3], [93, 55, 41], atol=1e-8)
    np.testing.assert_allclose(worlds[second_leaf["id"]][:3, 3], [-15, -23, -29], atol=1e-8)
    np.testing.assert_allclose(worlds[first_leaf["id"]][:3, :3], np.diag([-1, -1, 1]), atol=1e-8)
    red = next(n for n in model["nodes"] if n["label"] == "Red occurrence")
    np.testing.assert_allclose(red["color"], [0.8, 0.1, 0.1], atol=1e-6)
    np.testing.assert_allclose(model["parts"][0]["color"], [0.2, 0.4, 0.6], atol=1e-6)
    np.testing.assert_allclose(model["parts"][0]["bounds"]["min"], [0, 0, 0], atol=1e-6)
    np.testing.assert_allclose(model["parts"][0]["bounds"]["max"], [2, 3, 4], atol=1e-6)


def test_direct_located_root_preserves_translation(workdir):
    document, shapes, _ = _document()
    part = shapes.AddShape(BRepPrimAPI_MakeBox(2, 3, 4).Shape().Moved(_location(8, 9, 10)), False)
    _name(part, "Moved block")
    path = workdir / "moved.step"
    _write_document(document, path)
    model = converter.convert_step(path)
    _assert_contract(model)
    np.testing.assert_allclose(model["bounds"]["min"], [8, 9, 10], atol=1e-6)
    np.testing.assert_allclose(model["bounds"]["max"], [10, 12, 14], atol=1e-6)
    # The native STEP writer wraps a located root in an assembly occurrence.
    placed = next(n for n in model["nodes"] if n["partId"] is not None)
    assert placed["matrix"][12:15] == [8, 9, 10]
    np.testing.assert_allclose(model["parts"][0]["bounds"]["min"], [0, 0, 0], atol=1e-6)


def test_units_are_converted_to_millimeters(workdir):
    path = workdir / "centimeter.step"
    _write_direct(path)
    data = path.read_bytes()
    assert b".MILLI.,.METRE." in data
    path.write_bytes(data.replace(b".MILLI.,.METRE.", b".CENTI.,.METRE."))
    model = converter.convert_step(path)
    _assert_contract(model)
    np.testing.assert_allclose(model["bounds"]["max"], [100, 200, 300], atol=1e-5)


def test_curved_surface_normals_and_analytic_bounds(workdir):
    path = workdir / "sphere.step"
    _write_direct(path, BRepPrimAPI_MakeSphere(12).Shape())
    model = converter.convert_step(path)
    _assert_contract(model)
    np.testing.assert_allclose(model["bounds"]["min"], [-12, -12, -12], atol=1e-6)
    np.testing.assert_allclose(model["bounds"]["max"], [12, 12, 12], atol=1e-6)
    positions = np.asarray(model["parts"][0]["positions"]).reshape(-1, 3)
    normals = np.asarray(model["parts"][0]["normals"]).reshape(-1, 3)
    assert np.all(np.sum(positions * normals, axis=1) > 0)
    assert len(model["parts"][0]["edges"]) == 1
    assert not model["warnings"]
    assert model["cleanup"]["degenerateEdges"] == 2


def _budget():
    return {"vertices": 0, "triangles": 0, "faces": 0, "edges": 0, "edgePoints": 0}


def _assert_native_retention(shape, mesh, cleanup):
    native_edges = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, native_edges)
    expected_ids = [
        f"e{i}" for i in range(1, native_edges.Extent() + 1)
        if not BRep_Tool.Degenerated_s(TopoDS.Edge(native_edges.FindKey(i)))
    ]
    assert [edge["id"] for edge in mesh["edges"]] == expected_ids
    assert cleanup["degenerateEdges"] == native_edges.Extent() - len(expected_ids)
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    offset = 0
    face_count = 0
    collapsed = 0
    expected_indices = []
    while faces.More():
        face = TopoDS.Face(faces.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        matrix = converter._matrix(location)
        points = np.asarray([triangulation.Node(i).Coord() for i in range(1, triangulation.NbNodes() + 1)])
        points = points @ matrix[:3, :3].T + matrix[:3, 3]
        triangles = np.asarray([triangulation.Triangle(i).Get() for i in range(1, triangulation.NbTriangles() + 1)]) - 1
        if (face.Orientation() == TopAbs_REVERSED) != (np.linalg.det(matrix[:3, :3]) < 0):
            triangles = triangles[:, [0, 2, 1]]
        areas = np.linalg.norm(np.cross(points[triangles[:, 1]] - points[triangles[:, 0]],
                                        points[triangles[:, 2]] - points[triangles[:, 0]]), axis=1)
        collapsed += int(np.count_nonzero(areas == 0))
        expected_indices.extend((triangles[areas > 0] + offset).ravel().tolist())
        assert mesh["faces"][face_count]["id"] == f"f{face_count + 1}"
        assert mesh["faces"][face_count]["triangleCount"] == int(np.count_nonzero(areas > 0))
        offset += len(points)
        face_count += 1
        faces.Next()
    assert len(mesh["faces"]) == face_count
    assert mesh["indices"] == expected_indices
    assert cleanup["zeroAreaTriangles"] == collapsed


def _rounded_box():
    box = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
    fillet = BRepFilletAPI_MakeFillet(box)
    edges = TopExp_Explorer(box, TopAbs_EDGE)
    while edges.More():
        fillet.Add(2, TopoDS.Edge(edges.Current()))
        edges.Next()
    fillet.Build()
    assert fillet.IsDone()
    return fillet.Shape()


@pytest.mark.parametrize("factory", [lambda: BRepPrimAPI_MakeSphere(12).Shape(), _rounded_box])
def test_cleanup_preserves_every_native_face_nondegenerate_edge_id_and_retained_triangle(factory):
    shape = factory()
    log = converter.WarningLog()
    mesh = converter._mesh(shape, _budget(), log)
    assert not log.items
    assert log.cleanup["degenerateEdges"] > 0
    _assert_native_retention(shape, mesh, log.cleanup)


def test_more_than_100_unique_degenerate_edges_do_not_consume_warning_budget(workdir, monkeypatch):
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    for i in range(60):
        builder.Add(compound, BRepPrimAPI_MakeSphere(gp_Pnt(i * 30, 0, 0), 12).Shape())
    path = workdir / "many rounded parts.step"
    _write_direct(path, compound)
    original = converter._mesh

    def checked_mesh(shape, budget, log):
        before = log.cleanup.copy()
        result = original(shape, budget, log)
        _assert_native_retention(shape, result, {key: log.cleanup[key] - before[key] for key in before})
        return result

    monkeypatch.setattr(converter, "_mesh", checked_mesh)
    model = converter.convert_step(path)
    _assert_contract(model)
    assert not model["warnings"]
    assert model["cleanup"]["degenerateEdges"] == 120
    assert sum(len(part["faces"]) for part in model["parts"]) == 60
    assert sum(len(part["edges"]) for part in model["parts"]) == 60
    # Also exercise a single part's unique eN IDs beyond the old warning cap.
    log = converter.WarningLog()
    converter._edges(compound, _budget(), log)
    assert log.cleanup["degenerateEdges"] == 120
    assert not log.items
    for i in range(converter.MAX_WARNINGS):
        log.add(f"STEP transfer: genuine warning {i}")
    assert len(log.items) == converter.MAX_WARNINGS
    with pytest.raises(converter.ConversionError, match="Too many conversion warnings"):
        log.add("STEP transfer: one warning over the limit")


def test_cleanup_counts_reusable_geometry_once_with_mixed_real_warnings(workdir):
    document, shapes, colors = _document()
    root = shapes.NewShape()
    sphere = shapes.AddShape(BRepPrimAPI_MakeSphere(12).Shape(), False)
    from OCP.Quantity import Quantity_ColorRGBA
    colors.SetColor(sphere, Quantity_ColorRGBA(Quantity_Color(0.2, 0.4, 0.6, Quantity_TOC_RGB), 0.5), XCAFDoc_ColorSurf)
    for i in range(60):
        shapes.AddComponent(root, sphere, _location(i * 30))
    path = workdir / "repeated spheres.step"
    _write_document(document, path)
    model = converter.convert_step(path)
    _assert_contract(model)
    assert len(model["parts"]) == 1
    assert len([node for node in model["nodes"] if node["partId"]]) == 60
    assert model["cleanup"]["degenerateEdges"] == 2
    assert model["warnings"] == ["Transparency is unsupported; transparent parts are shown opaque."]


def test_flagged_nonpoint_edge_is_not_benign_cleanup():
    edge = BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(10, 0, 0)).Edge()
    BRep_Builder().Degenerated(edge, True)
    with pytest.raises(converter.ConversionError, match="not a finite point"):
        converter._edges(edge, _budget(), converter.WarningLog())


def test_unflagged_zero_length_edge_keeps_warning_and_invalid_curve_is_an_error(monkeypatch):
    edge = BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(10, 0, 0)).Edge()
    log = converter.WarningLog()
    monkeypatch.setattr(converter, "GCPnts_AbscissaPoint", SimpleNamespace(Length_s=lambda *_: 0))
    assert converter._edges(edge, _budget(), log) == []
    assert log.items == ["Zero-length CAD edge e1 was omitted from edge selection."]
    assert log.cleanup == {"degenerateEdges": 0, "zeroAreaTriangles": 0}
    monkeypatch.setattr(converter, "GCPnts_AbscissaPoint", SimpleNamespace(Length_s=lambda *_: float("nan")))
    with pytest.raises(converter.ConversionError, match="invalid native curve properties"):
        converter._edges(edge, _budget(), converter.WarningLog())


@pytest.mark.parametrize("fault,message", [
    ("missing", "could not be tessellated"),
    ("collapsed", "no non-degenerate triangles"),
    ("nonfinite", "non-finite positions"),
    ("indices", "out-of-range triangle indices"),
])
def test_bad_face_mesh_still_fails_instead_of_reporting_cleanup(monkeypatch, fault, message):
    class Mesh:
        def __init__(self, native):
            self.native = native

        def __getattr__(self, name):
            return getattr(self.native, name)

        def Triangle(self, index):
            if fault == "collapsed":
                return SimpleNamespace(Get=lambda: (1, 1, 1))
            if fault == "indices":
                return SimpleNamespace(Get=lambda: (1, 2, self.native.NbNodes() + 1))
            return self.native.Triangle(index)

        def Node(self, index):
            if fault == "nonfinite":
                return SimpleNamespace(Coord=lambda: (float("nan"), 0, 0))
            return self.native.Node(index)

    monkeypatch.setattr(converter, "BRep_Tool", SimpleNamespace(
        Triangulation_s=lambda *args: None if fault == "missing" else Mesh(BRep_Tool.Triangulation_s(*args)),
    ))
    with pytest.raises(converter.ConversionError, match=message):
        converter._mesh(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), _budget(), converter.WarningLog())


def test_null_and_invalid_native_shapes_remain_errors(monkeypatch):
    with pytest.raises(converter.ConversionError, match="null or invalid"):
        converter._mesh(TopoDS_Shape(), _budget(), converter.WarningLog())
    monkeypatch.setattr(converter, "BRepCheck_Analyzer", lambda _: SimpleNamespace(IsValid=lambda: False))
    with pytest.raises(converter.ConversionError, match="null or invalid"):
        converter._mesh(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), _budget(), converter.WarningLog())


def test_repeat_conversion_is_deterministic_and_has_no_stale_state(workdir):
    first = workdir / "first.step"
    other = workdir / "other.step"
    demo.create_demo(first)
    _write_direct(other)
    a = converter.convert_step(first)
    b = converter.convert_step(other)
    c = converter.convert_step(first)
    assert a == c
    assert len(b["parts"]) == 1
    assert b["source"]["sha256"] != a["source"]["sha256"]
    assert "Spacer" not in json.dumps(b)


def test_cli_demo_convert_paths_with_spaces_and_non_model_cwd(workdir):
    folder = workdir / "model directory with spaces"
    source = folder / "raised cover.STEP"
    output = workdir / "runtime output" / "preview.json"
    generated = _run("create_demo.py", "--output", source, cwd=workdir)
    assert generated.returncode == 0, generated.stderr
    converted = _run("convert.py", source, "--output", output, cwd=workdir)
    assert converted.returncode == 0, converted.stderr
    model = json.loads(output.read_text())
    _assert_contract(model)
    assert len(model["parts"]) == 3
    before = output.read_bytes()
    again = _run("convert.py", source, "--output", output, cwd=folder)
    assert again.returncode == 0, again.stderr
    assert output.read_bytes() == before
    assert {p.relative_to(workdir) for p in workdir.rglob("*") if p.is_file()} == {
        source.relative_to(workdir), output.relative_to(workdir),
    }


@pytest.mark.parametrize("content", [
    b"", b"not STEP", b"ISO-10303-21; HEADER; ENDSEC; DATA; #1 =",
    b"ISO-10303-21; HEADER; ENDSEC; DATA; ENDSEC; END-ISO-10303-21;",
])
def test_bad_input_cli_fails_without_output(workdir, content):
    path = workdir / "bad input.step"
    path.write_bytes(content)
    output = workdir / "not created" / "bad.json"
    result = _run("convert.py", path, "--output", output, cwd=workdir)
    assert result.returncode != 0
    assert "STEP conversion failed:" in result.stderr
    assert not output.parent.exists()


def test_failure_does_not_replace_previous_output(workdir):
    path = workdir / "bad.step"
    path.write_bytes(b"bad")
    output = workdir / "existing.json"
    output.write_text("previous result")
    result = _run("convert.py", path, "--output", output, cwd=workdir)
    assert result.returncode != 0
    assert output.read_text() == "previous result"


def test_missing_input_and_generator_not_executed(workdir):
    missing = _run("convert.py", workdir / "missing.step", "--output", workdir / "x.json", cwd=workdir)
    assert missing.returncode != 0 and "does not exist" in missing.stderr
    source = workdir / "generator.py"
    source.write_text("raise RuntimeError('must never execute')")
    result = _run("convert.py", source, "--output", workdir / "x.json", cwd=workdir)
    assert result.returncode != 0 and "ordinary .step or .stp" in result.stderr
    assert "must never execute" not in result.stderr
    assert not (workdir / "x.json").exists()


def test_output_cannot_overwrite_input(workdir):
    source = workdir / "input.step"
    _write_direct(source)
    original = source.read_bytes()
    result = _run("convert.py", source, "--output", source, cwd=workdir)
    assert result.returncode != 0 and "overwrite" in result.stderr
    assert source.read_bytes() == original


def test_input_100mb_cap_before_native_read(workdir):
    source = workdir / "huge.step"
    with source.open("wb") as stream:
        stream.truncate(converter.MAX_INPUT_BYTES + 1)
    with pytest.raises(converter.ConversionError, match="100 MB"):
        converter.convert_step(source)


def test_mesh_budget_fails_explicitly(workdir, monkeypatch):
    path = workdir / "small.step"
    _write_direct(path)
    monkeypatch.setattr(converter, "MAX_VERTICES", 3)
    with pytest.raises(converter.ConversionError, match="vertex/triangle limit"):
        converter.convert_step(path)


@pytest.mark.parametrize("budget,message", [
    ("MAX_EDGES", "CAD edge limit"), ("MAX_EDGE_POINTS", "CAD edge point limit"),
])
def test_edge_budget_fails_explicitly(workdir, monkeypatch, budget, message):
    path = workdir / "small.step"
    _write_direct(path)
    monkeypatch.setattr(converter, budget, 1)
    with pytest.raises(converter.ConversionError, match=message):
        converter.convert_step(path)


def test_output_budget_does_not_touch_destination(workdir, monkeypatch):
    monkeypatch.setattr(converter, "MAX_OUTPUT_BYTES", 2)
    output = workdir / "not created" / "small.json"
    with pytest.raises(converter.ConversionError, match="JSON output limit"):
        converter.write_json({"too": "large"}, output)
    assert not output.parent.exists()


@pytest.mark.parametrize("module,operation", [(converter, "convert_step"), (demo, "create_demo")])
def test_native_exceptions_have_explicit_cli_stderr(workdir, monkeypatch, capsys, module, operation):
    def fail(*args):
        raise Standard_Failure("synthetic native failure")

    monkeypatch.setattr(module, operation, fail)
    output = workdir / "not created" / "result.step"
    args = ["--output", str(output)]
    if module is converter:
        args.insert(0, str(workdir / "input.step"))
    assert module.main(args) == 1
    assert "synthetic native failure" in capsys.readouterr().err
    assert not output.parent.exists()


def test_external_reference_sections_rejected_before_transfer(workdir):
    path = workdir / "external.step"
    _write_direct(path)
    data = path.read_bytes().replace(
        b"DATA;", b"REFERENCE;\n#999=<../outside.step>;\nENDSEC;\nDATA;", 1,
    )
    path.write_bytes(data)
    with pytest.raises(converter.ConversionError, match="External references"):
        converter.convert_step(path)


def test_malformed_entity_in_otherwise_valid_step_fails(workdir):
    path = workdir / "malformed.step"
    _write_direct(path)
    data = path.read_bytes().replace(b"CARTESIAN_POINT('',(0.,0.,0.))", b"CARTESIAN_POINT('',#999999)", 1)
    path.write_bytes(data)
    with pytest.raises(converter.ConversionError, match="parse|reader|transfer"):
        converter.convert_step(path)


def test_native_multifile_external_references_rejected(workdir):
    document, shapes, _ = _document()
    root = shapes.NewShape()
    part = shapes.AddShape(BRepPrimAPI_MakeBox(1, 2, 3).Shape(), False)
    _name(part, "External block")
    shapes.AddComponent(root, part, _location())
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    assert writer.Transfer(document, STEPControl_AsIs, str(workdir / "external-"))
    path = workdir / "external assembly.step"
    assert writer.Write(str(path)) == IFSelect_RetDone
    with pytest.raises(converter.ConversionError, match="External references"):
        converter.convert_step(path)


def test_wire_only_file_rejected(workdir):
    path = workdir / "wire.step"
    _write_direct(path, BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(10, 0, 0)).Shape())
    with pytest.raises(converter.ConversionError, match="wire/point-only"):
        converter.convert_step(path)


def test_per_face_colors_warn_instead_of_silent_loss(workdir):
    document, shapes, colors = _document()
    shape = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
    part = shapes.AddShape(shape, False)
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    for rgb in ((0.9, 0.1, 0.1), (0.1, 0.9, 0.1)):
        sub = shapes.AddSubShape(part, faces.Current())
        colors.SetColor(sub, Quantity_Color(*rgb, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
        faces.Next()
    path = workdir / "face colors.step"
    _write_document(document, path)
    model = converter.convert_step(path)
    _assert_contract(model)
    assert any("Per-face/subshape colors" in message for message in model["warnings"])
