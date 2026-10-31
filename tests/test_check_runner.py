"""tools/stages.mjs scheduling, reporting and interruption, driven with stand-in stages."""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is needed for the check runner")


def _stage(name, code, **extra):
    return {"name": name, "command": NODE, "args": ["-e", code], **extra}


def _driver(tmp_path, stages):
    script = tmp_path / "driver.mjs"
    script.write_text(
        f"import {{ runStages }} from {json.dumps((ROOT / 'tools/stages.mjs').as_uri())};\n"
        f"await runStages({json.dumps(stages)}, "
        f"{{ cwd: {json.dumps(str(tmp_path))}, logs: {json.dumps(str(tmp_path / 'logs'))}, github: false }});\n",
        encoding="utf-8",
    )
    return [NODE, str(script)]


def _wait_for(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(0.05)


def test_failures_skip_their_dependents_and_piped_output_is_complete(tmp_path):
    command = _driver(tmp_path, [
        _stage("big", "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\nEND-BIG\\n')"),
        _stage("fails", "console.log('boom'); process.exit(3)"),
        _stage("after", "console.log('never')", needs=["fails"]),
    ])
    run = subprocess.run(command, capture_output=True, text=True, timeout=60)
    assert run.returncode == 1
    assert "END-BIG" in run.stdout and len(run.stdout) > 2 * 1024 * 1024
    assert "── ✖ fails failed after" in run.stdout
    assert "– after              skipped: needs fails" in run.stdout
    assert "never" not in run.stdout
    assert (tmp_path / "logs/fails.log").read_text(encoding="utf-8") == "boom\n"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_a_signal_stops_each_stage_tree_and_prints_what_it_wrote(tmp_path):
    grandchild = tmp_path / "grandchild.pid"
    slow = (
        "const { spawn } = require('node:child_process');"
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });"
        f"require('node:fs').writeFileSync({json.dumps(str(grandchild))}, String(child.pid));"
        "console.log('partial'); setInterval(() => {}, 1000);"
    )
    runner = subprocess.Popen(_driver(tmp_path, [
        _stage("slow", slow),
        _stage("quick", "console.log('done')"),
        _stage("later", "console.log('never')", needs=["slow"]),
    ]), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        log = tmp_path / "logs/slow.log"
        _wait_for(lambda: grandchild.exists() and log.exists() and "partial" in log.read_text(encoding="utf-8"))
        runner.send_signal(signal.SIGTERM)
        output, _ = runner.communicate(timeout=30)
    finally:
        runner.kill()
    assert runner.returncode == 143
    assert "── ✖ slow interrupted after" in output and "partial" in output
    assert "✔ quick passed after" in output
    assert "never" not in output

    def gone():
        try:
            os.kill(int(grandchild.read_text()), 0)
        except ProcessLookupError:
            return True
        return False
    _wait_for(gone, timeout=10)
