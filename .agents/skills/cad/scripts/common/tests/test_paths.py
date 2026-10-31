import os
import unittest
from pathlib import Path, PurePosixPath

from common.paths import command_line_path, relative_path


class RelativePathTests(unittest.TestCase):
    def test_either_separator_gives_posix_parts(self) -> None:
        self.assertEqual(PurePosixPath("parts/leaf.step"), relative_path("parts/leaf.step"))
        self.assertEqual(PurePosixPath("parts/leaf.step"), relative_path("parts\\leaf.step"))
        self.assertEqual(PurePosixPath("../shared/leaf.step"), relative_path("..\\shared/leaf.step"))

    def test_roots_drives_and_shares_are_not_relative(self) -> None:
        for value in ["/parts/leaf.step", "\\parts\\leaf.step", "D:/parts/leaf.step", "D:\\parts\\leaf.step",
                      "D:leaf.step", "\\\\server\\share\\leaf.step"]:
            with self.subTest(value=value):
                self.assertIsNone(relative_path(value))

    def test_empty_and_current_folder_are_not_paths(self) -> None:
        for value in ["", ".", "./"]:
            with self.subTest(value=value):
                self.assertIsNone(relative_path(value))


class CommandLinePathTests(unittest.TestCase):
    def test_a_relative_path_takes_either_separator_from_the_current_folder(self) -> None:
        self.assertEqual((Path.cwd() / "parts" / "leaf.step").resolve(), command_line_path("parts\\leaf.step"))

    def test_an_anchor_that_is_not_absolute_here_is_refused(self) -> None:
        foreign = "\\parts\\leaf.step" if os.name == "nt" else "C:\\parts\\leaf.step"
        with self.assertRaisesRegex(ValueError, "absolute on this system"):
            command_line_path(foreign)


if __name__ == "__main__":
    unittest.main()
