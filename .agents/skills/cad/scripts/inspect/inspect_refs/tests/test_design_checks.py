"""scripts/inspect on real STEP files: any STEP, part listings, hygiene and pose clearance.

Each test builds a small design in its own design root, with its own cache,
and runs the launchers as an agent would.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

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

UNLABELLED = textwrap.dedent(
    """\
    from build123d import Box, Compound, Pos

    def gen_step():
        kit = Compound(children=[Box(10, 10, 10), Pos(20, 0, 0) * Box(5, 5, 5)], label="kit")
        return Compound(children=list(kit.solids()), label="kit")
    """
)


class DesignChecksTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="design checks ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.env = {**os.environ, "CAD_PILOT_CACHE": str(self.root / "cache")}

    def run_tool(self, tool: str, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPTS_ROOT / tool), *args],
            cwd=cwd or self.root,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )

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

    def test_unlabelled_parts_get_group_names_and_one_warning(self) -> None:
        result = self.generate("kit", UNLABELLED)
        warnings = [line for line in result.stderr.splitlines() if "warning" in line]
        self.assertEqual(1, len(warnings), result.stderr)
        self.assertIn("2 parts in kit.py had no label and were named 'kit 1', 'kit 2'", warnings[0])
        listing = self.inspect_json("parts", "out/kit.step")
        self.assertEqual(["kit 1", "kit 2"], [part["name"] for part in listing["parts"]])
        hygiene = self.inspect_json("hygiene", "out/kit.step")
        self.assertTrue(hygiene["clean"])

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
        self.assertEqual(1, len(list((self.root / "cache" / "topology").glob("*.glb"))))

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


if __name__ == "__main__":
    unittest.main()
