"""Runs Playwright scenario scripts and their fixture scripts one after another in this process.

The Node tests start one host per test process (python-host.mjs). Each job is a JSON line on stdin naming a script
in this folder and its command-line arguments; the script runs as ``__main__``, exactly as from a command line, but
Playwright, Chromium and imports such as build123d start once for all of them. A scenario gets its own browser
contexts, closed when it finishes, from the one Chromium. Each job's result is a JSON line on stdout after MARK, so
anything else written to the process's stdout is only logged.
"""

import contextlib
import io
import json
import runpy
import sys
import traceback
from pathlib import Path

TESTS = Path(__file__).resolve().parent
MARK = "cad-explorer-test-host "
sys.path.insert(0, str(TESTS))

import browser_session  # noqa: E402  (after the folder is importable)


def run(job):
    script = TESTS / job["script"]
    stdout, stderr = io.StringIO(), io.StringIO()
    argv, sys.argv = sys.argv, [str(script), *job["args"]]
    code = 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            runpy.run_path(str(script), run_name="__main__")
    except SystemExit as exit:
        code = exit.code if isinstance(exit.code, int) else (0 if exit.code is None else 1)
        if not isinstance(exit.code, int) and exit.code is not None:
            print(exit.code, file=stderr)
    except BaseException:
        traceback.print_exc(file=stderr)
        code = 1
    finally:
        sys.argv = argv
    return {"code": code, "stdout": stdout.getvalue(), "stderr": stderr.getvalue()}


def main():
    protocol = sys.stdout
    with browser_session.host():
        for line in sys.stdin:
            result = run(json.loads(line))
            protocol.write(MARK + json.dumps(result) + "\n")
            protocol.flush()


if __name__ == "__main__":
    main()
