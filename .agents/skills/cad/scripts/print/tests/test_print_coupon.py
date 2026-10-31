import pytest
from build123d import GeomType

from print.coupon import ladder


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
