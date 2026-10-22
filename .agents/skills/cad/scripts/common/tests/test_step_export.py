import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import build123d

from common.step_export import export_build123d_step_scene
from common.step_scene import load_step_scene, scene_occurrence_shape


SCRIPTS_ROOT = Path(__file__).resolve().parents[2]


def _linear_rgba(color: build123d.Color) -> tuple[float, float, float, float]:
    rgb = color.wrapped.GetRGB()
    return (rgb.Red(), rgb.Green(), rgb.Blue(), color.wrapped.Alpha())


def _translation(node) -> tuple[float, float, float]:
    return (node.transform[3], node.transform[7], node.transform[11])


def _product_names(data: bytes) -> list[str]:
    return [name.decode("ascii") for name in re.findall(rb"= PRODUCT\('([^']*)'", data)]


def _occurrence_names(data: bytes) -> list[str]:
    return [name.decode("ascii") for name in re.findall(rb"= NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','([^']*)'", data)]


class StepExportNamingTests(unittest.TestCase):
    def setUp(self) -> None:
        tempdir = tempfile.TemporaryDirectory(prefix="step-export-")
        self.addCleanup(tempdir.cleanup)
        self.root = Path(tempdir.name)

    def _pair_with_knob(self):
        box = build123d.Solid.make_box(2, 3, 4)
        left = build123d.Pos(0, 0, 0) * box
        left.label, left.color = "left", build123d.Color("red")
        right = build123d.Pos(10, 0, 0) * box
        right.label, right.color = "right", build123d.Color("blue")
        # A Part leaf: a compound holding one solid.
        knob = build123d.Pos(0, 10, 0) * build123d.Cylinder(1, 2)
        knob.label, knob.color = "knob", build123d.Color(0.2, 0.6, 0.3)
        return build123d.Compound(children=[left, right, knob], label="pair"), [left, right, knob]

    def test_moved_copies_keep_their_own_names_colors_and_placements(self) -> None:
        assembly, children = self._pair_with_knob()
        self.assertTrue(children[0].wrapped.TShape() == children[1].wrapped.TShape())
        step_path = self.root / "pair.step"

        written = export_build123d_step_scene(assembly, step_path)
        data = step_path.read_bytes()

        self.assertCountEqual(["pair", "left", "right", "knob"], _product_names(data))
        self.assertEqual(["left", "right", "knob"], _occurrence_names(data))
        for scene in (written, load_step_scene(step_path)):
            with self.subTest(scene="in memory" if scene is written else "read back"):
                self.assertEqual(["pair"], [root.name for root in scene.roots])
                occurrences = scene.roots[0].children
                self.assertEqual(["left", "right", "knob"], [node.name for node in occurrences])
                self.assertEqual(["left", "right", "knob"], [node.source_name for node in occurrences])
                for node, authored in zip(occurrences, children, strict=True):
                    self.assertEqual([], node.children, f"{node.name} gained a nested level")
                    for actual, expected in zip(node.color, _linear_rgba(authored.color), strict=True):
                        self.assertAlmostEqual(actual, expected, places=3, msg=node.name)
                    for actual, expected in zip(_translation(node), tuple(authored.location.position), strict=True):
                        self.assertAlmostEqual(actual, expected, places=6, msg=node.name)
                    shape = build123d.Shape.cast(scene_occurrence_shape(scene, node))
                    self.assertAlmostEqual(shape.volume, authored.volume, places=6)
                    self.assertLess((shape.center() - authored.center()).length, 1e-6)

    def test_placed_root_keeps_its_hierarchy_and_world_placements(self) -> None:
        for root_frame in (build123d.Pos(40, 50, 60), build123d.Pos(40, 50, 60) * build123d.Rot(17, 29, 83)):
            with self.subTest(root_frame=root_frame):
                leaf = build123d.Solid.make_box(2, 3, 4)
                leaf.label, leaf.color = "leaf", build123d.Color("red")
                sibling = build123d.Pos(0, 8, 0) * leaf
                sibling.label, sibling.color = "sibling", build123d.Color("blue")
                group_frame = build123d.Pos(7, 11, 13) * build123d.Rot(0, 90, 0)
                group = group_frame * build123d.Compound(children=[leaf, sibling], label="nested")
                root = root_frame * build123d.Compound(children=[group], label="root")
                nodes = [root, root.children[0], *root.children[0].children]
                original = [(node.location, node.label, node.wrapped) for node in nodes]
                expected = {
                    "leaf": root_frame * group_frame * leaf,
                    "sibling": root_frame * group_frame * sibling,
                }
                step_path = self.root / "root.step"

                written = export_build123d_step_scene(root, step_path)

                for scene in (written, load_step_scene(step_path)):
                    self.assertEqual(["root"], [node.name for node in scene.roots])
                    self.assertEqual(["nested"], [node.name for node in scene.roots[0].children])
                    leaves = scene.roots[0].children[0].children
                    self.assertEqual(["leaf", "sibling"], [node.name for node in leaves])
                    for node in leaves:
                        shape = build123d.Shape.cast(scene_occurrence_shape(scene, node))
                        self.assertLess((shape.center() - expected[node.name].center()).length, 1e-6)
                        self.assertAlmostEqual(shape.volume, expected[node.name].volume, places=6)
                for node, (location, label, wrapped) in zip(nodes, original, strict=True):
                    self.assertEqual(location, node.location)
                    self.assertEqual(label, node.label)
                    self.assertTrue(node.wrapped.IsSame(wrapped))

    def test_unnamed_labels_do_not_crash_scene_loading(self) -> None:
        # OCP's TDF_Label.FindAttribute dereferences null for an absent name and
        # kills the process (exit 139), so the export runs in a child process.
        # Turning auto-naming off leaves every unlabelled child without a name.
        script = textwrap.dedent(
            f"""
            import sys
            from pathlib import Path
            sys.path.insert(0, {str(SCRIPTS_ROOT)!r})
            import build123d
            from OCP.XCAFDoc import XCAFDoc_ShapeTool
            from common.step_export import export_build123d_step_scene
            from common.step_scene import load_step_scene

            XCAFDoc_ShapeTool.SetAutoNaming_s(False)
            boxes = [build123d.Pos(30 * index, 0, 0) * build123d.Box(20, 20, 10) for index in range(3)]
            named = [build123d.Pos(30 * index, 40, 0) * build123d.Box(20, 20, 10) for index in range(2)]
            for index, box in enumerate(named):
                box.label = f"block_{{index}}"
            for name, shape in (("unnamed", build123d.Compound(children=boxes)),
                                ("named", build123d.Compound(children=named)),
                                ("single", build123d.Box(20, 20, 10))):
                path = Path({str(self.root)!r}) / f"{{name}}.step"
                export_build123d_step_scene(shape, path)
                load_step_scene(path)
            names = [node.name for node in load_step_scene(Path({str(self.root)!r}) / "named.step").roots[0].children]
            print(",".join(names))
            """
        )

        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=300)

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual("block_0,block_1", result.stdout.strip().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
