"""CI's shares of the test files (tools/shares.mjs), which tools/check.mjs --share runs."""

import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is needed for the check runner")

# A pytest plugin that notes each test file pytest would import, and imports none of them.
FILES_ONLY = textwrap.dedent(
    """\
    import os

    import pytest


    class Unread(pytest.File):
        def collect(self):
            return []


    @pytest.hookimpl(tryfirst=True)
    def pytest_pycollect_makemodule(module_path, parent):
        with open(os.environ["COLLECTED"], "a", encoding="utf-8") as collected:
            collected.write(module_path.relative_to(parent.config.rootpath).as_posix() + "\\n")
        return Unread.from_parent(parent, path=module_path)
    """
)


def _shares(code):
    script = f"import * as shares from {json.dumps((ROOT / 'tools' / 'shares.mjs').as_uri())};\nconsole.log(JSON.stringify({code}));"
    run = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_every_job_count_runs_each_test_file_exactly_once_on_every_platform():
    found = _shares("""(() => {
      const files = { python: shares.pythonTestFiles(), explorer: shares.explorerTestFiles() };
      const split = {};
      for (const platform of ["darwin", "linux", "win32"]) {
        for (const count of [1, 5, 6, 7]) split[`${platform} ${count}`] = shares.shares(count, { platform });
      }
      return { ...files, split };
    })()""")
    assert found["python"] and found["explorer"]
    for name, jobs in found["split"].items():
        for suite in ("python", "explorer"):
            assert sorted(file for job in jobs for file in job[suite]) == found[suite], (name, suite)


def test_the_python_files_are_those_pytest_collects(tmp_path):
    (tmp_path / "files_only.py").write_text(FILES_ONLY, encoding="utf-8")
    collected = tmp_path / "collected.txt"
    collected.touch()
    run = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "files_only", "-p", "no:cacheprovider"],
        cwd=ROOT, env={**os.environ, "PYTHONPATH": str(tmp_path), "COLLECTED": str(collected)},
        capture_output=True, text=True, timeout=120,
    )
    assert run.returncode == pytest.ExitCode.NO_TESTS_COLLECTED, run.stdout + run.stderr
    assert sorted(collected.read_text(encoding="utf-8").splitlines()) == _shares("shares.pythonTestFiles()")
