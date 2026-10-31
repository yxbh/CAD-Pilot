"""Runs the workbench's command-line tools for tests without starting Python for every run.

Starting Python and importing the CAD libraries takes longer than most runs of a tool. ``run`` hands each command to
a long-lived host (this file run as a script) that has imported build123d once, and the host runs it as
``python <tool> <args>`` would: the tool's ``__main__``, with the command's arguments, working folder and environment,
nothing on standard input, and everything written to file descriptors 1 and 2 captured, as ``subprocess.run``
captures a child's. The workbench's own modules, and a design project's, are imported afresh for each run and dropped
after it, since some fix their design root from the working folder when imported; the libraries stay loaded. A host
runs one command at a time, so a test process keeps as many as it runs commands at once. Each tool's launcher is still
started as a process of its own by its tests (``scripts/*/tests/test_cli.py``), and ``test_cli_host.py`` checks that
commands answer alike either way.
"""

from __future__ import annotations

import atexit
import io
import json
import locale
import os
import queue
import runpy
import subprocess
import sys
import sysconfig
import tempfile
import threading
import traceback
import warnings
from pathlib import Path

_HOST = Path(__file__).resolve()
_idle: list[subprocess.Popen] = []
_lock = threading.Lock()


def run(script, *args: str, cwd, env=None, timeout: float = 600, text: bool = True, encoding: str | None = None) -> subprocess.CompletedProcess:
    """``subprocess.run([sys.executable, script, *args], cwd=cwd, env=env, capture_output=True, timeout=timeout,
    text=text, encoding=encoding)``, run in a host."""
    command = [sys.executable, str(script), *args]
    with tempfile.TemporaryDirectory(prefix="cli-run-") as folder:
        outputs = [os.path.join(folder, name) for name in ("stdout", "stderr")]
        job = {"script": str(script), "args": list(args), "cwd": str(cwd), "env": dict(os.environ if env is None else env), "outputs": outputs}
        host = _send(job)
        replies: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: replies.put(host.stdout.readline()), daemon=True).start()
        try:
            reply = replies.get(timeout=timeout)
        except queue.Empty:
            host.kill()
            host.wait()
            stdout, stderr = (_read(path, text, encoding) for path in outputs)
            raise subprocess.TimeoutExpired(command, timeout, stdout, stderr) from None
        if reply:
            returncode = json.loads(reply)["returncode"]
            with _lock:
                _idle.append(host)
        else:
            # The host died with the command, as its own process would have: its exit status is the command's.
            returncode = host.wait()
        stdout, stderr = (_read(path, text, encoding) for path in outputs)
    return subprocess.CompletedProcess(command, returncode, stdout, stderr)


def _send(job: dict) -> subprocess.Popen:
    """An idle host, or a new one, that has taken the job; an idle host that has since gone is replaced."""
    with _lock:
        host = _idle.pop() if _idle else None
    for host in [host, None]:
        if host is None or host.poll() is not None:
            host = _start()
        try:
            host.stdin.write(json.dumps(job) + "\n")
            host.stdin.flush()
            return host
        except OSError:
            host.kill()
    raise RuntimeError("A command-line host would not take a command")


def _start() -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, str(_HOST)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )


def _read(path: str, text: bool, encoding: str | None):
    data = Path(path).read_bytes() if os.path.exists(path) else b""
    if not text and encoding is None:
        return data
    # As subprocess.run decodes in text mode: the locale's encoding unless one is given, and universal newlines.
    return data.decode(encoding or locale.getpreferredencoding(False)).replace("\r\n", "\n").replace("\r", "\n")


@atexit.register
def _stop_hosts() -> None:
    for host in _idle:
        host.stdin.close()
    for host in _idle:
        try:
            host.wait(timeout=5)
        except subprocess.TimeoutExpired:
            host.kill()


# The host side.

_LIBRARIES = tuple(
    os.path.normcase(os.path.realpath(folder))
    for folder in {sys.prefix, sys.base_prefix, sys.exec_prefix, *(sysconfig.get_paths()[name] for name in ("stdlib", "platstdlib", "purelib", "platlib"))}
)


def _is_library(module) -> bool:
    spec = getattr(module, "__spec__", None)
    if spec is not None and spec.origin in ("built-in", "frozen"):
        return True
    files = [getattr(module, "__file__", None), *(getattr(module, "__path__", None) or [])]
    files = [file for file in files if file]
    return bool(files) and all(os.path.normcase(os.path.realpath(file)).startswith(_LIBRARIES) for file in files)


def _stream(fd: int, env: dict, errors: str):
    # The encoding a new Python process gives a redirected standard stream.
    encoding = env.get("PYTHONIOENCODING", "").split(":")[0] or ("utf-8" if env.get("PYTHONUTF8") == "1" else locale.getpreferredencoding(False))
    return io.TextIOWrapper(io.FileIO(fd, "w", closefd=False), encoding=encoding, errors=errors)


def _run(job: dict) -> int:
    script = job["script"]
    saved = dict(os.environ), os.getcwd(), sys.argv, list(sys.path), sys.stdout, sys.stderr
    modules = set(sys.modules)
    sys.stdout.flush()
    sys.stderr.flush()
    standard = [os.dup(fd) for fd in (0, 1, 2)]
    for fd, (path, flags) in enumerate([(os.devnull, os.O_RDONLY), *((output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC) for output in job["outputs"])]):
        opened = os.open(path, flags | getattr(os, "O_BINARY", 0))
        os.dup2(opened, fd)
        os.close(opened)
    os.environ.clear()
    os.environ.update(job["env"])
    os.chdir(job["cwd"])
    sys.stdout, sys.stderr = _stream(1, job["env"], "strict"), _stream(2, job["env"], "backslashreplace")
    sys.argv = [script, *job["args"]]
    # Python puts the script's folder first on the path, or the folder itself when it runs a folder's __main__.py.
    sys.path[0] = script if os.path.isdir(script) else os.path.dirname(os.path.abspath(script))
    returncode = 0
    try:
        with warnings.catch_warnings():
            runpy.run_path(script, run_name="__main__")
    except SystemExit as exit:
        if exit.code is None or isinstance(exit.code, int):
            returncode = exit.code or 0
        else:
            print(exit.code, file=sys.stderr)
            returncode = 1
    except BaseException:
        traceback.print_exc()
        returncode = 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        for fd, copy in enumerate(standard):
            os.dup2(copy, fd)
            os.close(copy)
        env, cwd, sys.argv, sys.path[:], sys.stdout, sys.stderr = saved
        os.environ.clear()
        os.environ.update(env)
        os.chdir(cwd)
        for name in set(sys.modules) - modules:
            if not _is_library(sys.modules[name]):
                del sys.modules[name]
    return returncode


def _serve() -> None:
    # Replies go out on the original standard output; anything else written there, now or by a command, goes to
    # standard error or the command's own capture.
    replies = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    import build123d  # noqa: F401  (loaded once for every command)

    for line in sys.stdin:
        replies.write(json.dumps({"returncode": _run(json.loads(line))}) + "\n")
        replies.flush()


if __name__ == "__main__":
    _serve()
