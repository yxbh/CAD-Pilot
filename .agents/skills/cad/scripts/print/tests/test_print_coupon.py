from pathlib import Path

import pytest
from build123d import GeomType

from print.coupon import calibration_ladder, ladder


def test_ladder_holes_step_through_the_clearances_with_dimple_marks():
    bar, rungs = ladder(10.0, [0.1, 0.2, 0.3], depth=6.0)
    assert [(rung.marks, rung.hole_mm) for rung in rungs] == [(1, 10.1), (2, 10.2), (3, 10.3)]
    radii = sorted(round(face.radius, 3) for face in bar.faces().filter_by(GeomType.CYLINDER))
    assert radii == [5.05, 5.1, 5.15]
    dimples = bar.faces().filter_by(GeomType.SPHERE)
    assert len(dimples) == 1 + 2 + 3
    assert bar.bounding_box().size.Z == pytest.approx(6.0)
    assert bar.is_valid


@pytest.mark.parametrize("clearances", [[], [0.1] * 10, [-10.5]])
def test_ladder_refuses_what_it_cannot_make(clearances):
    with pytest.raises(ValueError):
        ladder(10.0, clearances, depth=6.0)


@pytest.mark.parametrize("kind", ["holes", "pegs"])
def test_calibration_rungs_are_the_real_part_plus_their_compensation_on_each_side(kind):
    shape, rungs = calibration_ladder(kind, 3.0, [-0.05, 0.0, 0.1], depth=5.0)
    assert [(rung.marks, rung.value_mm, rung.size_mm) for rung in rungs] == [(1, -0.05, 2.9), (2, 0.0, 3.0), (3, 0.1, 3.2)]
    radii = sorted(round(face.radius, 3) for face in shape.faces().filter_by(GeomType.CYLINDER))
    assert radii == [1.45, 1.5, 1.6]
    assert len(shape.faces().filter_by(GeomType.SPHERE)) == 1 + 2 + 3
    assert shape.is_valid and len(shape.solids()) == 1
    # Holes go through a bar as deep as the part engages; pegs stand that tall on a base.
    assert shape.bounding_box().size.Z == pytest.approx(5.0 if kind == "holes" else 8.0)


@pytest.mark.parametrize("values", [[0.1, 0.1], [], [-1.6], [0.0, 1.0]])
def test_calibration_ladder_refuses_repeated_empty_or_vanishing_rungs(values):
    with pytest.raises(ValueError):
        calibration_ladder("holes", 3.0, values, depth=5.0)


@pytest.mark.parametrize("ladder", [["--clearances", "0.1"], ["--calibrate", "holes"]])
def test_a_coupon_is_written_only_as_step_and_refused_before_anything_else(tmp_path, monkeypatch, capsys, ladder):
    from print import cli

    monkeypatch.setattr(cli, "load_profile", lambda overrides=None: pytest.fail("the profile was read"))
    assert cli.main(["coupon", "-o", str(tmp_path / "ladder.stl"), "--diameter", "10", *ladder]) == 2
    assert "give -o a .step or .stp path, not ladder.stl" in capsys.readouterr().err
    assert not (tmp_path / "ladder.stl").exists()


def test_a_coupons_project_is_named_as_it_can_be_given_back(tmp_path, monkeypatch):
    from print.cli import _shown

    monkeypatch.chdir(tmp_path)
    assert _shown(tmp_path.resolve() / "coupons" / "petg-holes.3mf") == str(Path("coupons", "petg-holes.3mf"))
    assert _shown(tmp_path.resolve() / "my coupons" / "a.3mf") == '"' + str(Path("my coupons", "a.3mf")) + '"'
    elsewhere = tmp_path.resolve().parent / "a.3mf"
    assert _shown(elsewhere) == str(elsewhere)
