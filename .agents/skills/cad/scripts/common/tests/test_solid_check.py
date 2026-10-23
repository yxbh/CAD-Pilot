"""scripts/step reports generated solids it cannot vouch for, and still writes them.

Fake workers stand in for the boolean kernel where a test needs a check that
hangs or fails; the end-to-end cases run ``scripts/step`` on small models.
"""

import io
import subprocess
import sys
import tempfile
import textwrap
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from common import generation as cad_generation
from common.cli_logging import CliLogger
from common.solid_check import CheckedSolid, KernelCheck, KernelReport
from common.step_scene import LoadedStepScene


SCRIPTS_ROOT = Path(__file__).resolve().parents[2]

# Reads the worker request and defines emit(), like the real worker's protocol.
FAKE_WORKER = textwrap.dedent(
    """\
    import json, sys, time
    request = json.load(sys.stdin)
    targets = request["targets"]

    def emit(message):
        print("cad-solid-check " + json.dumps(message), flush=True)

    def done(index, verdict="sound"):
        emit({"done": index, "label": targets[index][2], "verdict": verdict, "faults": [], "detail": "", "from_step": False})

    """
)


def _two_part_scene() -> LoadedStepScene:
    import build123d

    shapes = [build123d.Box(1, 1, 1), build123d.Pos(5, 0, 0) * build123d.Cylinder(1, 2)]
    return LoadedStepScene(
        step_path=Path("cup.step"),
        roots=[],
        prototype_shapes={index: shape.wrapped for index, shape in enumerate(shapes)},
        prototype_names={0: "lid", 1: "knob"},
    )


class KernelCheckBudgetTests(unittest.TestCase):
    def _report(self, worker: str, *, part_budget: float = 0.5, total_budget: float = 20.0) -> tuple[KernelCheck, KernelReport]:
        check = KernelCheck(
            Path("cup.step"),
            _two_part_scene(),
            "cup.py",
            part_budget=part_budget,
            total_budget=total_budget,
            command=[sys.executable, "-c", FAKE_WORKER + textwrap.dedent(worker)],
        )
        return check, check.report()

    def test_a_part_over_its_budget_is_abandoned_and_the_rest_still_checked(self) -> None:
        check, report = self._report(
            """\
            for index in range(request["start"], len(targets)):
                emit({"start": index, "label": targets[index][2]})
                if index == 0:
                    time.sleep(60)
                done(index)
            """
        )

        self.assertEqual(
            [CheckedSolid('part "lid" in cup.py', "timeout"), CheckedSolid('part "knob" in cup.py', "sound")],
            report.solids,
        )
        self.assertEqual((0, None), (report.unchecked, report.failure))
        self.assertIsNone(check._brep_path, "the copied solids are removed")

    def test_the_total_budget_stops_the_check(self) -> None:
        _check, report = self._report(
            """\
            emit({"start": 0, "label": targets[0][2]})
            time.sleep(60)
            """,
            part_budget=30.0,
            total_budget=0.5,
        )

        self.assertEqual(([], 2), (report.solids, report.unchecked))

    def test_a_worker_that_dies_is_reported(self) -> None:
        _check, report = self._report(
            """\
            done(0)
            print("Segmentation fault", file=sys.stderr)
            sys.exit(139)
            """
        )

        self.assertEqual([CheckedSolid('part "lid" in cup.py', "sound")], report.solids)
        self.assertEqual(1, report.unchecked)
        self.assertIn("Segmentation fault", report.failure)


class SolidCheckReportTests(unittest.TestCase):
    def test_report_wording(self) -> None:
        kernel = SimpleNamespace(
            part_budget=10.0,
            total_budget=30.0,
            report=lambda: KernelReport(
                solids=[
                    CheckedSolid("handle.py", "unsound", ("BOPAlgo_SelfIntersect",) * 3),
                    CheckedSolid('part "lid" in kit.py', "unsound", ("BOPAlgo_SelfIntersect",), from_step=True),
                    CheckedSolid('part "pin" in kit.py', "unsound", ("BOPAlgo_NotValid",)),
                    CheckedSolid('part "ring" in kit.py', "inconclusive", detail="BOPAlgo_OperationAborted"),
                    CheckedSolid('part "coil" in kit.py', "timeout"),
                    CheckedSolid('part "box" in kit.py', "sound"),
                ],
                unchecked=2,
            ),
        )
        stream = io.StringIO()
        cad_generation._report_solid_checks(
            SimpleNamespace(source_ref="kit.py"),
            ["kit.py is inside out: its faces point inward, so its volume is negative"],
            kernel,
            logger=CliLogger("scripts/step", stream=stream),
        )

        consequence = "Slicers and later booleans may fail on it; the outputs were still written."
        skip = "Pass --no-solid-check to skip the check."
        self.assertEqual(
            [
                f"[scripts/step] warning: kit.py is inside out: its faces point inward, so its volume is negative. {consequence}",
                "[scripts/step] warning: handle.py is not a sound solid: 3 self-intersections, "
                f"where its surfaces cross or fold through each other. {consequence}",
                '[scripts/step] warning: part "lid" in kit.py is not a sound solid as read back from its STEP: '
                f"1 self-intersection, where its surfaces cross or fold through each other. {consequence}",
                f'[scripts/step] warning: part "pin" in kit.py is not a sound solid: its topology is invalid. {consequence}',
                '[scripts/step] notice: could not check whether part "ring" in kit.py is a sound solid: '
                "the boolean kernel could not finish.",
                f'[scripts/step] notice: could not check whether part "coil" in kit.py is a sound solid within 10 s. {skip}',
                f"[scripts/step] notice: 2 solids were not checked in kit.py within 30 s. {skip}",
            ],
            stream.getvalue().splitlines(),
        )


FOLDED_HANDLE = textwrap.dedent(
    """\
    import build123d as bd


    def folded_handle():
        # A 6 mm wide profile swept around a 2.7 mm bend: its inner side folds through itself.
        with bd.BuildPart() as handle:
            with bd.BuildLine(bd.Plane.XZ) as path:
                bd.Spline((38, 22), (62, 30), (64, 52), (42, 60), tangents=((1, 0.2), (-1, 0.1)))
            with bd.BuildSketch(path.line ^ 0):
                bd.RectangleRounded(6, 9, 1.5)
            bd.sweep()
        return handle.part
    """
)

MODELS = {
    # The kernel cannot finish checking this block as modelled, because of the
    # engraved letter, so the fold is only found on the solid read back from STEP.
    "lettered_block": FOLDED_HANDLE + textwrap.dedent(
        """\


        def gen_step():
            with bd.BuildPart() as block:
                with bd.Locations((36, 0, 41)):
                    bd.Box(16, 24, 56)
                bd.add(folded_handle())
                with bd.BuildSketch(block.faces().sort_by(bd.Axis.X)[0]):
                    bd.Text("A", font_size=10)
                bd.extrude(amount=-1, mode=bd.Mode.SUBTRACT)
            return block.part
        """
    ),
    "three_handles": FOLDED_HANDLE + textwrap.dedent(
        """\


        def gen_step():
            handle = folded_handle()
            return bd.Compound([handle, bd.Pos(0, 40, 0) * handle, bd.Pos(0, 80, 0) * handle])
        """
    ),
    "unchecked_handle": FOLDED_HANDLE + "\n\ndef gen_step():\n    return folded_handle()\n",
    "inside_out": "import build123d as bd\n\n\ndef gen_step():\n    return bd.Solid(bd.Box(10, 10, 10).wrapped.Reversed())\n",
    "open_box": "import build123d as bd\n\n\ndef gen_step():\n    return bd.Shell(bd.Box(10, 10, 10).faces()[:-1])\n",
}
OPTIONS = {"unchecked_handle": ("--no-solid-check",)}
# Places the three handles' STEP twice; their source is checked, the assembly is not.
ASSEMBLY = textwrap.dedent(
    """\
    def gen_step():
        return {"children": [
            {"name": "left", "path": "three_handles.step", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
            {"name": "right", "path": "three_handles.step", "transform": [1, 0, 0, 200, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
        ]}
    """
)


class StepSolidCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tempdir = tempfile.TemporaryDirectory(prefix="solid-check-")
        cls.project = Path(cls._tempdir.name)

        def generate(name: str) -> subprocess.CompletedProcess:
            return subprocess.run(
                [sys.executable, str(SCRIPTS_ROOT / "step"), f"{name}.py", "--stl", f"{name}.stl", *OPTIONS.get(name, ())],
                cwd=cls.project,
                capture_output=True,
                text=True,
                timeout=600,
            )

        for name, source in {**MODELS, "handle_pair": ASSEMBLY}.items():
            (cls.project / f"{name}.py").write_text(source, encoding="utf-8")
        with ThreadPoolExecutor(max_workers=4) as pool:
            cls.runs = dict(zip(MODELS, pool.map(generate, MODELS)))
        cls.runs["handle_pair"] = generate("handle_pair")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tempdir.cleanup()

    def problems(self, name: str) -> list[str]:
        run = self.runs[name]
        self.assertEqual(0, run.returncode, run.stdout + run.stderr)
        self.assertTrue((self.project / f"{name}.step").is_file())
        return [line for line in run.stderr.splitlines() if "warning:" in line or "notice:" in line]

    def test_fold_found_on_the_written_step(self) -> None:
        problems = self.problems("lettered_block")
        self.assertEqual(1, len(problems), problems)
        self.assertRegex(problems[0], r"lettered_block\.py is not a sound solid( as read back from its STEP)?: \d+ self-intersection")

    def test_placed_copies_share_one_check(self) -> None:
        problems = self.problems("three_handles")
        self.assertEqual(1, len(problems), problems)
        self.assertIn("warning: three_handles.py is not a sound solid: ", problems[0])

    def test_open_and_inside_out_parts(self) -> None:
        self.assertEqual(
            ["inside_out.py is inside out: its faces point inward, so its volume is negative."],
            [line.split("warning: ")[1].split(" Slicers")[0] for line in self.problems("inside_out")],
        )
        self.assertEqual(
            ["open_box.py is not a closed solid: 5 faces do not enclose a volume."],
            [line.split("warning: ")[1].split(" Slicers")[0] for line in self.problems("open_box")],
        )

    def test_the_check_can_be_skipped(self) -> None:
        self.assertEqual([], self.problems("unchecked_handle"))
        self.assertTrue((self.project / "unchecked_handle.stl").is_file())

    def test_assemblies_do_not_recheck_the_parts_they_place(self) -> None:
        self.assertEqual([], self.problems("handle_pair"))


if __name__ == "__main__":
    unittest.main()
