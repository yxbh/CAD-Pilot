from pathlib import Path

import numpy as np
import pytest
from build123d import Box, Cylinder, Pos, export_step, export_stl

from print.meshes import MeshError, load_mesh
from print.orientation import CheckSettings, check_orientation


SETTINGS = CheckSettings(layer_height=0.2, first_layer_height=0.2, line_width=0.42, support_threshold_deg=30)


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
    assert wall.model_xyz_mm[0] == pytest.approx(15.0, abs=0.5)
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
    assert wall.model_xyz_mm[0] == pytest.approx(15.0, abs=0.5)
    assert wall.model_xyz_mm[1] == pytest.approx(0.0, abs=0.5)
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
