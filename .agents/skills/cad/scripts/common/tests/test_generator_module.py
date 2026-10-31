"""Generators import from their own project, as the project would run them."""

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from common.generator_module import GeneratorImportError, call_generator, load_generator, project_import_paths

SCRIPTS_ROOT = Path(__file__).resolve().parents[2]


class GeneratorModuleTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="generator-module-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        (self.root / "src" / "widgets").mkdir(parents=True)
        (self.root / "src" / "widgets" / "__init__.py").write_text("SIZE = 12.0\n")
        (self.root / "review").mkdir()
        saved_path = list(sys.path)
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), saved_path))
        for name in ("widgets", "widgets.parts", "missing_vendor_package"):
            self.addCleanup(sys.modules.pop, name, None)

    def write(self, relative: str, source: str) -> Path:
        path = self.root / relative
        path.write_text(textwrap.dedent(source))
        return path

    def test_import_paths_are_the_generator_folder_the_design_root_and_src(self) -> None:
        script = self.write("review/model.py", "")
        self.assertEqual(
            [self.root / "review", self.root, self.root / "src"],
            project_import_paths(script, root=self.root),
        )

    def test_a_src_package_imports_at_load_and_inside_gen_step(self) -> None:
        script = self.write(
            "review/model.py",
            """\
            from widgets import SIZE

            def gen_step():
                import widgets
                return SIZE + widgets.SIZE
            """,
        )
        with mock.patch.object(Path, "cwd", return_value=self.root):
            module = load_generator(script)
        self.assertEqual(24.0, call_generator(module, "gen_step", script_path=script))

    def test_the_project_folders_and_their_finders_leave_the_import_machinery_afterwards(self) -> None:
        script = self.write("review/model.py", "import widgets\n\ndef gen_step():\n    return 1\n")
        before = (list(sys.path), list(sys.path_hooks))
        with mock.patch.object(Path, "cwd", return_value=self.root):
            call_generator(load_generator(script), "gen_step", script_path=script)
        self.assertEqual(before, (sys.path, sys.path_hooks))
        root = str(self.root)
        self.assertEqual([], [path for path in sys.path_importer_cache if isinstance(path, str) and path.startswith(root)])

    def test_an_edit_of_the_same_length_within_a_second_is_read(self) -> None:
        script = self.root / "review" / "edited.py"
        stamp = 1_700_000_000_000_000_000
        values = []
        with mock.patch.object(sys, "dont_write_bytecode", False), mock.patch.object(Path, "cwd", return_value=self.root):
            for value in ("aaa", "bbb"):
                script.write_text(f"VALUE = {value!r}\n")
                os.utime(script, ns=(stamp, stamp))
                values.append(load_generator(script).VALUE)
        self.assertEqual(["aaa", "bbb"], values)

    def test_a_generator_runs_without_the_loaders_future_imports_and_its_dataclasses_load(self) -> None:
        script = self.write(
            "review/model.py",
            """\
            from dataclasses import dataclass

            @dataclass
            class Size:
                width: float

            def gen_step(width: float) -> float:
                return Size(width).width
            """,
        )
        with mock.patch.object(Path, "cwd", return_value=self.root):
            module = load_generator(script)
        self.assertEqual({"width": float, "return": float}, module.gen_step.__annotations__)
        self.assertEqual(2.0, module.gen_step(2.0))

    def test_same_named_sibling_modules_of_two_generators_are_each_their_own(self) -> None:
        for folder, width in (("a", 10), ("b", 99)):
            (self.root / folder).mkdir()
            self.write(f"{folder}/params.py", f"WIDTH = {width}\n")
            self.write(f"{folder}/model.py", "from params import WIDTH\n\ndef gen_step():\n    return WIDTH\n")
        self.addCleanup(sys.modules.pop, "params", None)
        with mock.patch.object(Path, "cwd", return_value=self.root):
            widths = [
                call_generator(load_generator(script), "gen_step", script_path=script)
                for script in (self.root / "a" / "model.py", self.root / "b" / "model.py")
            ]
        self.assertEqual([10, 99], widths)

    def test_a_generator_outside_the_root_leaves_no_modules_for_the_next_one(self) -> None:
        # The first generator lives outside the design root (a ../ path or a linked folder), so its params.py is
        # not under the second one's folders; it must still be dropped before the second load.
        outside = tempfile.TemporaryDirectory(prefix="generator-elsewhere-")
        self.addCleanup(outside.cleanup)
        elsewhere = Path(outside.name).resolve()
        (elsewhere / "params.py").write_text("WIDTH = 99\n")
        (elsewhere / "model.py").write_text("from params import WIDTH\n\ndef gen_step():\n    return WIDTH\n")
        (self.root / "a").mkdir()
        self.write("a/params.py", "WIDTH = 10\n")
        self.write("a/model.py", "from params import WIDTH\n\ndef gen_step():\n    return WIDTH\n")
        self.addCleanup(sys.modules.pop, "params", None)
        with mock.patch.object(Path, "cwd", return_value=self.root):
            widths = [
                call_generator(load_generator(script), "gen_step", script_path=script)
                for script in (elsewhere / "model.py", self.root / "a" / "model.py")
            ]
        self.assertEqual([99, 10], widths)

    def test_the_callers_own_modules_and_main_under_the_root_are_never_dropped(self) -> None:
        # A tool run from the design root, as CAD Explorer's writer is from the workbench, keeps what it imported.
        self.write("caller_helper.py", "VALUE = 1\n")
        sys.path.insert(0, str(self.root))
        import caller_helper

        self.addCleanup(sys.modules.pop, "caller_helper", None)
        main = type(sys)("__main__")
        main.__file__ = str(self.root / "driver.py")
        saved_main = sys.modules["__main__"]
        sys.modules["__main__"] = main
        self.addCleanup(sys.modules.__setitem__, "__main__", saved_main)
        script = self.write("review/model.py", "import widgets\n\ndef gen_step():\n    return widgets.SIZE\n")
        with mock.patch.object(Path, "cwd", return_value=self.root):
            for _ in range(2):
                call_generator(load_generator(script), "gen_step", script_path=script)
        self.assertIs(caller_helper, sys.modules["caller_helper"])
        self.assertIs(main, sys.modules["__main__"])

    def test_a_namespace_package_is_read_again_by_the_next_load(self) -> None:
        shapes = self.root / "src" / "shapes"
        shapes.mkdir()
        (shapes / "lid.py").write_text("SIZE = 1\n")
        first = self.write("review/first.py", "import shapes.lid\n\ndef gen_step():\n    return shapes.lid.SIZE\n")
        second = self.write("review/second.py", "from shapes import SIZE\n\ndef gen_step():\n    return SIZE\n")
        for name in ("shapes", "shapes.lid"):
            self.addCleanup(sys.modules.pop, name, None)
        with mock.patch.object(Path, "cwd", return_value=self.root):
            self.assertEqual(1, call_generator(load_generator(first), "gen_step", script_path=first))
            (shapes / "__init__.py").write_text("SIZE = 2\n")  # the folder becomes a regular package
            self.assertEqual(2, call_generator(load_generator(second), "gen_step", script_path=second))

    def test_a_project_module_named_like_a_tools_module_is_the_projects(self) -> None:
        import common.generator_module as tools_loader

        tools_common = sys.modules["common"]
        cases = (
            ("module", {"common.py": "WIDTH = 7.0\n"}, "from common import WIDTH\n\ndef gen_step():\n    return WIDTH\n"),
            ("package", {"common/__init__.py": "", "common/dims.py": "WIDTH = 8.0\n"},
             "from common.dims import WIDTH\n\ndef gen_step():\n    import common.dims\n    return WIDTH + common.dims.WIDTH\n"),
        )
        for kind, files, source in cases:
            with self.subTest(kind=kind):
                root = self.root / kind
                (root / "common").mkdir(parents=True, exist_ok=True)
                if kind == "module":
                    (root / "common").rmdir()
                for relative, text in files.items():
                    (root / relative).write_text(text)
                script = root / "model.py"
                script.write_text(source)
                with mock.patch.object(Path, "cwd", return_value=root):
                    value = call_generator(load_generator(script), "gen_step", script_path=script)
                self.assertEqual(7.0 if kind == "module" else 16.0, value)
                self.assertIs(tools_common, sys.modules["common"])
                self.assertIs(tools_loader, sys.modules["common.generator_module"])
                self.assertNotIn("common.dims", sys.modules)

    def test_project_modules_edited_within_the_same_second_are_read_again_by_the_next_load(self) -> None:
        # Bytecode writing is forced on and both edits keep their length and mtime, so a cached .pyc would pass as
        # current: the next load must still compile the package and its submodule from source.
        package = self.root / "src" / "widgets"
        script = self.write("review/model.py", "from widgets import SIZE\nfrom widgets.parts import WIDTH\n")
        stamp = 1_700_000_000_000_000_000
        seen = []
        with mock.patch.object(sys, "dont_write_bytecode", False), mock.patch.object(Path, "cwd", return_value=self.root):
            for size, width in (("12.0", "1.0"), ("34.0", "2.0")):
                for path, text in ((package / "__init__.py", f"SIZE = {size}\n"), (package / "parts.py", f"WIDTH = {width}\n")):
                    path.write_text(text)
                    os.utime(path, ns=(stamp, stamp))
                module = load_generator(script)
                seen.append((module.SIZE, module.WIDTH))
        self.assertEqual([(12.0, 1.0), (34.0, 2.0)], seen)
        self.assertFalse((package / "__pycache__").exists())

    def test_the_tools_own_modules_are_kept_when_the_design_root_holds_them(self) -> None:
        import common.generator_module as loader

        script = self.write("review/model.py", "VALUE = 1\n")
        with mock.patch.object(Path, "cwd", return_value=SCRIPTS_ROOT.parents[3]):
            load_generator(script)
        self.assertIs(loader, sys.modules["common.generator_module"])

    def test_a_missing_module_names_the_module_and_the_interpreter(self) -> None:
        script = self.write("review/vendor.py", "def gen_step():\n    import missing_vendor_package\n")
        with mock.patch.object(Path, "cwd", return_value=self.root):
            module = load_generator(script)
            with self.assertRaises(GeneratorImportError) as raised:
                call_generator(module, "gen_step", script_path=script, display_path="review/vendor.py")
        message = str(raised.exception)
        self.assertIn("review/vendor.py imports 'missing_vendor_package'", message)
        self.assertIn(sys.executable, message)

    def test_scripts_step_reports_a_missing_module_in_one_line(self) -> None:
        self.write("review/vendor.py", "from build123d import Box\nimport missing_vendor_package\n\ndef gen_step():\n    return Box(1, 1, 1)\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_ROOT / "step"), "review/vendor.py", "-o", "out/vendor.step"],
            cwd=self.root,
            env={**os.environ, "CAD_PILOT_CACHE": str(self.root / "cache")},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(2, result.returncode)
        self.assertNotIn("Traceback", result.stderr)
        self.assertRegex(result.stderr, r"^scripts/step: error: review/vendor\.py imports 'missing_vendor_package'")


if __name__ == "__main__":
    unittest.main()
