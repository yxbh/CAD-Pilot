"""Native STEP contract checks; fixtures and subprocess outputs stay disposable."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
import pytest
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeSphere
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.Standard import Standard_Failure
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
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
    assert set(model) == {"schemaVersion", "source", "units", "parts", "nodes", "bounds", "warnings"}
    assert model["schemaVersion"] == 2
    assert model["units"] == "mm"
    assert set(model["source"]) == {"name", "sha256"}
    assert isinstance(model["source"]["name"], str)
    assert len(model["source"]["sha256"]) == 64
    assert model["parts"] and model["nodes"]
    assert all(isinstance(w, str) for w in model["warnings"])
    part_map = {part["id"]: part for part in model["parts"]}
    assert len(part_map) == len(model["parts"])
    all_ids = list(part_map)
    for part in model["parts"]:
        assert set(part) == {"id", "label", "color", "positions", "normals", "indices", "bounds", "faces"}
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
