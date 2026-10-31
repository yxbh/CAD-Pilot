"""Part patterns, matched as CAD Explorer resolves its assembly steps."""

import unittest

from common.step_parts import StepPart, match_parts


def part(index: int, name: str, groups: tuple[str, ...] = ()) -> StepPart:
    return StepPart(f"o1.{index}", name, groups, index, None, None, ())


def names(found: tuple[list[StepPart], list[str]]) -> list[str]:
    return [item.name for item in found[0]]


class MatchPartsTests(unittest.TestCase):
    ANCHOR = (
        part(1, "TMAT base", ("TMAT anchor v3",)),
        part(2, "TMAT anchor plate", ("TMAT anchor v3", "anchor")),
        part(3, "TMAT anchor bolt", ("TMAT anchor v3", "anchor")),
    )

    def test_a_group_holding_every_part_never_matches(self) -> None:
        # "TMAT anchor *" was written for the anchor's parts; the top-level group "TMAT anchor v3" also fits it.
        self.assertEqual(["TMAT anchor plate", "TMAT anchor bolt"], names(match_parts(["TMAT anchor *"], self.ANCHOR)))
        self.assertEqual(["TMAT anchor plate", "TMAT anchor bolt"], names(match_parts(["anchor"], self.ANCHOR)))
        self.assertEqual(([], ["TMAT anchor v? (it matches only the whole assembly)"]), match_parts(["TMAT anchor v?"], self.ANCHOR))
        self.assertEqual(3, len(names(match_parts(["*"], self.ANCHOR))), "every part still matches by its own name")

    def test_a_lone_part_matches_by_its_name_and_not_by_its_group(self) -> None:
        lone = (part(1, "plate", ("kit",)),)
        self.assertEqual(["plate"], names(match_parts(["plate"], lone)))
        self.assertEqual(([], ["kit (it matches only the whole assembly)"]), match_parts(["kit"], lone))

    def test_only_star_and_question_mark_are_wildcards(self) -> None:
        parts = (part(1, "p[e]g"), part(2, "peg"))
        self.assertEqual(["p[e]g"], names(match_parts(["p[e]g"], parts)))
        self.assertEqual((["p[e]g", "peg"], ["washer"]), (names(match_parts(["p*g", "washer"], parts)), match_parts(["washer"], parts)[1]))


if __name__ == "__main__":
    unittest.main()
