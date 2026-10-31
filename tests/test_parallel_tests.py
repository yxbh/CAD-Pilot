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


def test_a_shared_class_fixture_is_built_once_and_independent_tests_spread(tmp_path):
    shutil.copy(ROOT / "conftest.py", tmp_path / "conftest.py")
    (tmp_path / "test_stand_ins.py").write_text(STAND_INS, encoding="utf-8")
    run = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-n", "2", "-p", "no:cacheprovider", "--rootdir", str(tmp_path), str(tmp_path)],
        cwd=tmp_path, capture_output=True, text=True, timeout=120,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    log = (tmp_path / "log.txt").read_text().splitlines()
    assert sum(line.startswith("setup ") for line in log) == 1, log
    assert len({line.split()[1] for line in log if line.startswith("independent ")}) == 2, log
