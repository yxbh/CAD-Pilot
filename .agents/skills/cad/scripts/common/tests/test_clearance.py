"""Pose clearance on parts built in memory: pair selection, the horizon and its lower bounds."""

import unittest

import build123d as bd

from common.clearance import check_clearance, pair_status, read_pose_set
from common.step_parts import StepPart, StepParts

IDENTITY = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)


def part(index: int, name: str, shape=None, groups: tuple[str, ...] = ()) -> StepPart:
    native = shape.wrapped if shape is not None else None
    return StepPart(f"o1.{index}", name, groups, index, native, native, IDENTITY)


class PairSelectionTests(unittest.TestCase):
    def test_pairs_come_in_step_order_with_the_first_entry_setting_the_gap(self) -> None:
        parts = StepParts("kit", tuple(part(i, f"p{i}") for i in range(1, 12)))
        pose_set = read_pose_set({"pairs": [["p11", "p2", 0.5], ["*", "p2"], ["p10", "p11"]]}, parts)
        names = [(a.name, b.name, gap) for a, b, gap in pose_set.pairs]
        self.assertEqual(("p1", "p2", None), names[0])
        self.assertIn(("p2", "p11", 0.5), names)
        self.assertEqual(("p10", "p11", None), names[-1])
        self.assertEqual(11, len(names))

    def test_a_group_someone_labelled_covers_its_parts_and_the_file_name_does_not(self) -> None:
        parts = StepParts("box", (part(1, "box"), part(2, "lid", groups=("cover",)), part(3, "hinge", groups=("cover",))))
        moved = read_pose_set([{"name": "open", "move": {"cover": (0, 0, 5)}}], parts).poses[0][1]
        self.assertEqual({"o1.2", "o1.3"}, set(moved))
        moved = read_pose_set([{"name": "up", "move": {"box": (0, 0, 5)}}], parts).poses[0][1]
        self.assertEqual({"o1.1"}, set(moved))


class HorizonTests(unittest.TestCase):
    def test_pairs_beyond_the_horizon_are_bounded_not_measured(self) -> None:
        parts = StepParts("pair", (part(1, "a", bd.Box(10, 10, 10)), part(2, "b", bd.Pos(17, 0, 0) * bd.Box(10, 10, 10))))
        pose_set = read_pose_set([{"name": "closer", "move": {"b": (-1, 0, 0)}}], parts)
        (result,) = check_clearance(pose_set, horizon=5)
        self.assertIsNone(result.distance)
        self.assertAlmostEqual(6.0, result.at_least, places=3)
        self.assertEqual(0, result.measured)
        self.assertEqual("clear", pair_status(result))

    def test_a_skipped_pose_closer_than_every_measured_one_leaves_only_its_bound(self) -> None:
        # Diagonal spheres: their boxes come within the horizon but the spheres stay 6.97 mm apart; moved onto
        # the X axis they are 6 mm apart, with boxes that are 6 mm apart too, beyond the horizon.
        parts = StepParts("balls", (part(1, "a", bd.Sphere(5)), part(2, "b", bd.Pos(12, 12, 0) * bd.Sphere(5))))
        pose_set = read_pose_set([{"name": "on axis", "move": {"b": (4, -12, 0)}}], parts)
        (result,) = check_clearance(pose_set, horizon=5)
        self.assertEqual(1, result.measured)
        self.assertIsNone(result.distance)
        self.assertAlmostEqual(6.0, result.at_least, places=3)

    def test_a_required_gap_beyond_the_horizon_is_still_measured(self) -> None:
        parts = StepParts("pair", (part(1, "a", bd.Box(10, 10, 10)), part(2, "b", bd.Pos(17, 0, 0) * bd.Box(10, 10, 10))))
        pose_set = read_pose_set({"min_gap": 8}, parts)
        (result,) = check_clearance(pose_set, horizon=5)
        self.assertAlmostEqual(7.0, result.distance, places=6)
        self.assertEqual("tight", pair_status(result))


if __name__ == "__main__":
    unittest.main()
