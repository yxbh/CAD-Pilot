"""The workbench's pytest-xdist scheduling (conftest.py), run on stand-in tests."""

import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

STAND_INS = textwrap.dedent(
    """\
    import os
    import time
    import unittest
    from pathlib import Path

    LOG = Path(__file__).with_name("log.txt")


    def note(text):
        with LOG.open("a") as log:
            log.write(f"{text} {os.environ['PYTEST_XDIST_WORKER']}\\n")


    class Shared(unittest.TestCase):
        @classmethod
        def setUpClass(cls):
            note("setup")

        def test_a(self):
            time.sleep(0.2)

        def test_b(self):
            time.sleep(0.2)

        def test_c(self):
            time.sleep(0.2)


    class Independent(unittest.TestCase):
        pass


    def independent(self):
        note("independent")
        time.sleep(0.5)


    for name in "abcdef":
        setattr(Independent, f"test_{name}", independent)
    """
)


# A test that kills its worker, beside quick ones that finish first.
CRASH = textwrap.dedent(
    """\
    import os
    import time
    from pathlib import Path


    def test_ok_1():
        pass


    def test_ok_2():
        pass


    def test_ok_3():
        pass


    def test_z_crashes_its_worker():
        time.sleep(0.5)
        with Path(__file__).with_name("log.txt").open("a") as log:
            log.write("crash\\n")
        os._exit(1)
    """
)


def _pytest(folder, files, *args):
    shutil.copy(ROOT / "conftest.py", folder / "conftest.py")
    for name, text in files.items():
        (folder / name).write_text(text, encoding="utf-8")
    # A hang fails here, by its timeout, rather than holding the suite.
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--rootdir", str(folder), str(folder), *args],
        cwd=folder, capture_output=True, text=True, timeout=120,
    )


def test_a_shared_class_fixture_is_built_once_and_independent_tests_spread(tmp_path):
    run = _pytest(tmp_path, {"test_stand_ins.py": STAND_INS}, "-n", "2")
    assert run.returncode == 0, run.stdout + run.stderr
    log = (tmp_path / "log.txt").read_text().splitlines()
    assert sum(line.startswith("setup ") for line in log) == 1, log
    assert len({line.split()[1] for line in log if line.startswith("independent ")}) == 2, log


def test_a_crashed_worker_reports_its_test_once_and_the_rest_still_run(tmp_path):
    run = _pytest(tmp_path, {"test_crash.py": CRASH}, "-n", "2", "--junitxml", str(tmp_path / "junit.xml"))
    assert run.returncode == 1, run.stdout + run.stderr
    assert (tmp_path / "log.txt").read_text().splitlines() == ["crash"], "the crashed test is not run again"
    assert "1 failed, 3 passed" in run.stdout, run.stdout
    junit = (tmp_path / "junit.xml").read_text()
    assert [junit.count(f'name="{name}"') for name in ("test_ok_1", "test_ok_2", "test_ok_3", "test_z_crashes_its_worker")] == [1, 1, 1, 1]


def test_an_explicit_distribution_mode_keeps_xdists_own(tmp_path):
    run = _pytest(tmp_path, {"test_stand_ins.py": STAND_INS}, "-n", "2", "--dist", "each")
    assert run.returncode == 0, run.stdout + run.stderr
    assert "18 passed" in run.stdout, "each test runs on every worker"
