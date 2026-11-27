from types import SimpleNamespace

import numpy as np
import pytest

from print.bambu3mf import _transform
from print.job import parse_job
from print.layout import Rect, outline_clear
from print.plan import Instance, PlanError, _keep_outs, _outline, _pack_plates, _project_settings, _reach, _tower
from print.report import plate_lines


# Bed settings as Bambu Studio 02.08's presets and the app's tower defaults give them.
X1C = {"printable_area": ["0x0", "256x0", "256x256", "0x256"], "bed_exclude_area": ["0x0", "18x0", "18x28", "0x28"], "prime_tower_width": "35", "prime_tower_brim_width": "3"}
A1_MINI = {"printable_area": ["0x0", "180x0", "180x180", "0x180"], "bed_exclude_area": [], "wipe_tower_x": ["15"], "wipe_tower_y": ["220"], "prime_tower_width": "35", "prime_tower_brim_width": "3"}
H2D = {
    "printable_area": ["0x0", "350x0", "350x320", "0x320"],
    "extruder_printable_area": ["0x0,325x0,325x320,0x320", "25x0,350x0,350x320,25x320"],
    "wrapping_exclude_area": ["145x310", "256x310", "256x326", "145x326"],
    "wipe_tower_x": ["15"],
    "wipe_tower_y": ["220"],
    "prime_tower_width": "60",
    "prime_tower_brim_width": "-1",
}
P2S = {"printable_area": ["0x0", "256x0", "256x256", "0x256"], "wrapping_exclude_area": ["153x256", "216x256", "216x235", "153x235"], "prime_tower_width": "35", "prime_tower_brim_width": "3"}


def test_bed_exclusions_keep_their_corner_at_the_origin():
    assert _keep_outs(X1C) == [Rect(0, 0, 18, 28)]
    assert _keep_outs({"bed_exclude_area": ["0x0"]}) == []
    assert _keep_outs({"bed_exclude_area": ["0x0,18x0,18x28,0x28,0x0"]}) == [Rect(0, 0, 18, 28)]
    assert _keep_outs(H2D) == [Rect(145, 310, 256, 326)]


@pytest.mark.parametrize("settings", [X1C, A1_MINI, H2D, P2S], ids=["X1C", "A1 mini", "H2D", "P2S"])
def test_the_tower_stays_on_the_bed_in_every_nozzles_reach_and_clear_of_exclusions(settings):
    reach = _reach(settings)
    keep_out = _keep_outs(settings)
    tower, kept_clear = _tower(settings, reach, keep_out)
    size = float(settings["prime_tower_width"])
    assert tower.width == tower.depth == size
    assert reach.contains(tower.grown(15 - 1e-9))
    assert not any(kept_clear.overlaps(rect) for rect in keep_out)


def test_tower_corners_for_known_beds():
    # The H2D's default x sits in the left nozzle's strip; the A1 mini's default y is off its bed.
    assert _tower(H2D, _reach(H2D), _keep_outs(H2D))[0] == Rect(40, 220, 100, 280)
    assert _tower(A1_MINI, _reach(A1_MINI), [])[0] == Rect(15, 130, 50, 165)
    assert _reach(H2D) == Rect(25, 0, 325, 320)


def _parts(*sizes, uses_interface=False):
    return [
        SimpleNamespace(mesh=_box(w, d), slot=SimpleNamespace(number=1), uses_interface=uses_interface, spec=SimpleNamespace(name=f"part {i}"))
        for i, (w, d) in enumerate(sizes)
    ]


def _box(w, d, corners=None):
    """A stand-in mesh: a box, or with ``corners`` a prism over that outline."""
    xy = corners or [(0, 0), (w, 0), (w, d), (0, d)]
    return SimpleNamespace(size=np.array([w, d, 10.0]), vertices=np.array([(x, y, z) for x, y in xy for z in (0.0, 10.0)]))


AREA = Rect(30, 5, 320, 315)
BED = Rect(0, 0, 350, 320)
REACH = Rect(25, 0, 325, 320)
TOWER = Rect(40, 220, 100, 280)


def _job(data, tmp_path):
    return parse_job(data, base=tmp_path, default_output=tmp_path / "job.3mf")


def test_auto_plates_are_numbered_after_the_job(tmp_path):
    job = _job({"name": "Job", "parts": [{"file": "a.step", "copies": 6}]}, tmp_path)
    plates = _pack_plates(_parts((140, 140)), job, AREA, [], TOWER, TOWER, None, BED, REACH)
    assert [plate.name for plate in plates] == ["Job 1", "Job 2"]
    assert sum(len(plate.instances) for plate in plates) == 6


def test_a_part_too_big_for_any_plate_says_so(tmp_path):
    job = _job({"plates": [{"name": "P", "parts": [{"file": "a.step"}, {"file": "b.step"}]}]}, tmp_path)
    with pytest.raises(PlanError, match=r"part 1 \(400.0 x 50.0 mm as printed\) does not fit the plate"):
        _pack_plates(_parts((40, 40), (400, 50)), job, AREA, [], TOWER, TOWER, None, BED, REACH)


def test_a_full_named_plate_names_what_did_not_fit(tmp_path):
    job = _job({"plates": [{"name": "P", "parts": [{"file": "a.step", "copies": 5}]}]}, tmp_path)
    with pytest.raises(PlanError, match="plate 'P' is full: part 0 do not fit beside the rest"):
        _pack_plates(_parts((140, 140)), job, AREA, [], TOWER, TOWER, None, BED, REACH)


def test_a_turned_part_lands_on_its_rectangle():
    bed = Rect(0, 0, 350, 320)
    plan = SimpleNamespace(plates=[None, None], bed=bed)
    width, depth = 30.0, 10.0
    instance = Instance(0, 1, Rect(100, 50, 100 + depth, 50 + width), True)
    m = [float(v) for v in _transform(plan, 1, instance).split()]
    matrix = np.array([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]], [m[9], m[10], m[11]]])
    corners = np.array([[x, y, 0.0, 1.0] for x in (0, width) for y in (0, depth)]) @ matrix
    origin_x = 350 * 1.2  # the second plate sits one column to the right
    assert corners[:, 0].min() == pytest.approx(origin_x + 100) and corners[:, 0].max() == pytest.approx(origin_x + 110)
    assert corners[:, 1].min() == pytest.approx(50) and corners[:, 1].max() == pytest.approx(80)


# A 256 mm bed with a 35 mm tower in its far left corner.
SMALL_AREA, SMALL_BED = Rect(5, 5, 251, 251), Rect(0, 0, 256, 256)
SMALL_TOWER = Rect(15, 190, 50, 225)
# A bar lying corner to corner of a 236 mm square, low left to high right: the other two corners stay free.
DIAGONAL = [(20, 0), (236, 216), (216, 236), (0, 20)]
INTERFACE = SimpleNamespace(number=2)


def _bar(uses_interface=True):
    parts = _parts((236, 236), uses_interface=uses_interface)
    parts[0].mesh = _box(236, 236, DIAGONAL)
    return parts


def _placed(tmp_path, plate, parts=None, keep_out=(), reach=SMALL_BED):
    job = _job({"plates": [{"name": "P", **plate}]}, tmp_path)
    return _pack_plates(parts or _bar(), job, SMALL_AREA, list(keep_out), SMALL_TOWER, SMALL_TOWER.grown(8), INTERFACE, SMALL_BED, reach)


def test_an_outline_is_counter_clockwise_from_the_footprints_low_corner():
    outline = _outline(_box(236, 236, DIAGONAL))
    assert sorted(outline) == sorted((float(x), float(y)) for x, y in DIAGONAL)
    assert sum(ax * by - bx * ay for (ax, ay), (bx, by) in zip(outline, outline[1:] + outline[:1])) > 0
    assert outline_clear(outline, Rect(0, 180, 40, 236)) and not outline_clear(outline, Rect(100, 100, 120, 120))
    assert not outline_clear(outline, Rect(-50, -50, 300, 300)) and outline_clear(outline, Rect(236, 0, 300, 300))


def test_a_part_goes_where_the_job_puts_it_with_the_plates_own_tower(tmp_path):
    (plate,) = _placed(tmp_path, {"tower": [200, 20], "parts": [{"file": "a.step", "at": [18, 17], "turn": True}]})
    # Inside the layout's edge margin, on the bed, never turned; the tower is the plate's, not the default.
    assert plate.instances[0].rect == Rect(18, 17, 254, 253) and not plate.instances[0].turned
    assert plate.tower == plate.tower_spot == Rect(200, 20, 235, 55) and plate.warnings == []
    # The default tower's corner is free too, though the part's rectangle covers it.
    (plate,) = _placed(tmp_path, {"parts": [{"file": "a.step", "at": [10, 10]}]})
    assert plate.tower == SMALL_TOWER and plate.warnings == []


def test_a_placed_part_or_tower_off_the_bed_is_refused(tmp_path):
    with pytest.raises(PlanError, match=r"part 0 \(236.0 x 236.0 mm as printed\) at \[22, 10\] spans X 22.0..258.0 and Y 10.0..246.0 mm; the bed is X 0..256"):
        _placed(tmp_path, {"parts": [{"file": "a.step", "at": [22, 10]}]})
    with pytest.raises(PlanError, match=r"plate 'P': tower \[230, 20\] puts the 35 mm prime tower outside X 0..256 and Y 0..256 mm, the area every nozzle reaches"):
        _placed(tmp_path, {"tower": [230, 20], "parts": [{"file": "a.step", "at": [10, 10]}]})
    with pytest.raises(PlanError, match="outside X 25..256"):
        _placed(tmp_path, {"tower": [20, 180], "parts": [{"file": "a.step", "at": [10, 10]}]}, reach=Rect(25, 0, 256, 256))
    with pytest.raises(PlanError, match=r"tower \[150, 215\] puts the 35 mm prime tower on an area of the bed the printer excludes"):
        _placed(tmp_path, {"tower": [150, 215], "parts": [{"file": "a.step", "at": [10, 10]}]}, keep_out=[Rect(153, 235, 216, 256)])


@pytest.mark.parametrize(
    "plate, options, warning",
    [
        ({"tower": [100, 100]}, {}, "part 0's outline overlaps the prime tower's reserved 35 mm square; the printed tower is usually narrower"),
        ({"tower": [15, 75]}, {}, "part 0 is within 8 mm of the prime tower's reserved square, where the tower's brim can reach"),
        ({}, {"keep_out": [Rect(153, 225, 216, 256)]}, "part 0 overlaps an area of the bed the printer excludes"),
        ({}, {"reach": Rect(25, 0, 256, 256)}, "part 0 is partly outside the area every nozzle reaches"),
        ({"tower": [200, 4]}, {}, "the prime tower's 8 mm brim leaves the bed or overlaps an area the printer excludes"),
    ],
)
def test_what_the_layout_would_have_avoided_is_a_warning_on_the_plate(tmp_path, plate, options, warning):
    (planned,) = _placed(tmp_path, {**plate, "parts": [{"file": "a.step", "at": [18, 17]}]}, **options)
    assert planned.warnings == [warning]
    plan = SimpleNamespace(plates=[planned], instance_name=lambda instance: "part 0")
    assert f"    ! {warning}" in plate_lines(plan)


def test_a_plate_that_prints_no_tower_is_not_checked_against_one(tmp_path):
    (plate,) = _placed(tmp_path, {"tower": [100, 100], "parts": [{"file": "a.step", "at": [18, 17]}]}, _bar(uses_interface=False))
    assert plate.warnings == [] and plate.tower is None and plate.tower_spot == Rect(100, 100, 135, 135)


def test_other_parts_pack_clear_of_a_placed_parts_rectangle(tmp_path):
    job = _job({"plates": [{"name": "P", "parts": [{"file": "a.step", "at": [50, 50]}, {"file": "b.step", "copies": 3}]}]}, tmp_path)
    (plate,) = _pack_plates(_parts((100, 100), (60, 60), uses_interface=True), job, AREA, [], TOWER, TOWER.grown(8), INTERFACE, BED, REACH)
    placed, *others = plate.instances
    assert placed.rect == Rect(50, 50, 150, 150) and len(others) == 3 and plate.tower == TOWER
    for other in others:
        assert not other.rect.overlaps(placed.rect.grown(8 - 1e-6)) and not other.rect.overlaps(TOWER.grown(16 - 1e-6))
    # A placed part whose rectangle leaves no room fills the plate, even where its outline leaves corners free.
    with pytest.raises(PlanError, match="plate 'P' is full: part 1 do not fit beside the rest"):
        both = _parts((236, 236), (30, 30))
        both[0].mesh = _box(236, 236, DIAGONAL)
        _placed(tmp_path, {"parts": [{"file": "a.step", "at": [10, 10]}, {"file": "b.step"}]}, both)
    # Two placed parts may overlap; the plate says so.
    job = _job({"plates": [{"name": "P", "parts": [{"file": "a.step", "at": [40, 40]}, {"file": "b.step", "at": [100, 100]}]}]}, tmp_path)
    (plate,) = _pack_plates(_parts((100, 100), (60, 60)), job, AREA, [], TOWER, TOWER.grown(8), None, BED, REACH)
    assert plate.warnings == ["part 1 and part 0 are placed over each other's rectangle"]


def test_each_plate_keeps_its_tower_spot_in_the_project(tmp_path):
    job = _job({"plates": [{"name": "P", "tower": [200, 20], "parts": [{"file": "a.step"}]}, {"name": "Q", "parts": [{"file": "b.step"}]}]}, tmp_path)
    first, second = _pack_plates(_parts((40, 40), (40, 40)), job, SMALL_AREA, [], SMALL_TOWER, SMALL_TOWER.grown(8), None, SMALL_BED, SMALL_BED)
    # Neither plate prints a tower; a filament added in the app still finds it where the job put it.
    assert first.tower is None and first.tower_spot == Rect(200, 20, 235, 55) and second.tower_spot == SMALL_TOWER
    settings = _settings({}, [first.tower_spot, second.tower_spot])
    assert (settings["wipe_tower_x"], settings["wipe_tower_y"]) == (["200", "15"], ["20", "190"])


def _settings(process_settings, towers=(SMALL_TOWER,)):
    profile = SimpleNamespace(support_type="tree(auto)", bed_type="Textured PEI Plate", process_settings=process_settings)
    resolved = {"resolution": "0.012", "slice_closing_radius": "0.049", "wall_loops": "3", "enable_support": "0", "support_type": "tree(auto)"}
    system = {"resolution": "0.012", "wall_loops": "2", "enable_support": "0", "support_type": "tree(auto)"}
    return _project_settings(resolved, profile, [SimpleNamespace(number=1, colour="#FFFFFF")], None, system, list(towers))


def test_changed_settings_are_listed_against_the_preset_or_bambus_own_default():
    # Bambu Studio keeps a project's process value only when it is listed. The preset file holds no closing
    # radius, so that is compared with the app's default; the preset's wall count wins over the app's.
    settings = _settings({"resolution": "0.003", "slice_closing_radius": "0.01", "wall_loops": "2", "not_a_setting": "1"})
    assert settings["different_settings_to_system"] == ["enable_support;resolution;slice_closing_radius", "", ""]
    assert _settings({"slice_closing_radius": "0.049"})["different_settings_to_system"] == ["enable_support", "", ""]
