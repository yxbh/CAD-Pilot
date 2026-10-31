from types import SimpleNamespace

import numpy as np
import pytest

from print.bambu3mf import _transform
from print.job import parse_job
from print.layout import Rect
from print.plan import Instance, PlanError, _keep_outs, _pack_plates, _reach, _tower


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
        SimpleNamespace(mesh=SimpleNamespace(size=np.array([w, d, 10.0])), slot=SimpleNamespace(number=1), uses_interface=uses_interface, spec=SimpleNamespace(name=f"part {i}"))
        for i, (w, d) in enumerate(sizes)
    ]


AREA = Rect(30, 5, 320, 315)
TOWER = Rect(40, 220, 100, 280)


def _job(data, tmp_path):
    return parse_job(data, base=tmp_path, default_output=tmp_path / "job.3mf")


def test_auto_plates_are_numbered_after_the_job(tmp_path):
    job = _job({"name": "Job", "parts": [{"file": "a.step", "copies": 6}]}, tmp_path)
    plates = _pack_plates(_parts((140, 140)), job, AREA, [], TOWER, TOWER, None)
    assert [plate.name for plate in plates] == ["Job 1", "Job 2"]
    assert sum(len(plate.instances) for plate in plates) == 6


def test_a_part_too_big_for_any_plate_says_so(tmp_path):
    job = _job({"plates": [{"name": "P", "parts": [{"file": "a.step"}, {"file": "b.step"}]}]}, tmp_path)
    with pytest.raises(PlanError, match=r"part 1 \(400.0 x 50.0 mm as printed\) does not fit the plate"):
        _pack_plates(_parts((40, 40), (400, 50)), job, AREA, [], TOWER, TOWER, None)


def test_a_full_named_plate_names_what_did_not_fit(tmp_path):
    job = _job({"plates": [{"name": "P", "parts": [{"file": "a.step", "copies": 5}]}]}, tmp_path)
    with pytest.raises(PlanError, match="plate 'P' is full: part 0 do not fit beside the rest"):
        _pack_plates(_parts((140, 140)), job, AREA, [], TOWER, TOWER, None)


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
