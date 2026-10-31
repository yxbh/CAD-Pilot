"""How ``@cad`` paths are written: relative to the design root, absolute, or leading ``..``."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from common import step_targets
from common.cad_ref_syntax import normalize_cad_path


class NormalizeCadPathTests(unittest.TestCase):
    def test_accepted_spellings(self) -> None:
        cases = {
            "outputs/plate.step": "outputs/plate",
            "outputs/plate.STP": "outputs/plate",
            "outputs\\plate.step": "outputs/plate",
            "/home/me/parts/plate.step": "/home/me/parts/plate",
            "../vendor/plate.step": "../vendor/plate",
            "../../plate": "../../plate",
            "C:\\Users\\me\\plate.step": "C:/Users/me/plate",
            "C:/Users/me/plate": "C:/Users/me/plate",
            "outputs/plate/": "outputs/plate",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(expected, normalize_cad_path(raw))

    def test_rejected_spellings(self) -> None:
        for raw in ("", "/", "..", "./plate", "outputs/../plate", "outputs//plate", "/home/../plate", "C:/"):
            with self.subTest(raw=raw):
                self.assertIsNone(normalize_cad_path(raw))


class CanonicalCadPathTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="cad-paths-")
        self.addCleanup(temp.cleanup)
        base = Path(temp.name).resolve()
        self.root = base / "design"
        (self.root / "parts").mkdir(parents=True)
        (self.root / "parts" / "foo.step").write_text("ISO-10303-21;\n")
        (base / "vendor.step").write_text("ISO-10303-21;\n")
        self.base = base
        patcher = mock.patch.object(step_targets, "REPO_ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_steps_inside_the_root_are_reported_from_the_root(self) -> None:
        for raw in (f"{self.root.as_posix()}/parts/foo", "/parts/foo", "parts/foo"):
            with self.subTest(raw=raw):
                self.assertEqual("parts/foo", step_targets.canonical_cad_path(raw))

    def test_steps_outside_the_root_keep_their_path(self) -> None:
        self.assertEqual("../vendor", step_targets.canonical_cad_path("../vendor"))
        outside = f"{self.base.as_posix()}/vendor"
        self.assertEqual(outside, step_targets.canonical_cad_path(outside))

    def test_tokens_and_targets_use_the_canonical_path(self) -> None:
        (token,) = step_targets.cad_tokens(f"@cad[{self.root.as_posix()}/parts/foo#o1.2.f3]")
        self.assertEqual(("parts/foo", ("o1.2.f3",)), (token.cad_path, token.selectors))
        self.assertEqual("parts/foo", step_targets.entry_target_from_target("/parts/foo.step").cad_path)


if __name__ == "__main__":
    unittest.main()
