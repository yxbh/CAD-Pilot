import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build123d
from OCP.BRepMesh import BRepMesh_IncrementalMesh

from common import atomic_replace
from common.step_export import export_build123d_step_scene
from common.stl import export_shape_stl
from common.threemf import export_shape_3mf


def sharing_violation() -> PermissionError:
    error = PermissionError(13, "file is being used by another process")
    error.winerror = atomic_replace.WINDOWS_SHARING_VIOLATION
    return error


def access_denied() -> PermissionError:
    error = PermissionError(13, "Access is denied")
    error.winerror = atomic_replace.WINDOWS_ACCESS_DENIED
    return error


class ReplaceAtomicTests(unittest.TestCase):
    def setUp(self) -> None:
        tempdir = tempfile.TemporaryDirectory(prefix="cad-atomic-")
        self.addCleanup(tempdir.cleanup)
        self.root = Path(tempdir.name)

    def test_a_sharing_violation_is_retried_until_it_wins(self) -> None:
        attempts = []

        def flaky(source, target):
            attempts.append((source, target))
            if len(attempts) < 3:
                raise sharing_violation()

        with mock.patch.object(atomic_replace.os, "replace", side_effect=flaky), \
             mock.patch.object(atomic_replace.time, "sleep") as sleep:
            atomic_replace.replace_atomic("from.tmp", "to.step")

        self.assertEqual(3, len(attempts))
        self.assertEqual([(0.05,), (0.1,)], [call.args for call in sleep.call_args_list])

    def test_every_other_error_surfaces_at_once(self) -> None:
        # "to.step" does not exist: a denial with no file at the target is a real one.
        for winerror in (5, 2, None):
            error = PermissionError(13, "denied")
            if winerror is not None:
                error.winerror = winerror
            with self.subTest(winerror=winerror):
                with mock.patch.object(atomic_replace.os, "replace", side_effect=error), \
                     mock.patch.object(atomic_replace.time, "sleep") as sleep:
                    with self.assertRaises(PermissionError):
                        atomic_replace.replace_atomic("from.tmp", "to.step")
                sleep.assert_not_called()

    def test_a_denial_onto_an_existing_file_is_retried(self) -> None:
        # NTFS answers a rename over a file another process has open with WinError 5.
        source = self.root / "part.step.tmp"
        source.write_bytes(b"new")
        target = self.root / "part.step"
        target.write_bytes(b"old")
        attempts = []
        real_replace = os.replace

        def held_twice(src, dst):
            attempts.append(src)
            if len(attempts) <= 2:
                raise access_denied()
            real_replace(src, dst)

        with mock.patch.object(atomic_replace.os, "replace", side_effect=held_twice), \
             mock.patch.object(atomic_replace.time, "sleep"):
            atomic_replace.replace_atomic(source, target)

        self.assertEqual(b"new", target.read_bytes())
        self.assertEqual(3, len(attempts))

    def test_an_exhausted_ladder_retries_once_from_a_fresh_copy(self) -> None:
        source = self.root / "part.stl.tmp"
        source.write_bytes(b"solid")
        target = self.root / "part.stl"
        seen = []
        real_replace = os.replace

        def blocked_until_a_new_file(src, dst):
            seen.append(Path(src).name)
            if len(seen) <= len(atomic_replace.RETRY_DELAYS_SECONDS) + 1:
                raise sharing_violation()
            real_replace(src, dst)

        with mock.patch.object(atomic_replace.os, "replace", side_effect=blocked_until_a_new_file), \
             mock.patch.object(atomic_replace.time, "sleep"):
            atomic_replace.replace_atomic(source, target)

        self.assertEqual(b"solid", target.read_bytes())
        self.assertEqual(1, len(set(seen[:-1])))
        self.assertNotIn(seen[-1], seen[:-1])
        self.assertTrue(seen[-1].endswith(".tmp"))
        self.assertEqual([target.name], [path.name for path in self.root.iterdir()])

    def test_the_rescue_is_bounded_and_reports_the_rename_failure(self) -> None:
        source = self.root / "part.3mf.tmp"
        source.write_bytes(b"PK")
        target = self.root / "part.3mf"
        error = sharing_violation()

        with mock.patch.object(atomic_replace.os, "replace", side_effect=error) as replace, \
             mock.patch.object(atomic_replace.time, "sleep"):
            with self.assertRaises(PermissionError) as raised:
                atomic_replace.replace_atomic(source, target)

        self.assertIs(error, raised.exception)
        self.assertEqual(2 * (len(atomic_replace.RETRY_DELAYS_SECONDS) + 1), replace.call_count)
        self.assertEqual([], list(self.root.iterdir()))

    def test_replacing_writes_beside_the_target_and_cleans_up_on_failure(self) -> None:
        target = self.root / "nested" / "part.step"
        with atomic_replace.replacing(target) as temp_path:
            self.assertEqual(target.parent, temp_path.parent)
            temp_path.write_bytes(b"new")
        self.assertEqual(b"new", target.read_bytes())

        with self.assertRaises(RuntimeError):
            with atomic_replace.replacing(target) as temp_path:
                temp_path.write_bytes(b"half")
                raise RuntimeError("writer failed")
        self.assertEqual(b"new", target.read_bytes())
        self.assertEqual([target.name], [path.name for path in target.parent.iterdir()])

    @unittest.skipIf(os.name == "nt", "creating symlinks needs extra rights on Windows")
    def test_replacing_writes_through_a_symlink_and_keeps_permissions(self) -> None:
        shared = self.root / "shared" / "part.stl"
        shared.parent.mkdir()
        shared.write_bytes(b"old")
        shared.chmod(0o640)
        link = self.root / "project" / "part.stl"
        link.parent.mkdir()
        link.symlink_to(shared)

        with atomic_replace.replacing(link) as temp_path:
            self.assertEqual(shared.parent.resolve(), temp_path.parent)
            temp_path.write_bytes(b"new")

        self.assertTrue(link.is_symlink())
        self.assertEqual(b"new", shared.read_bytes())
        self.assertEqual(0o640, shared.stat().st_mode & 0o777)
        self.assertEqual(["part.stl"], [path.name for path in shared.parent.iterdir()])


class ArtifactWritersReplaceAtomicallyTests(unittest.TestCase):
    def setUp(self) -> None:
        tempdir = tempfile.TemporaryDirectory(prefix="cad-atomic-writers-")
        self.addCleanup(tempdir.cleanup)
        self.root = Path(tempdir.name)
        box = build123d.Box(10, 10, 10)
        BRepMesh_IncrementalMesh(box.wrapped, 0.1, False, 0.5, True).Perform()
        self.box = box
        self.writers = {
            "part.step": lambda path: export_build123d_step_scene(self.box, path),
            "part.stl": lambda path: export_shape_stl(self.box.wrapped, path),
            "part.3mf": lambda path: export_shape_3mf(self.box.wrapped, path),
        }

    def test_a_failed_rename_keeps_the_previous_file(self) -> None:
        for name, write in self.writers.items():
            with self.subTest(name=name):
                target = self.root / name
                target.write_bytes(b"previous")
                with mock.patch.object(atomic_replace.os, "replace", side_effect=OSError("disk full")):
                    with self.assertRaises(OSError):
                        write(target)
                self.assertEqual(b"previous", target.read_bytes())
                self.assertEqual([name], [path.name for path in self.root.iterdir() if path.name.startswith(name)])

    def test_a_successful_write_leaves_only_the_target(self) -> None:
        for name, write in self.writers.items():
            with self.subTest(name=name):
                target = self.root / name
                target.write_bytes(b"previous")
                write(target)
                self.assertNotEqual(b"previous", target.read_bytes())
                self.assertGreater(target.stat().st_size, 0)
                self.assertEqual([name], [path.name for path in self.root.iterdir() if path.name.startswith(name)])


if __name__ == "__main__":
    unittest.main()
