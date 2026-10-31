from itertools import combinations

from print.layout import Footprint, Rect, pack


AREA = Rect(30, 5, 320, 315)


def _clear(placements, gap):
    for a, b in combinations(placements, 2):
        assert not a.rect.grown(gap / 2 - 1e-6).overlaps(b.rect.grown(gap / 2 - 1e-6)), (a, b)


def test_parts_fit_inside_the_area_with_a_gap_between_them():
    items = [Footprint(i, 40 + 7 * (i % 5), 30 + 11 * (i % 3)) for i in range(14)]
    placed, unplaced = pack(items, AREA, [], gap=8)
    assert not unplaced
    assert sorted(p.key for p in placed) == list(range(14))
    assert all(AREA.contains(p.rect) for p in placed)
    _clear(placed, 8)


def test_keep_outs_stay_clear_by_the_gap():
    tower = Rect(40, 220, 100, 280)
    items = [Footprint(i, 60, 60) for i in range(12)]
    placed, _ = pack(items, AREA, [tower], gap=8)
    assert placed
    assert not any(p.rect.overlaps(tower.grown(8 - 1e-6)) for p in placed)


def test_what_does_not_fit_is_returned_not_dropped():
    placed, unplaced = pack([Footprint("big", 400, 50), Footprint("small", 20, 20)], AREA, [], gap=8)
    assert [p.key for p in placed] == ["small"]
    assert [u.key for u in unplaced] == ["big"]


def test_a_part_turns_to_fit_only_when_allowed():
    narrow = Rect(0, 0, 60, 200)
    placed, _ = pack([Footprint("long", 150, 40)], narrow, [], gap=8)
    assert placed[0].turned and placed[0].rect.width == 40
    placed, unplaced = pack([Footprint("long", 150, 40, can_turn=False)], narrow, [], gap=8)
    assert not placed and unplaced


def test_a_lone_part_is_centred():
    (placed,), _ = pack([Footprint("one", 50, 30)], AREA, [], gap=8)
    assert (placed.rect.x0 + placed.rect.x1) / 2 == (AREA.x0 + AREA.x1) / 2
    assert (placed.rect.y0 + placed.rect.y1) / 2 == (AREA.y0 + AREA.y1) / 2


def test_parts_keep_their_heading_when_they_fit():
    placed, _ = pack([Footprint(i, 60, 40) for i in range(4)], AREA, [], gap=8)
    assert not any(p.turned for p in placed)
