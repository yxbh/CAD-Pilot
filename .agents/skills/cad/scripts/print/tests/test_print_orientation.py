import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from build123d import Box, Compound, Cylinder, Polygon, Pos, Rot, export_step, export_stl, extrude

from print import meshes, orientation
from print.meshes import MeshError, load_mesh
from print.orientation import CheckSettings, check_orientation


SETTINGS = CheckSettings(layer_height=0.2, first_layer_height=0.2, line_width=0.42, support_threshold_deg=30, nozzle_mm=0.4)


def _mesh(tmp_path: Path, shape, name: str = "part", rotate=(0.0, 0.0, 0.0)):
    path = tmp_path / f"{name}.step"
    export_step(shape, str(path))
    return load_mesh(path).oriented(rotate)


def _layer(*rings, turn: float = 0.0, shift=(0.0, 0.0)):
    """The thin places in one layer outline, on the raster a small part gets: rings of (x, y) points in mm,
    the first the outside and the rest holes, turned ``turn`` degrees about the origin and then shifted."""
    c, s = np.cos(np.radians(turn)), np.sin(np.radians(turn))
    segments = []
    for i, ring in enumerate(rings):
        points = np.array(ring, dtype=float) @ np.array([[c, s], [-s, c]]) + shift
        x, y = points.T
        if (np.dot(x, np.roll(y, -1)) > np.dot(np.roll(x, -1), y)) != (i == 0):
            points = points[::-1]  # the outside counterclockwise, holes clockwise: material on the left
        segments.append(np.stack([points, np.roll(points, -1, axis=0)], axis=1))
    segments = np.concatenate(segments)
    pitch = SETTINGS.line_width / 4
    winding, origin = orientation._raster(segments, pitch)
    return orientation._thin_places(segments, winding, origin, pitch, SETTINGS.min_wall_mm)


def _wall_with_rib(wall: float, rib: float, reach: float) -> list[tuple[float, float]]:
    """A 12 mm wall along x, ``wall`` thick, with a rib ``rib`` thick standing ``reach`` off its middle."""
    w, r = wall / 2, rib / 2
    return [(-6, -w), (6, -w), (6, w), (r, w), (r, w + reach), (-r, w + reach), (-r, w), (-6, w)]


def _wall_with_end(wall: float, angle: float) -> list[tuple[float, float]]:
    """A 12 mm wall along x, ``wall`` thick, its right end cut to a corner of ``angle`` degrees."""
    w = wall / 2
    return [(-6, -w), (6 + wall / np.tan(np.radians(angle)), -w), (6, w), (-6, w)]


def test_tee_overhangs_need_support_until_turned_over(tmp_path):
    tee = Pos(0, 0, 10) * Box(10, 10, 20) + Pos(0, 0, 22) * Box(40, 10, 4)
    upright = check_orientation(_mesh(tmp_path, tee), SETTINGS)
    assert upright.needs_support_mm2 == pytest.approx(300.0, abs=0.5)
    assert upright.bed_contact_mm2 == pytest.approx(100.0, abs=0.5)
    assert [u.kind for u in upright.undersides] == ["overhang", "overhang"]
    assert upright.undersides[0].span_mm == pytest.approx(15.0, abs=0.2)
    assert upright.undersides[0].thickness_mm == pytest.approx(4.0, abs=0.01)

    flipped = check_orientation(_mesh(tmp_path, tee, rotate=(180, 0, 0)), SETTINGS)
    assert flipped.needs_support_mm2 == 0
    assert flipped.bed_contact_mm2 == pytest.approx(400.0, abs=0.5)
    assert flipped.size_mm == (40.0, 10.0, 24.0)


def test_bridge_span_is_measured_between_the_walls_holding_it(tmp_path):
    # A 12 mm gap bridged by a 10 mm wide roof: the span is the gap, not the roof's width.
    bridge = Pos(-11, 0, 5) * Box(10, 10, 10) + Pos(11, 0, 5) * Box(10, 10, 10) + Pos(0, 0, 11) * Box(32, 10, 2)
    report = check_orientation(_mesh(tmp_path, bridge), SETTINGS)
    (underside,) = report.undersides
    assert underside.kind == "bridge"
    assert underside.span_mm == pytest.approx(12.0, abs=0.2)
    assert underside.thickness_mm == pytest.approx(2.0, abs=0.01)
    assert report.bed_contact_islands == 2
    assert any("bridge at print height 10.0 mm spans" in flag for flag in report.flags)


def test_ceiling_over_a_round_pocket_spans_its_diameter(tmp_path):
    cap = Pos(0, 0, 7.5) * Box(20, 20, 15) - Pos(0, 0, 5) * Cylinder(5.05, 10)
    (underside,) = check_orientation(_mesh(tmp_path, cap), SETTINGS).undersides
    assert underside.kind == "bridge"
    assert underside.span_mm == pytest.approx(10.1, abs=0.2)


def test_thin_fin_and_thin_shelf_are_flagged_with_their_size(tmp_path):
    part = Pos(0, 0, 5) * Box(20, 20, 10) + Pos(15, 0, 5) * Box(10, 0.6, 10) + Pos(0, 15, 9.6) * Box(20, 10, 0.8)
    report = check_orientation(_mesh(tmp_path, part), SETTINGS)
    (wall,) = report.thin_walls
    assert wall.thickness_mm == pytest.approx(0.6, abs=report.wall_check["pitch_mm"] + 0.01)
    assert wall.height_mm >= 9.5
    # The reported point lies on the fin (x 10..20, y -0.3..0.3), where its thickness was measured.
    assert 10.0 <= wall.model_xyz_mm[0] <= 20.0 and abs(wall.model_xyz_mm[1]) <= 0.3
    (shelf,) = report.undersides
    assert shelf.kind == "overhang" and shelf.thickness_mm == pytest.approx(0.8, abs=0.01)
    assert any("thin shelf" in flag for flag in report.flags)
    assert any("wall about" in flag for flag in report.flags)


def test_a_bed_face_split_into_two_heights_is_flagged(tmp_path):
    part = Pos(0, 0, 5) * Box(20, 20, 10) + Pos(15, 0, 5.1) * Box(10, 10, 9.8)
    report = check_orientation(_mesh(tmp_path, part), SETTINGS)
    (lifted,) = report.lifted_near_bed
    assert lifted.print_z_mm[0] == pytest.approx(0.2)
    assert lifted.area_mm2 == pytest.approx(100.0, abs=0.5)
    assert report.needs_support


def test_locations_are_reported_in_model_coordinates(tmp_path):
    # Turned onto its side, the fin's location still reads in the model's own frame.
    part = Pos(0, 0, 5) * Box(20, 20, 10) + Pos(15, 0, 5) * Box(10, 0.6, 10)
    mesh = _mesh(tmp_path, part, rotate=(0, 0, 90))
    (wall,) = check_orientation(mesh, SETTINGS).thin_walls
    assert 10.0 <= wall.model_xyz_mm[0] <= 20.0 and abs(wall.model_xyz_mm[1]) <= 0.3
    assert np.allclose(mesh.model_point(mesh.rotation @ np.array([1.0, 2.0, 3.0]) + mesh.offset), [1, 2, 3])


def test_open_meshes_are_refused(tmp_path):
    box = Box(10, 10, 10)
    path = tmp_path / "open.stl"
    export_stl(box, str(path))
    lines = path.read_bytes()
    # Drop the last triangle of the binary STL to open the mesh.
    count = int.from_bytes(lines[80:84], "little")
    path.write_bytes(lines[:80] + (count - 1).to_bytes(4, "little") + lines[84 : 84 + 50 * (count - 1)])
    with pytest.raises(MeshError, match="not a closed solid"):
        load_mesh(path)


def test_thin_rims_at_both_ends_of_a_tube_stay_separate_and_on_the_material(tmp_path):
    from build123d import GeomType, chamfer

    tube = Pos(0, 0, 15) * (Cylinder(10, 30) - Cylinder(8, 30))
    tube = chamfer([e for e in tube.edges().filter_by(GeomType.CIRCLE) if abs(e.radius - 10) < 1e-6], 1.5)
    report = check_orientation(_mesh(tmp_path, tube), SETTINGS)
    bottom, top = sorted(report.thin_walls, key=lambda wall: wall.print_z_mm[0])
    assert bottom.print_z_mm[1] < 2 and top.print_z_mm[0] > 28
    for wall in (bottom, top):
        x, y, _ = wall.model_xyz_mm
        assert 8.0 <= (x * x + y * y) ** 0.5 <= 10.0  # in the tube wall, not the empty bore
    assert not any("through print height" in flag for flag in report.flags)


def test_a_meshed_45_degree_chamfer_is_neither_an_overhang_nor_a_split_bed_face(tmp_path):
    from build123d import Axis, chamfer

    puck = Pos(0, 0, 10) * Cylinder(20, 20)
    puck = chamfer(puck.edges().group_by(Axis.Z)[0], 1.5)
    report = check_orientation(_mesh(tmp_path, puck), SETTINGS)
    assert report.overhang_review_mm2 == 0
    assert report.lifted_near_bed == [] and report.flags == []


def test_small_holes_are_measured_and_marks_are_only_counted(tmp_path):
    from build123d import Sphere

    plate = Pos(0, 0, 2) * Box(24, 10, 4) - Pos(-8, 0, 2) * Cylinder(0.3, 4) - Pos(0, 0, 2) * Cylinder(0.45, 4) - Pos(8, 0, 2) * Cylinder(1.5, 4)
    plate -= Pos(8, 4, 4) * Sphere(0.6)  # a marking dimple, 0.6 mm deep
    report = check_orientation(_mesh(tmp_path, plate), SETTINGS)
    assert report.hole_check["enclosed"] == 4 and report.hole_check["small_shallow"] == 1
    assert [hole.opens_at_mm for hole in report.holes] == [(), ()]
    narrow, wider = sorted(report.holes, key=lambda hole: hole.across_mm)
    pitch = report.hole_check["pitch_mm"]
    assert narrow.across_mm == pytest.approx(0.6, abs=pitch) and wider.across_mm == pytest.approx(0.9, abs=pitch)
    assert abs(narrow.model_xyz_mm[0] + 8) < 0.3 and abs(wider.model_xyz_mm[0]) < 0.3
    assert narrow.print_z_mm[0] < 0.2 and narrow.print_z_mm[1] > 3.8
    assert sum("mm across at its narrowest (under 1 mm" in flag for flag in report.flags) == 2


def test_the_small_hole_limit_follows_the_nozzle():
    from dataclasses import replace

    assert SETTINGS.small_hole_mm == 1.0
    assert replace(SETTINGS, nozzle_mm=0.6).small_hole_mm == pytest.approx(1.5)
    assert replace(SETTINGS, nozzle_mm=0.2).small_hole_mm == 1.0


def test_a_hole_that_opens_to_the_side_higher_up_is_flagged_for_its_step(tmp_path):
    # Enclosed below z = 5; above it a slot runs from the hole out through the side.
    slotted = Pos(0, 0, 5) * Box(20, 20, 10) - Pos(0, 0, 5) * Cylinder(3, 10) - Pos(5, 0, 7.5) * Box(10, 2, 5)
    report = check_orientation(_mesh(tmp_path, slotted), SETTINGS)
    (hole,) = report.holes
    assert hole.across_mm is None and hole.print_z_mm[1] == pytest.approx(4.9, abs=0.11)
    assert hole.opens_at_mm and hole.opens_at_mm[0] == pytest.approx(5.1, abs=0.11)
    assert abs(hole.model_xyz_mm[0]) < 0.3 and abs(hole.model_xyz_mm[1]) < 0.3
    assert any("runs to the outside at print height 5.1 mm" in flag and "leaves a step" in flag for flag in report.flags)


def test_a_hole_over_the_edge_of_an_overhang_has_no_step(tmp_path):
    # The flange's hole is enclosed wherever it exists; below it there is only air.
    flange = Pos(0, 0, 5) * Box(10, 10, 10) + Pos(10, 0, 9) * Box(20, 10, 2) - Pos(14, 0, 9) * Cylinder(2, 2)
    report = check_orientation(_mesh(tmp_path, flange), SETTINGS)
    assert report.hole_check["enclosed"] == 1 and report.holes == []
    assert not any("hole" in flag for flag in report.flags)


def test_identical_thin_walls_measure_alike_wherever_the_raster_falls(tmp_path):
    # A full-length slot leaves two 0.3 mm walls; the 0.105 mm raster fits one 2 pixels across and the other 3.
    rib = Pos(0, 0, 25) * Box(40, 20, 50) - Pos(0, 0, 37.5) * Box(40, 19.4, 25)
    report = check_orientation(_mesh(tmp_path, rib), SETTINGS)
    walls = report.thin_walls
    assert len(walls) == 2
    for wall in walls:
        assert wall.thickness_mm == pytest.approx(0.3, abs=0.02)
        assert 9.7 - 1e-6 <= abs(wall.model_xyz_mm[1]) <= 10.0 + 1e-6  # in a wall, where it was measured
    assert walls[0].thickness_mm == pytest.approx(walls[1].thickness_mm, abs=0.01)


def test_a_wall_just_over_the_limit_is_not_thin_at_any_angle(tmp_path):
    # 0.9 mm is over the 0.84 mm limit, though a raster turned 20 degrees to it reads it thin.
    fin = Pos(0, 0, 1) * Box(20, 20, 2) + Pos(0.03, 0.03, 5) * Rot(0, 0, 20) * Box(12, 0.9, 6)
    report = check_orientation(_mesh(tmp_path, fin), SETTINGS)
    assert report.thin_walls == [] and not any("wall about" in flag for flag in report.flags)


def test_a_thin_rib_or_spur_on_a_wall_just_over_the_limit_is_thin(tmp_path):
    # The 0.86 and 0.9 mm walls are over the 0.84 mm limit; the 0.3 mm rib and 0.4 mm spur standing off them are not.
    rib = Pos(-10, 0, 5) * (Box(12, 0.86, 6) + Pos(0, 4.43, 0) * Box(0.3, 8, 6))
    spur = Pos(10, 0, 5) * Rot(0, 0, 20) * (Box(12, 0.9, 6) + Pos(2, 1.95, 0) * Box(0.4, 3, 6))
    walls = check_orientation(_mesh(tmp_path, Pos(0, 0, 1) * Box(40, 30, 2) + rib + spur), SETTINGS).thin_walls
    on_rib, on_spur = sorted(walls, key=lambda wall: wall.thickness_mm)
    assert (on_rib.thickness_mm, on_spur.thickness_mm) == pytest.approx((0.3, 0.4), abs=0.01)
    # Each is reported where it was measured: on the rib, and on the spur in the spur's own frame.
    x, y, _ = on_rib.model_xyz_mm
    assert abs(x + 10) <= 0.15 and 0.43 <= y <= 8.43
    turn = np.radians(-20)
    x, y = np.array([[np.cos(turn), -np.sin(turn)], [np.sin(turn), np.cos(turn)]]) @ (np.array(on_spur.model_xyz_mm[:2]) - (10, 0))
    assert abs(x - 2) <= 0.2 and 0.45 <= y <= 3.45


def test_thin_walls_that_cross_or_turn_a_corner_are_measured_along_their_length(tmp_path):
    # Where two 0.5 mm walls cross, or 0.6 mm walls turn a corner, a chord across reads about 0.7-0.85 mm.
    cross = Pos(0, 0, 1) * Box(30, 30, 2) + Pos(0, 0, 5) * (Box(14, 0.5, 6) + Box(0.5, 14, 6))
    shell = Pos(40, 0, 5) * (Box(20, 14, 10) - Box(18.8, 12.8, 10))
    walls = check_orientation(_mesh(tmp_path, cross + shell), SETTINGS).thin_walls
    assert sorted(wall.thickness_mm for wall in walls) == pytest.approx([0.5, 0.6], abs=0.01)


def test_a_line_that_cuts_off_a_corner_of_a_wall_does_not_measure_it():
    # Through a point just inside a corner the shortest line across cuts the corner off: it read 0.06 mm at the
    # foot of this 0.3 mm rib on a 0.86 mm wall, and 0.13 mm at the 40-degree end of a 0.9 mm wall.
    readings = [[thickness for thickness, _, _ in _layer(_wall_with_rib(0.86, 0.3, 0.45), turn=turn, shift=(0.02, 0.04))] for turn in (0, 20, 45, 70)]
    assert readings[1] == pytest.approx([0.3], abs=0.01)
    assert all(found == pytest.approx([0.3] * len(found), abs=0.01) for found in readings)
    for turn in (0, 30, 45, 75):
        assert _layer(_wall_with_end(0.9, 40), turn=turn, shift=(0.03, 0.02)) == []
    # A tip sharper than TIP_DEG is thin near its point.
    (tip,) = _layer(_wall_with_end(0.9, 15))
    assert tip[0] < SETTINGS.min_wall_mm and tip[1][0] > 6


def test_separate_lumps_count_as_separate_solids_and_voids_do_not(tmp_path):
    # One STEP body, and one STL, holding two boxes: neither is an assembly of parts, but both print as two pieces.
    two = Compound([Pos(10, 10, 5) * Box(20, 20, 10), Pos(50, 10, 5) * Box(20, 20, 10)])
    export_stl(two, str(tmp_path / "two.stl"))
    stl = load_mesh(tmp_path / "two.stl")
    assert stl.bodies == 2
    report = check_orientation(_mesh(tmp_path, two, "two"), SETTINGS)
    assert report.bodies == 2 and any(flag.startswith("2 separate solids print as one object") for flag in report.flags)
    hollow = Box(20, 20, 20) - Box(10, 10, 10)
    assert _mesh(tmp_path, hollow, "hollow").bodies == 1


def test_inward_facing_triangles_are_refused(tmp_path):
    import trimesh

    box = trimesh.creation.box(extents=(20, 20, 10))
    faces = box.faces.copy()
    top = box.face_normals[:, 2] > 0.5
    faces[top] = faces[top][:, ::-1]  # the top faces into the box: still every edge shared by two triangles
    trimesh.Trimesh(box.vertices, faces, process=False).export(tmp_path / "flipped.stl")
    with pytest.raises(MeshError, match="some triangles face inwards"):
        load_mesh(tmp_path / "flipped.stl")


def test_a_separate_shell_facing_inwards_is_refused_unless_it_is_a_void(tmp_path):
    import trimesh

    # Each shell is wound consistently on its own, so only where it lies tells a void from a flipped part.
    outer = trimesh.creation.box(extents=(20, 20, 10))
    beside = trimesh.creation.box(extents=(10, 10, 10))
    beside.apply_translation((30, 0, 0))
    beside.invert()
    trimesh.util.concatenate([outer, beside]).export(tmp_path / "flipped.stl")
    with pytest.raises(MeshError, match="a separate shell faces inwards but lies inside no other"):
        load_mesh(tmp_path / "flipped.stl")
    inside = trimesh.creation.box(extents=(10, 10, 4))
    inside.invert()
    trimesh.util.concatenate([outer, inside]).export(tmp_path / "hollow.stl")
    assert load_mesh(tmp_path / "hollow.stl").bodies == 1


def test_a_step_that_cannot_be_read_is_a_mesh_error(tmp_path):
    (tmp_path / "bad.step").write_text("garbage")
    with pytest.raises(MeshError, match="could not be read as STEP"):
        load_mesh(tmp_path / "bad.step")


def test_a_step_is_meshed_once_and_then_read_from_the_cache(tmp_path, monkeypatch):
    path = tmp_path / "block.step"
    export_step(Pos(0, 0, 5) * Box(10, 10, 10), str(path))
    reads = []
    read = meshes.load_step_scene
    monkeypatch.setattr(meshes, "load_step_scene", lambda step: reads.append(step) or read(step))
    first, second = load_mesh(path), load_mesh(path)
    assert len(reads) == 1 and list((tmp_path / "cad-cache" / meshes.MESH_CACHE).iterdir())
    assert np.array_equal(first.vertices, second.vertices) and np.array_equal(first.faces, second.faces)
    assert second.bodies == first.bodies == 1
    export_step(Pos(0, 0, 6) * Box(10, 10, 12), str(path))  # a changed file is meshed afresh
    assert load_mesh(path).size[2] == pytest.approx(12) and len(reads) == 2


def test_without_trimesh_the_command_line_names_the_workbench_interpreter(tmp_path):
    launcher = Path(__file__).resolve().parents[1]
    code = f"import runpy, sys; sys.modules['trimesh'] = None; sys.argv = ['print', 'presets']; runpy.run_path({str(launcher)!r}, run_name='__main__')"
    result = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True, check=False)
    assert result.returncode == 1, result.stderr
    assert "scripts/print needs trimesh, which" in result.stderr and "run it with the workbench's Python interpreter" in result.stderr
