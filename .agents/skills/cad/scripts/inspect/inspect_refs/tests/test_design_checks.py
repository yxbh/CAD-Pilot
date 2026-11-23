"""scripts/inspect on real STEP files: any STEP, part listings, hygiene and pose clearance.

Each test builds a small design in its own design root, with its own cache,
and runs the launchers as an agent would.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from common.tests import cli_host

SCRIPTS_ROOT = Path(__file__).resolve().parents[3]

# An open box with a drawer resting on its floor, 0.5 mm from each side wall,
# and a lid 0.4 mm above the rim, hinged at its back edge. Pushed 0.8 mm
# sideways the drawer runs into a wall; swinging open, the lid's underside
# stays farther from the rim than it sits when closed.
CABINET = textwrap.dedent(
    """\
    from build123d import Box, Compound, Pos, Rot

    W, D, H, WALL = 60.0, 40.0, 30.0, 2.0
    LID = 3.0
    HINGE = Pos(0, D / 2 + 0.4, H + 0.4)

    def body():
        shell = Box(W, D, H) - Pos(0, 0, WALL) * Box(W - 2 * WALL, D - 2 * WALL, H)
        shell = Pos(0, 0, H / 2) * shell
        shell.label = "box"
        return shell

    def drawer():
        tray = Pos(0, 0, WALL + 5) * Box(W - 2 * WALL - 1.0, 20, 10)
        tray.label = "drawer"
        return tray

    def lid():
        plate = Pos(0, 0.4, H + 0.4 + LID / 2) * Box(W, D, LID)
        plate.label = "lid"
        return plate

    def gen_step():
        return Compound(children=[body(), drawer(), lid()], label="cabinet")

    def gen_poses():
        return {
            "pairs": [["lid", "box"], ["drawer", "box", 0.4]],
            "poses": [
                *({"name": f"drawer out {d}", "move": {"drawer": (0, -d, 0)}} for d in (3, 7)),
                {"name": "drawer pushed sideways", "move": {"drawer": (0.8, 0, 0)}},
                *({"name": f"lid {a}", "move": {"lid": HINGE * Rot(-a, 0, 0) * HINGE.inverse()}} for a in (30, 60)),
            ],
        }
    """
)

VASE = textwrap.dedent(
    """\
    from build123d import Circle, Pos, Rectangle, loft

    NECK = 5.0

    def gen_step():
        return loft([Rectangle(20, 12), Pos(0, 0, 15) * Circle(NECK)])
    """
)

# A filleted, drilled plate, whose edges the STEP lists in another order than the shape that wrote it, and a part
# placed away from the origin, which the STEP holds one level down.
PLATE = textwrap.dedent(
    """\
    from build123d import Axis, Box, Cylinder, Pos, fillet

    def gen_step():
        plate = Box(30, 20, 5) - Pos(8, 0, 0) * Cylinder(3, 5)
        return fillet(plate.edges().filter_by(Axis.Z), 2)
    """
)
PLACED = "from build123d import Box, Pos\n\ndef gen_step():\n    return Pos(10, 0, 5) * Box(10, 8, 6)\n"

BLOCK = "from build123d import Box, Circle, Cylinder, Pos, Rectangle, extrude\n\ndef gen_step():\n    return {build}\n"

UNLABELLED = textwrap.dedent(
    """\
    from build123d import Box, Compound, Pos

    def gen_step():
        kit = Compound(children=[Box(10, 10, 10), Pos(20, 0, 0) * Box(5, 5, 5)], label="kit")
        return Compound(children=list(kit.solids()), label="kit")
    """
)


# A box and its lid in an unlabelled compound, saved as box.step: the file's
# name is not a group, so "box" names the box alone.
NAMED_LIKE_ITS_FILE = textwrap.dedent(
    """\
    from build123d import Box, Compound, Pos

    def gen_step():
        base = Box(20, 20, 10)
        base.label = "box"
        lid = Pos(0, 0, 5.5) * Box(20, 20, 1)
        lid.label = "lid"
        return Compound(children=[base, lid])

    def gen_poses():
        return [{"name": "box pushed up", "move": {"box": (0, 0, 0.5)}}]
    """
)

SCREWS = textwrap.dedent(
    """\
    from build123d import Compound, Cylinder, Pos

    def gen_step():
        screw = Cylinder(1.5, 10)
        return Compound(children=[Pos(x * 5, 0, 0) * screw for x in range(30)], label="screws")
    """
)


class DesignChecksTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="design checks ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.env = {**os.environ, "CAD_PILOT_CACHE": str(self.root / "cache")}

    def run_tool(self, tool: str, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return cli_host.run(SCRIPTS_ROOT / tool, *args, cwd=cwd or self.root, env=self.env, timeout=300)

    def inspect_json(self, *args: str, expect: int = 0, cwd: Path | None = None) -> dict:
        result = self.run_tool("inspect", *args, cwd=cwd)
        self.assertEqual(expect, result.returncode, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def generate(self, name: str, source: str) -> subprocess.CompletedProcess[str]:
        (self.root / f"{name}.py").write_text(source)
        result = self.run_tool("step", f"{name}.py", "-o", f"out/{name}.step")
        self.assertEqual(0, result.returncode, result.stderr)
        return result

    def test_parts_hygiene_and_pose_clearance(self) -> None:
        self.generate("cabinet", CABINET)

        listing = self.inspect_json("parts", "out/cabinet.step")
        parts = {part["name"]: part for part in listing["parts"]}
        self.assertEqual(["box", "drawer", "lid"], list(parts))
        self.assertEqual("cabinet/drawer", parts["drawer"]["path"])
        self.assertEqual([55.0, 20.0, 10.0], parts["drawer"]["size"])
        self.assertEqual("@cad[out/cabinet#o1.2]", parts["drawer"]["ref"])

        hygiene = self.inspect_json("hygiene", "out/cabinet.step", "--round", "1", "--parts", "lid", expect=1)
        (lid,) = hygiene["parts"]
        self.assertEqual({"sharp-edge"}, {finding["check"] for finding in lid["findings"]})
        self.assertEqual(12, len(lid["findings"]))
        self.assertRegex(lid["findings"][0]["refs"][0], r"^@cad\[out/cabinet#o1\.3\.e\d+\]$")

        report = self.inspect_json("clearance", "out/cabinet.step", "--poses", "cabinet.py", expect=1)
        self.assertEqual(
            ["as assembled", "drawer out 3", "drawer out 7", "drawer pushed sideways", "lid 30", "lid 60"],
            report["poses"],
        )
        pairs = {(pair["a"], pair["b"]): pair for pair in report["pairs"]}
        drawer = pairs[("cabinet/box", "cabinet/drawer")]
        self.assertEqual("overlap", drawer["status"])
        self.assertEqual(["drawer pushed sideways"], drawer["overlapPoses"])
        self.assertEqual(0.4, drawer["minGap"])
        lid_pair = pairs[("cabinet/box", "cabinet/lid")]
        self.assertEqual("clear", lid_pair["status"])
        self.assertAlmostEqual(0.4, lid_pair["minDistance"], places=3)
        self.assertEqual(3, lid_pair["measuredPoses"])  # as assembled and the two lid poses

        text = self.run_tool("inspect", "clearance", "out/cabinet.step", "--poses", "cabinet.py", "--format", "text")
        self.assertIn("overlap  cabinet/box / cabinet/drawer", text.stdout)

        same = self.run_tool("inspect", "diff", "out/cabinet.step", "out/cabinet.step", "--format", "text")
        self.assertEqual(
            ["topologyChanged=False, geometryChanged=False, bboxChanged=False, kindChanged=False", "faceDelta=0 edgeDelta=0"],
            same.stdout.splitlines(),
        )

    def test_a_ref_names_the_same_geometry_with_or_without_the_sidecar(self) -> None:
        def refs(path: str) -> dict[str, dict]:
            listed = self.inspect_json("refs", path, "--topology")["tokens"][0]["topology"]
            selectors = [*listed["occurrences"], *listed["shapes"], *listed["faces"], *listed["edges"]]
            detailed = self.inspect_json("refs", f"@cad[{path.removesuffix('.step')}#{','.join(selectors)}]", "--detail")
            return {selection["normalizedSelector"]: selection["detail"] for selection in detailed["tokens"][0]["selections"]}

        (self.root / "kept").mkdir()
        for name, source, fewest in (("plate", PLATE, 30), ("placed", PLACED, 15)):
            with self.subTest(name):
                self.generate(name, source)
                shutil.copy2(self.root / f"out/{name}.step", self.root / f"kept/{name}.step")
                self.assertTrue((self.root / f"out/.{name}.step.glb").is_file())
                self.assertFalse((self.root / f"kept/.{name}.step.glb").exists())
                beside, alone = refs(f"out/{name}.step"), refs(f"kept/{name}.step")
                self.assertGreater(len(beside), fewest)
                self.assertEqual(beside, alone)

    def test_diff_compares_the_step_files_whatever_sidecars_lie_beside_them(self) -> None:
        def flags(left: str, right: str) -> dict[str, bool]:
            diff = self.inspect_json("diff", left, right)["diff"]
            return {name[: -len("Changed")]: changed for name, changed in diff.items() if name.endswith("Changed") and changed}

        # A spline surface: its STEP, read back, is not the modelled shape to the last digit, as the sidecar is.
        self.generate("vase", VASE)
        (self.root / "kept").mkdir()
        shutil.copy2(self.root / "out/vase.step", self.root / "kept/vase.step")
        self.assertFalse((self.root / "kept/.vase.step.glb").exists())
        self.assertEqual({}, flags("kept/vase.step", "out/vase.step"), "a copy without its sidecar")
        self.generate("vase", VASE)
        self.assertEqual({}, flags("kept/vase.step", "out/vase.step"), "the same source generated again")

        self.generate("vase", VASE.replace("NECK = 5.0", "NECK = 5.2"))
        self.assertEqual({"geometry": True}, flags("kept/vase.step", "out/vase.step"), "a neck 0.2 mm wider")

        # The same block built two ways is the same geometry, though its edges are numbered in another order.
        self.generate("block", BLOCK.format(build="Box(10, 10, 10) - Cylinder(2, 10)"))
        self.generate("pad", BLOCK.format(build="extrude(Pos(0, 0, -5) * (Rectangle(10, 10) - Circle(2)), 10)"))
        self.assertEqual({}, flags("out/block.step", "out/pad.step"))
        # The same faces around nothing: an open shell of the block is not the block.
        self.generate("skin", BLOCK.format(build="(Box(10, 10, 10) - Cylinder(2, 10)).shell()"))
        self.assertEqual({"geometry": True}, flags("out/block.step", "out/skin.step"))

    def test_unlabelled_parts_get_group_names_and_one_warning(self) -> None:
        result = self.generate("kit", UNLABELLED)
        warnings = [line for line in result.stderr.splitlines() if "warning" in line]
        self.assertEqual(1, len(warnings), result.stderr)
        self.assertIn("2 parts in kit.py had no label and were named 'kit 1', 'kit 2'", warnings[0])
        listing = self.inspect_json("parts", "out/kit.step")
        self.assertEqual(["kit 1", "kit 2"], [part["name"] for part in listing["parts"]])
        hygiene = self.inspect_json("hygiene", "out/kit.step")
        self.assertTrue(hygiene["clean"])

    def test_a_part_named_like_its_file_names_only_itself(self) -> None:
        self.generate("box", NAMED_LIKE_ITS_FILE)
        listing = self.inspect_json("parts", "out/box.step")
        self.assertEqual(["box", "lid"], [part["path"] for part in listing["parts"]])
        hygiene = self.inspect_json("hygiene", "out/box.step", "--parts", "box")
        self.assertEqual(["box"], [part["path"] for part in hygiene["parts"]])
        report = self.inspect_json("clearance", "out/box.step", "--poses", "box.py", expect=1)
        (pair,) = report["pairs"]
        self.assertEqual(("overlap", ["box pushed up"]), (pair["status"], pair["overlapPoses"]))

    def test_identical_unlabelled_copies_share_one_shape(self) -> None:
        self.generate("screws", SCREWS)
        step_text = (self.root / "out" / "screws.step").read_text()
        self.assertEqual(1, step_text.count("MANIFOLD_SOLID_BREP"))
        listing = self.inspect_json("parts", "out/screws.step")
        self.assertEqual([f"screws {n}" for n in range(1, 31)], [part["name"] for part in listing["parts"]])
        hygiene = self.inspect_json("hygiene", "out/screws.step")
        (shape,) = hygiene["parts"]
        self.assertEqual(29, len(shape["sameShape"]))

    def test_errors_are_exit_status_2_with_a_message_not_a_traceback(self) -> None:
        self.generate("box", NAMED_LIKE_ITS_FILE)
        (self.root / "poses.py").write_text("import missing_pose_helper\n\ndef gen_poses():\n    return []\n")
        (self.root / "no_poses.py").write_text("VALUE = 1\n")
        for poses, message in (("poses.py", "imports 'missing_pose_helper'"), ("no_poses.py", "does not define gen_poses()")):
            with self.subTest(poses=poses):
                result = self.run_tool("inspect", "clearance", "out/box.step", "--poses", poses)
                self.assertEqual(2, result.returncode, result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertIn(message, json.loads(result.stdout)["errors"][0]["message"])

    def test_the_step_reader_s_complaints_go_to_stderr_not_stdout(self) -> None:
        self.generate("box", NAMED_LIKE_ITS_FILE)
        step_text = (self.root / "out" / "box.step").read_text()
        broken, count = re.subn(r"(ADVANCED_FACE\('[^']*',\()#\d+", r"\g<1>#999999", step_text, count=1)
        self.assertEqual(1, count)
        (self.root / "broken.step").write_text(broken)
        result = self.run_tool("inspect", "parts", "broken.step")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("Unresolved Reference", result.stderr)
        # The box's face that lost its edges has nothing closing it, so the box has no size; the lid keeps its own.
        listing = json.loads(result.stdout)
        box, lid = listing["parts"]
        self.assertTrue(listing["ok"])
        self.assertEqual((True, None, None, None, None), (box["unbounded"], box["size"], box["center"], box["min"], box["max"]))
        self.assertEqual((False, [20.0, 20.0, 1.0]), (lid["unbounded"], lid["size"]))
        self.assertIn("size unbounded", self.run_tool("inspect", "parts", "broken.step", "--format", "text").stdout)
        # The other commands give it, and the whole STEP, no box either, rather than one 1e100 mm across.
        for args in (("frame", box["ref"]), ("refs", box["ref"], "--positioning"), ("refs", "@cad[broken]", "--facts")):
            with self.subTest(args=args):
                answer = self.run_tool("inspect", *args)
                self.assertEqual(0, answer.returncode, answer.stdout + answer.stderr)
                self.assertNotIn("e+100", answer.stdout)
        hygiene = self.inspect_json("hygiene", "broken.step", "--parts", "box", expect=1)
        self.assertIn("unbounded-face", [finding["check"] for finding in hygiene["parts"][0]["findings"]])
        # A design that reads the STEP itself, before the workbench reads or writes one.
        (self.root / "uses.py").write_text("from build123d import import_step\n\ndef gen_step():\n    return import_step('broken.step')\n")
        result = self.run_tool("step", "uses.py", "-o", "out/uses.step")
        self.assertNotIn("Unresolved Reference", result.stdout)
        self.assertIn("Unresolved Reference", result.stderr)

    def test_refs_to_a_step_inside_the_root_are_reported_from_the_root(self) -> None:
        self.generate("box", NAMED_LIKE_ITS_FILE)
        for target in (f"@cad[{self.root.as_posix()}/out/box#o1.1]", "@cad[/out/box#o1.1]"):
            with self.subTest(target=target):
                report = self.inspect_json("refs", target, "--verbose")
                self.assertEqual("out/box", report["tokens"][0]["cadPath"])
                self.assertEqual("@cad[out/box#o1.1]", report["tokens"][0]["selections"][0]["copyText"])

    def test_any_step_is_indexed_without_writing_beside_it(self) -> None:
        self.generate("cabinet", CABINET)
        elsewhere = self.root / "downloads"
        elsewhere.mkdir()
        shutil.copy2(self.root / "out" / "cabinet.step", elsewhere / "vendor cabinet.step")
        project = self.root / "project"
        project.mkdir()
        for target in ("../downloads/vendor cabinet.step", str(elsewhere / "vendor cabinet.step")):
            with self.subTest(target=target):
                report = self.inspect_json("refs", target, "--facts", cwd=project)
                self.assertTrue(report["ok"])
                self.assertEqual([60.0, 40.4, 33.4], [round(v, 3) for v in report["tokens"][0]["entryFacts"]["size"]])
                face = self.inspect_json("refs", f"@cad[{report['tokens'][0]['cadPath']}#o1.1.f1]", cwd=project)
                self.assertEqual("resolved", face["tokens"][0]["selections"][0]["status"])
        self.assertEqual(["vendor cabinet.step"], sorted(path.name for path in elsewhere.iterdir()))
        (index,) = (self.root / "cache" / "topology").iterdir()
        self.assertRegex(index.name, r"^[0-9a-f]{64}\.v\d+\.glb$")

    def test_renumbered_faces_warn_once_and_only_after_refs_were_taken(self) -> None:
        source = self.root / "plate.py"
        plain = "from build123d import Box\n\ndef gen_step():\n    return Box(20, 20, 4)\n"
        holed = "from build123d import Box, Cylinder\n\ndef gen_step():\n    return Box(20, 20, 4) - Cylinder(3, 10)\n"
        source.write_text(plain)
        self.run_tool("step", "plate.py")
        source.write_text(holed)
        self.assertNotIn("numbering", self.run_tool("step", "plate.py").stderr)

        self.inspect_json("refs", "@cad[plate#f1]")
        source.write_text(plain)
        self.assertIn("new face and edge numbering", self.run_tool("step", "plate.py").stderr)
        source.write_text(holed)
        self.assertNotIn("numbering", self.run_tool("step", "plate.py").stderr)

        # A hole moved inside the plate keeps every number and the overall box; refs taken before it are told.
        moved = holed.replace("- Cylinder(3, 10)", "- Pos(4, 0, 0) * Cylinder(3, 10)").replace("Cylinder\n", "Cylinder, Pos\n")
        self.inspect_json("refs", "@cad[plate#f1]")
        source.write_text(moved)
        self.assertIn("kept its face and edge numbering but its geometry moved", self.run_tool("step", "plate.py").stderr)
        self.inspect_json("refs", "@cad[plate#f1]")
        self.assertNotIn("numbering", self.run_tool("step", "plate.py").stderr, "the same source again")


if __name__ == "__main__":
    unittest.main()
