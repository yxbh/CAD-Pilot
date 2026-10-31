"""Mesh files read directly: formats, frames, names, welding, faults, the binary contract and measurement."""

import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np
import pytest
import trimesh

EXPLORER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPLORER / "python"))
import measure  # noqa: E402
import mesh  # noqa: E402

BOX = trimesh.creation.box((10, 20, 30))


def scene() -> trimesh.Scene:
    result = trimesh.Scene()
    result.add_geometry(BOX, node_name="Lid", geom_name="LidGeom", transform=trimesh.transformations.translation_matrix([50, 0, 0]))
    result.add_geometry(trimesh.creation.cylinder(5, 10), node_name="Base", geom_name="BaseGeom")
    return result


def binary_stl(path: Path, vertices: np.ndarray, faces: np.ndarray) -> Path:
    corners = np.asarray(vertices, dtype="<f4")[np.asarray(faces)]
    record = np.zeros(len(corners), dtype=[("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
    record["vertices"] = corners
    path.write_bytes(b"\0" * 80 + struct.pack("<I", len(corners)) + record.tobytes())
    return path


@pytest.mark.parametrize("extension", ["3mf", "glb", "ply", "stl"])
def test_formats_keep_parts_names_and_placements(tmp_path, extension):
    path = tmp_path / f"pair.{extension}"
    scene().export(path)
    document = mesh.load(path)
    assert document.format == extension
    assert all(part.closed for part in document.parts)
    if extension in ("3mf", "glb"):
        assert sorted(node.label for node in document.nodes) == ["Base", "Lid"]
        lid = next(node for node in document.nodes if node.label == "Lid")
        # glTF is metres and Y-up: 50 m along X stays on X, in millimetres.
        assert lid.matrix[:3, 3] == pytest.approx([50 * document.frame["scale"], 0, 0])
    else:
        assert [node.label for node in document.nodes] == ["pair"]


def test_frames_come_from_the_file_its_format_or_its_size(tmp_path):
    glb = tmp_path / "part.glb"
    trimesh.Scene(BOX).export(glb)
    frame = mesh.load(glb).frame
    assert (frame["units"], frame["unitsFrom"], frame["up"], frame["upFrom"]) == ("m", "file", "y", "format")
    small = binary_stl(tmp_path / "small.stl", BOX.vertices / 100, BOX.faces)
    assert mesh.load(small).frame["units"] == "m", "Under 2.5 units across reads as metres"
    assert mesh.load(small, units="mm").frame["units"] == "mm"
    assert "units=" in mesh.load(small).frame["note"]
    large = binary_stl(tmp_path / "large.stl", BOX.vertices, BOX.faces)
    assert mesh.load(large).frame["units"] == "mm"
    with pytest.raises(mesh.MeshError):
        mesh.load(large, units="parsecs")


def test_y_up_files_stand_up_and_keep_their_volume(tmp_path):
    path = tmp_path / "tall.obj"
    path.write_text("o Tall\nv 0 0 0\nv 1 0 0\nv 0 5 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n")
    upright = mesh.load(path)
    assert (upright.frame["up"], upright.frame["units"]) == ("y", "mm")
    assert upright.parts[0].bounds["max"][2] == pytest.approx(5), "OBJ is read Y-up, so its tall side stands on Z"
    assert upright.parts[0].bounds["min"][1] == pytest.approx(-1), "and its front (+Z) faces the viewer's front (-Y)"
    as_is = mesh.load(path, units="mm", up="z")
    assert as_is.parts[0].bounds["max"][1] == pytest.approx(5)
    assert abs(as_is.parts[0].volume) == pytest.approx(5 / 6)


def test_obj_objects_polygons_negative_indices_and_vertex_colours(tmp_path):
    path = tmp_path / "parts.obj"
    path.write_text(
        "g ignored\n"
        "o Quad\nv 0 0 0 1 0 0\nv 10 0 0 1 0 0\nv 10 10 0 1 0 0\nv 0 10 0 1 0 0\n"
        "vt 0 0\nvn 0 0 1\nf -4/1/1 -3/1/1 -2/1/1 -1/1/1\n"
        "o Fan\nv 0 0 5 0 1 0\nv 1 0 5 0 1 0\nv 1 1 5 0 1 0\nv 0.5 2 5 0 1 0\nv 0 1 5 0 1 0\nf 5 6 7 8 9\n"
    )
    document = mesh.load(path, units="mm", up="z")
    assert [part.label for part in document.parts] == ["Quad", "Fan"]
    assert [len(part.triangles) for part in document.parts] == [2, 3]
    assert document.parts[0].area == pytest.approx(100)
    assert not document.parts[0].closed and len(document.parts[0].open_edges) == 4


def test_ascii_stl_solids_become_named_parts(tmp_path):
    facet = "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n"
    path = tmp_path / "two.stl"
    path.write_text(f"solid Alpha\n{facet}endsolid Alpha\nsolid\n{facet}endsolid\n")
    assert [part.label for part in mesh.load(path).parts] == ["Alpha", "two"]
    assert [part.label for part in mesh.load(path, name="Chosen.stl").parts] == ["Alpha", "Chosen"]


def test_collapsed_facets_keep_a_mesh_closed(tmp_path):
    collapsed = BOX.faces.tolist() + [[0, 0, 1]]
    part = mesh.load(binary_stl(tmp_path / "collapsed.stl", BOX.vertices, collapsed)).parts[0]
    assert (part.closed, len(part.overshared_edges), len(part.open_edges)) == (True, 0, 0)
    assert part.volume == pytest.approx(6000) and part.degenerate_triangles.tolist() == [12]
    assert len(part.outlines) == 12, "and it adds no outline"


def test_ascii_names_survive_endsolid_lookalikes_and_obj_comments(tmp_path):
    facet = "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n"
    stl = tmp_path / "parts.stl"
    stl.write_text(f"solid bracket_solid\n{facet}endsolid bracket_solid\nsolid Lid\n{facet}endsolid Lid\n")
    assert [part.label for part in mesh.load(stl).parts] == ["bracket_solid", "Lid"]
    obj = tmp_path / "commented.obj"
    obj.write_text("v 0 0 0 # origin\n  v 10 0 0\nv 0 10 0\nf 1 2 3 # the only face\n")
    assert len(mesh.load(obj, units="mm").parts[0].triangles) == 1


def test_names_that_look_like_options_reach_the_reader(tmp_path):
    source = binary_stl(tmp_path / "copy.stl", BOX.vertices, BOX.faces)
    assert mesh.main([str(source), "--output-dir", str(tmp_path / "out"), "--name=-scan.stl"]) == 0
    assert json.loads((tmp_path / "out" / "model.json").read_text())["source"]["name"] == "-scan.stl"


def test_welding_merges_exact_copies_only(tmp_path):
    soup = binary_stl(tmp_path / "box.stl", BOX.vertices, BOX.faces)
    part = mesh.load(soup).parts[0]
    assert (len(part.positions), len(part.triangles), part.closed) == (8, 12, True)
    assert part.volume == pytest.approx(6000)
    nudged = BOX.vertices.copy()
    faces = BOX.faces.copy()
    nudged = np.vstack([nudged, nudged[faces[0, 0]] + [0, 0, 1e-3]])
    faces[0, 0] = len(nudged) - 1
    near_miss = mesh.load(binary_stl(tmp_path / "gap.stl", nudged, faces)).parts[0]
    assert not near_miss.closed and len(near_miss.open_edges) == 4, "A vertex a micrometre away is not merged"


def test_outlines_follow_sharp_edges_but_not_noise(tmp_path):
    box = mesh.load(binary_stl(tmp_path / "box.stl", BOX.vertices, BOX.faces)).parts[0]
    assert len(box.outlines) == 12, "The box's 12 edges, not the diagonals across its faces"
    sphere = trimesh.creation.icosphere(5)
    noisy = sphere.vertices + np.random.default_rng(0).normal(0, 0.02, sphere.vertices.shape)
    assert len(mesh.load(binary_stl(tmp_path / "noisy.stl", noisy * 20, sphere.faces)).parts[0].outlines) == 0


def test_faults_are_found_where_they_are(tmp_path):
    faces = BOX.faces.tolist()
    open_box = mesh.load(binary_stl(tmp_path / "open.stl", BOX.vertices, faces[1:])).parts[0]
    assert (len(open_box.open_edges), open_box.closed, open_box.volume) == (3, False, None)
    duplicate = mesh.load(binary_stl(tmp_path / "dup.stl", BOX.vertices, faces + faces[:1])).parts[0]
    assert len(duplicate.overshared_edges) == 3
    flipped = [faces[0][::-1], *faces[1:]]
    flip = mesh.load(binary_stl(tmp_path / "flip.stl", BOX.vertices, flipped)).parts[0]
    assert len(flip.flipped_edges) == 3 and not flip.closed
    degenerate = mesh.load(binary_stl(tmp_path / "zero.stl", BOX.vertices, faces + [[0, 0, 1], [0, 1, 1]])).parts[0]
    assert degenerate.degenerate_triangles.tolist() == [12, 13], "Triangle numbers are the file's own order"
    inside_out = mesh.load(binary_stl(tmp_path / "inside.stl", BOX.vertices, BOX.faces[:, ::-1]))
    assert inside_out.parts[0].volume == pytest.approx(-6000) and "inwards" in inside_out.warnings[0]


def test_written_manifest_describes_the_geometry_file_exactly(tmp_path):
    source = tmp_path / "pair.3mf"
    scene().export(source)
    mesh.write(mesh.load(source, name="Pair.3mf"), tmp_path / "out")
    manifest = json.loads((tmp_path / "out" / "model.json").read_text())
    geometry = (tmp_path / "out" / "geometry.bin").read_bytes()
    assert manifest["kind"] == "mesh" and manifest["source"]["name"] == "Pair.3mf"
    assert manifest["geometry"] == {"bytes": len(geometry), "sha256": hashlib.sha256(geometry).hexdigest()}
    for part in manifest["parts"]:
        buffers = part["buffers"]
        positions = np.frombuffer(geometry, "<f4", buffers["positions"]["count"], buffers["positions"]["offset"]).reshape(-1, 3)
        indices = np.frombuffer(geometry, "<u4", buffers["indices"]["count"], buffers["indices"]["offset"])
        assert len(positions) == part["vertexCount"] and len(indices) == 3 * part["triangleCount"]
        assert indices.max() < part["vertexCount"] and part["faces"] == [] and part["sectionCaps"] is True
        assert all(buffer["offset"] % 4 == 0 for buffer in buffers.values())


def test_unreadable_files_fail_plainly(tmp_path):
    for name, content in [("empty.stl", b" "), ("short.stl", b"\0" * 90), ("bad.obj", b"v 1 2 x\nf 1 2 3\n"), ("none.obj", b"# nothing\n")]:
        (tmp_path / name).write_bytes(content)
        with pytest.raises(mesh.MeshError):
            mesh.load(tmp_path / name)
    with pytest.raises(mesh.MeshError, match="Choose"):
        mesh.load(tmp_path / "model.step")


def test_triangle_limit_is_checked_before_analysis(tmp_path, monkeypatch):
    monkeypatch.setattr(mesh, "MAX_TRIANGLES", 11)
    with pytest.raises(mesh.MeshError, match="triangles"):
        mesh.load(binary_stl(tmp_path / "box.stl", BOX.vertices, BOX.faces))


def plate(tmp_path) -> Path:
    from build123d import Box, BuildPart, BuildSketch, Cylinder, Locations, Mode, Plane, SlotOverall, export_stl, extrude

    with BuildPart() as part:
        Box(60, 40, 6)
        with Locations((-15, 0, 0)):
            Cylinder(5, 6, mode=Mode.SUBTRACT)
        with BuildSketch(Plane.XY.offset(-3)):
            with Locations((12, 0)):
                SlotOverall(14, 4)
        extrude(amount=6, mode=Mode.SUBTRACT)
    path = tmp_path / "plate.stl"
    export_stl(part.part, str(path), tolerance=0.01, angular_tolerance=0.05)
    return path


def run(capsys, *args) -> dict:
    assert measure.main([str(arg) for arg in args]) == 0
    return json.loads(capsys.readouterr().out)


def test_section_fits_holes_and_slots(tmp_path, capsys):
    result = run(capsys, plate(tmp_path), "section", "--z", 0, "--points", 8)
    loops = {loop["shape"]: loop for loop in result["loops"]}
    assert set(loops) == {"outline", "circle", "slot"}
    assert loops["outline"]["rectangle"]["length"] == pytest.approx(60, abs=1e-3)
    assert loops["outline"]["hole"] is False
    assert loops["circle"]["circle"]["diameter"] == pytest.approx(10, abs=0.01)
    assert loops["circle"]["circle"]["center3d"] == pytest.approx([-15, 0, 0], abs=0.01)
    assert loops["slot"]["slot"]["width"] == pytest.approx(4, abs=0.01)
    assert loops["slot"]["slot"]["length"] == pytest.approx(14, abs=0.01)
    assert loops["circle"]["hole"] and loops["slot"]["hole"]
    assert len(loops["circle"]["outline2d"]) <= 8
    # Any plane: through the hole and slot centres, the plate falls into three solid pieces 6 mm thick.
    across = run(capsys, plate(tmp_path), "section", "--plane", "0,0,0", "0,1,0")["loops"]
    assert sorted(round(loop["rectangle"]["length"], 2) for loop in across) == [10, 11, 15]
    assert all(loop["rectangle"]["width"] == pytest.approx(6, abs=1e-3) for loop in across)


def test_open_meshes_give_open_loops_and_their_boundaries(tmp_path, capsys):
    tube = trimesh.creation.cylinder(10, 20, sections=64)
    walls = tube.faces[np.abs(tube.face_normals[:, 2]) < 0.5]
    path = binary_stl(tmp_path / "tube.stl", tube.vertices, walls)
    cut = run(capsys, path, "section", "--x", 0)
    assert [loop["closed"] for loop in cut["loops"]] == [False, False]
    faults = run(capsys, path, "faults")["parts"][0]
    assert faults["openEdges"]["boundaries"] == 2
    assert faults["openEdges"]["largest"][0]["length"] == pytest.approx(2 * np.pi * 10, rel=0.01)


def test_distances_from_points_and_between_files(tmp_path, capsys):
    path = binary_stl(tmp_path / "box.stl", BOX.vertices, BOX.faces)
    between = run(capsys, path, "distance", "--from", "0,0,0", "--to", "3,4,0")
    assert between["distance"] == pytest.approx(5)
    closest = run(capsys, path, "distance", "--from", "20,0,0")["closest"]
    assert closest["distance"] == pytest.approx(15) and closest["point"] == pytest.approx([5, 0, 0])
    # A collapsed facet has no surface of its own and must never be the closest one.
    collapsed = binary_stl(tmp_path / "collapsed.stl", BOX.vertices, BOX.faces.tolist() + [[6, 6, 7]])
    near = run(capsys, collapsed, "distance", "--from", "20,0,0")["closest"]
    assert near["distance"] == pytest.approx(15) and near["point"] == pytest.approx([5, 0, 0])
    corner = run(capsys, path, "distance", "--from", "8,13,18")["closest"]
    assert corner["point"] == pytest.approx([5, 10, 15]) and corner["distance"] == pytest.approx(np.sqrt(27), abs=1e-4)
    bigger = binary_stl(tmp_path / "bigger.stl", BOX.vertices * [1.2, 1, 1], BOX.faces)
    # Every corner of the wider box is 1 mm outside the narrow one; the narrow box's corners lie on the wider one's faces.
    wider = run(capsys, bigger, "distance", "--to-file", path)["deviation"]
    assert wider["maximum"]["distance"] == pytest.approx(1, abs=1e-6) and wider["minimum"]["distance"] == pytest.approx(1, abs=1e-6)
    assert run(capsys, path, "distance", "--to-file", bigger)["deviation"]["maximum"]["distance"] == pytest.approx(0, abs=1e-6)


def test_sizes_by_part_and_unknown_parts(tmp_path, capsys):
    path = tmp_path / "pair.3mf"
    scene().export(path)
    result = run(capsys, path, "--part", "Lid", "size")
    assert [part["name"] for part in result["parts"]] == ["Lid"]
    assert result["bounds"]["size"] == pytest.approx([10, 20, 30])
    assert result["parts"][0]["volume"] == pytest.approx(6000)
    assert measure.main([str(path), "--part", "Missing", "size"]) == 1
    assert "Parts: Base, Lid" in capsys.readouterr().err
