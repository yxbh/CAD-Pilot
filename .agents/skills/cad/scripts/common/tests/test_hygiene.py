"""Geometry hygiene findings on shapes whose faults are known by construction."""

import unittest

import build123d as bd
from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse

from common.hygiene import check_part


def checks(report) -> list[str]:
    return [finding.check for finding in report.findings]


class HygieneTests(unittest.TestCase):
    def test_rounded_box_is_clean_at_its_radius(self) -> None:
        box = bd.fillet(bd.Box(10, 10, 10).edges(), 1)
        report = check_part(box.wrapped, round_radius=1)
        self.assertEqual([], report.findings)
        self.assertEqual((0, 0, 20), (report.convex_edges, report.sharp_edges, report.rounds))
        self.assertAlmostEqual(1.0, report.smallest_round)

    def test_rounds_below_the_comfort_radius_are_reported_by_face(self) -> None:
        box = bd.fillet(bd.Box(10, 10, 10).edges(), 1)
        report = check_part(box.wrapped, round_radius=1.5)
        self.assertEqual(["small-round"] * 20, checks(report))
        self.assertTrue(all(len(finding.faces) == 1 for finding in report.findings))

    def test_sharp_edges_are_counted_and_reported_only_against_a_radius(self) -> None:
        plate = bd.Box(60, 40, 4) - bd.Cylinder(2.5, 6)
        counted = check_part(plate.wrapped)
        self.assertEqual([], counted.findings)
        self.assertEqual(14, counted.sharp_edges)  # 12 box edges and the hole's two rims
        reported = check_part(plate.wrapped, round_radius=0.5)
        self.assertEqual(["sharp-edge"] * 14, checks(reported))
        self.assertTrue(all(len(finding.edges) == 1 and finding.at is not None for finding in reported.findings))

    def test_concave_edges_are_not_sharp(self) -> None:
        corner = bd.Box(20, 10, 5, align=bd.Align.MIN) + bd.Box(5, 10, 20, align=bd.Align.MIN)
        report = check_part(corner.wrapped, round_radius=1)
        # An L-shaped prism: 18 edges, of which only the inside corner is concave.
        self.assertEqual((18, 17, 17), (report.edges, report.convex_edges, report.sharp_edges))

    def test_faces_left_split_on_one_surface_are_grouped(self) -> None:
        left, right = bd.Box(10, 10, 10), bd.Pos(10, 0, 0) * bd.Box(10, 10, 10)
        unfused = BRepAlgoAPI_Fuse(left.wrapped, right.wrapped).Shape()
        report = check_part(unfused)
        self.assertEqual(["split-face"] * 4, checks(report))
        self.assertTrue(all(len(finding.faces) == 2 for finding in report.findings))
        self.assertEqual([], check_part(bd.Shape.cast(unfused).clean().wrapped).findings)

    def test_touching_bodies_that_were_never_fused_are_separate_solids(self) -> None:
        pair = bd.Compound([bd.Box(10, 10, 10), bd.Pos(10, 0, 0) * bd.Box(10, 10, 10)])
        report = check_part(pair.wrapped)
        self.assertEqual(["solids"], checks(report))
        self.assertEqual(2, report.solids)

    def test_sliver_faces_and_short_edges(self) -> None:
        fin = bd.Box(10, 10, 10) + bd.Pos(5.005, 0, 1) * bd.Box(0.01, 10, 12)
        report = check_part(fin.wrapped)
        self.assertIn("sliver-face", checks(report))
        self.assertIn("short-edge", checks(report))
        self.assertEqual([], check_part(fin.wrapped, sliver=0.005).findings)

    def test_an_open_shell_has_no_solid(self) -> None:
        shell = bd.Shell(bd.Box(10, 10, 10).faces()[:5])
        report = check_part(shell.wrapped)
        self.assertEqual("no-solid", report.findings[0].check)
        self.assertIn("open-edge", checks(report))


if __name__ == "__main__":
    unittest.main()
