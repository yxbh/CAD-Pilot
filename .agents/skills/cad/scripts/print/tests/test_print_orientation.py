from pathlib import Path

import numpy as np
import pytest
from build123d import Box, Cylinder, Pos, export_step, export_stl

from print.meshes import MeshError, load_mesh
from print.orientation import CheckSettings, check_orientation


SETTINGS = CheckSettings(layer_height=0.2, first_layer_height=0.2, line_width=0.42, support_threshold_deg=30, nozzle_mm=0.4)


def _mesh(tmp_path: Path, shape, name: str = "part", rotate=(0.0, 0.0, 0.0)):
    path = tmp_path / f"{name}.step"
    export_step(shape, str(path))
    return load_mesh(path).oriented(rotate)


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
