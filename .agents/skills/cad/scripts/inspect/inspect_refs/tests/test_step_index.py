"""The topology index of any STEP: exact part boxes, one hash for its name and manifest, and checks that stay honest."""

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(SCRIPTS_DIR / "inspect"))

from common import step_scene, step_targets  # noqa: E402
from common.step_export import export_build123d_step_scene  # noqa: E402
from inspect_refs.checks import hygiene_report  # noqa: E402
from inspect_refs.parts import list_parts  # noqa: E402


class StepIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from build123d import Box, Compound, Cylinder, Pos, Rot, Sphere

        cls._temp = tempfile.TemporaryDirectory(prefix="step index ")
        cls.root = Path(cls._temp.name).resolve()
        pot = Cylinder(50, 80)
        pot.label = "pot"
        export_build123d_step_scene(pot, cls.root / "pot.step")
        turned = Pos(100, 0, 0) * Rot(0, 0, 45) * Sphere(5)
        turned.label = "turned"
        upright = Box(10, 20, 4)
        upright.label = "upright"
        export_build123d_step_scene(Compound(children=[upright, turned], label="pair"), cls.root / "pair.step")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._temp.cleanup()

    def setUp(self) -> None:
        cache = tempfile.TemporaryDirectory(prefix="step index cache ")
        self.addCleanup(cache.cleanup)
        patcher = mock.patch.dict(os.environ, {"CAD_PILOT_CACHE": cache.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cache = Path(cache.name)

    def copy(self, name: str) -> Path:
        folder = Path(tempfile.mkdtemp(prefix="elsewhere ", dir=self.root))
        return Path(shutil.copy2(self.root / name, folder / name))

    def test_a_part_listed_from_any_folder_has_its_exact_size_and_centre(self) -> None:
        # No sidecar beside the copy, so the STEP is indexed into the cache: its size must not depend on the mesh.
        (pot,) = list_parts(str(self.copy("pot.step")))["parts"]
        self.assertEqual(([100.0, 100.0, 80.0], [0.0, 0.0, 0.0]), (pot["size"], pot["center"]))

    def test_a_part_turned_off_the_axes_has_its_own_box_not_its_turned_box(self) -> None:
        # Turning the ball's 10 mm box by 45 degrees would make it 14.1 mm wide; the ball itself stays 10 mm.
        parts = {part["name"]: part for part in list_parts(str(self.copy("pair.step")))["parts"]}
        self.assertEqual([10.0, 20.0, 4.0], parts["upright"]["size"])
        self.assertEqual(([10.0, 10.0, 10.0], [100.0, 0.0, 0.0]), (parts["turned"]["size"], parts["turned"]["center"]))

    def test_a_step_rewritten_while_it_is_indexed_is_not_cached(self) -> None:
        step = self.copy("pot.step")
        other = self.root / "pair.step"
        original = step.read_bytes()
        real_load = step_scene.load_step_scene

        def rewritten_while_read(path):
            step.write_bytes(other.read_bytes())  # someone saves another model over it...
            scene = real_load(path)
            step.write_bytes(original)  # ...and puts the first back before the read ends
            return scene

        target = step_targets.resolve_step_target(str(step))
        with mock.patch.object(step_scene, "load_step_scene", rewritten_while_read):
            with self.assertRaisesRegex(step_targets.CadRefError, "changed while it was read"):
                step_targets.step_topology(target)
        self.assertFalse((self.cache / "topology").exists() and any((self.cache / "topology").iterdir()))
        index = step_targets.step_topology(target)
        self.assertEqual(index.manifest["stepHash"], index.glb_path.name.split(".")[0])
        self.assertEqual(1, len(list_parts(str(step))["parts"]))

    def test_hygiene_is_not_clean_when_a_part_could_not_be_checked(self) -> None:
        calls = []

        def flaky(shape, **options):
            calls.append(shape)
            if len(calls) == 1:
                raise RuntimeError("the kernel gave up")
            return real_check(shape, **options)

        from common import hygiene

        real_check = hygiene.check_part
        with mock.patch.object(hygiene, "check_part", flaky):
            report = hygiene_report(str(self.root / "pair.step"))
        self.assertEqual(["the kernel gave up"], [error["message"].rsplit(": ", 1)[-1] for error in report["errors"]])
        self.assertFalse(report["clean"])


if __name__ == "__main__":
    unittest.main()
