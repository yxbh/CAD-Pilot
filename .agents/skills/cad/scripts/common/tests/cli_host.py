"""Runs the workbench's command-line tools for tests without starting Python for every run.

Starting Python and importing the CAD libraries takes longer than most runs of a tool. ``run`` hands each command to
a long-lived host (this file run as a script) that has imported build123d once, and the host runs it as
``python <tool> <args>`` would: the tool's ``__main__``, with the command's arguments, working folder, environment and
PYTHONPATH, nothing on standard input, and everything written to file descriptors 1 and 2 captured, as
``subprocess.run`` captures a child's. As at a process's exit, the command's other threads finish, its exit handlers
run (and stop the host, which cannot run them apart from its own) and C's buffered output is flushed. The workbench's
own modules, and a design project's, are imported afresh for each run and dropped after it, since some fix their
design root from the working folder when imported. The libraries stay loaded; of their state the host puts back what
the workbench's tools change, OCCT's message printers, and any other a command changes carries over to the next command
in that host, as do environment variables Python reads only as it starts, other than PYTHONPATH. A host runs one
command at a time, so a test process keeps as many as it runs commands at once. Each tool's launcher is still started
as a process of its own by its tests, and ``test_cli_host.py`` checks that commands answer alike either way.
"""

from __future__ import annotations

import atexit
import ctypes
import io
import json
import locale
import os
import queue
import runpy
import signal
import subprocess
import sys
import sysconfig
import tempfile
import threading
import traceback
import warnings
import weakref
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
            _kill(host)
            stdout, stderr = (_read(path, text, encoding) for path in outputs)
            raise subprocess.TimeoutExpired(command, timeout, stdout, stderr) from None
        if reply:
            reply = json.loads(reply)
            returncode = reply["returncode"]
            if reply["stop"]:
                host.stdin.close()
                host.wait()
            else:
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
            _kill(host)
    raise RuntimeError("A command-line host would not take a command")


def _start() -> subprocess.Popen:
    # In a group of its own, so that stopping it stops whatever its command started too.
    return subprocess.Popen(
        [sys.executable, str(_HOST)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"}, start_new_session=os.name != "nt",
    )


def _kill(host: subprocess.Popen) -> None:
    # On Windows a virtual environment's python.exe starts the interpreter as a child of its own, so the whole tree goes.
    if os.name == "nt":
        subprocess.run(["taskkill", "/pid", str(host.pid), "/t", "/f"], capture_output=True, check=False)
    else:
        try:
            os.killpg(host.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    host.wait()


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
            _kill(host)


# The host side.

_LIBRARIES = tuple(
    os.path.join(os.path.normcase(os.path.realpath(folder)), "")
    for folder in {sys.prefix, sys.base_prefix, sys.exec_prefix, *(sysconfig.get_paths()[name] for name in ("stdlib", "platstdlib", "purelib", "platlib"))}
)
# C's standard I/O, which C++ streams and OCCT's messages write through; a process flushes it as it exits.
_C = ctypes.CDLL("ucrtbase" if os.name == "nt" else None)
_EXIT_STATUS = 0xFFFFFFFF if os.name == "nt" else 0xFF


def _is_library(module) -> bool:
    spec = getattr(module, "__spec__", None)
    if spec is not None and spec.origin in ("built-in", "frozen"):
        return True
    files = [getattr(module, "__file__", None), *(getattr(module, "__path__", None) or [])]
    files = [file for file in files if file]
    return bool(files) and all(os.path.normcase(os.path.realpath(file)).startswith(_LIBRARIES) for file in files)


def _streams(env: dict):
    """New standard output and error, as a new Python process sets them up on redirected descriptors: its encoding
    and error handler (Python's own rules, from the command's environment) and line-buffered standard error."""
    encoding, _, errors = env.get("PYTHONIOENCODING", "").partition(":")
    utf8 = env.get("PYTHONUTF8") == "1"
    if not errors:
        plain_locale = locale.setlocale(locale.LC_CTYPE) in ("C", "POSIX", "C.UTF-8", "C.utf8")
        errors = "surrogateescape" if os.name == "nt" or utf8 or plain_locale else "strict"
    encoding = encoding or ("utf-8" if utf8 else locale.getpreferredencoding(False))
    stdout = io.TextIOWrapper(io.FileIO(1, "w", closefd=False), encoding=encoding, errors=errors)
    stderr = io.TextIOWrapper(io.FileIO(2, "w", closefd=False), encoding=encoding, errors="backslashreplace", line_buffering=True)
    return stdout, stderr


def _flush() -> None:
    for stream in (sys.stdout, sys.stderr):
        if not stream.closed:
            stream.flush()
    _C.fflush(None)


def _print_exception(exception: BaseException) -> None:
    # The traceback a process prints: from the script's own frames, not the host's or runpy's.
    frames = exception.__traceback__
    while frames and frames.tb_frame.f_code.co_filename in (__file__, runpy.__file__, "<frozen runpy>"):
        frames = frames.tb_next
    traceback.print_exception(type(exception), exception, frames)


def _run(job: dict, library_state) -> tuple[int, bool]:
    """Runs one command; returns its exit status and whether the host must stop after it."""
    script = job["script"]
    saved = dict(os.environ), os.getcwd(), sys.argv, list(sys.path), sys.stdout, sys.stderr, tempfile.tempdir
    modules, threads, exit_handlers = set(sys.modules), set(threading.enumerate()), atexit._ncallbacks()
    _flush()
    standard = [os.dup(fd) for fd in (0, 1, 2)]
    for fd, (path, flags) in enumerate([(os.devnull, os.O_RDONLY), *((output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC) for output in job["outputs"])]):
        opened = os.open(path, flags | getattr(os, "O_BINARY", 0))
        os.dup2(opened, fd)
        os.close(opened)
    os.environ.clear()
    os.environ.update(job["env"])
    os.chdir(job["cwd"])
    sys.stdout, sys.stderr = _streams(job["env"])
    sys.argv = [script, *job["args"]]
    # Python puts the script's folder first on the path, or the folder itself when it runs a folder's __main__.py,
    # then PYTHONPATH's folders; tempfile looks for its folder again.
    sys.path[0] = script if os.path.isdir(script) else os.path.dirname(os.path.abspath(script))
    sys.path[1:1] = [folder for folder in job["env"].get("PYTHONPATH", "").split(os.pathsep) if folder]
    tempfile.tempdir = None
    returncode, stop = 0, False
    try:
        with warnings.catch_warnings():
            runpy.run_path(script, run_name="__main__")
    except SystemExit as exit:
        if exit.code is None or isinstance(exit.code, int):
            returncode = int(exit.code or 0) & _EXIT_STATUS
        else:
            print(exit.code, file=sys.stderr)
            returncode = 1
    except KeyboardInterrupt as interrupt:
        _print_exception(interrupt)
        returncode = 0xC000013A if os.name == "nt" else -signal.SIGINT
    except BaseException as exception:
        _print_exception(exception)
        returncode = 1
    finally:
        # What happens as a process exits: its other threads finish and its exit handlers run, into its own output.
        # Exit handlers cannot be told apart from the host's, so a command that adds one stops its host.
        for thread in set(threading.enumerate()) - threads:
            if not thread.daemon:
                thread.join()
        if atexit._ncallbacks() > exit_handlers:
            atexit._run_exitfuncs()
            stop = True
        _flush()
        for fd, copy in enumerate(standard):
            os.dup2(copy, fd)
            os.close(copy)
        env, cwd, sys.argv, sys.path[:], sys.stdout, sys.stderr, tempfile.tempdir = saved
        os.environ.clear()
        os.environ.update(env)
        os.chdir(cwd)
        for name in set(sys.modules) - modules:
            if not _is_library(sys.modules[name]):
                del sys.modules[name]
        library_state()
    return returncode, stop


def _library_state():
    """What puts back the library state the workbench's tools change: OCCT's message printers, which reading or
    writing a STEP sends to standard error, and their trace levels, which STEP export turns down, for the rest of the
    process."""
    from OCP.Message import Message

    messenger = Message.DefaultMessenger_s()
    printers = [(printer, printer.GetTraceLevel()) for printer in messenger.Printers()]

    def restore():
        for printer in list(messenger.Printers()):
            messenger.RemovePrinter(printer)
        for printer, level in printers:
            printer.SetTraceLevel(level)
            messenger.AddPrinter(printer)

    return restore


def _serve() -> None:
    # Replies go out on the original standard output; anything else written there, now or by a command, goes to
    # standard error or the command's own capture.
    replies = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    import build123d  # noqa: F401  (loaded once for every command)

    # Python adds weakref.finalize's exit handler, which tempfile's folders use, only with the first one made: made here,
    # so that a command making one is not taken for a command adding an exit handler of its own.
    weakref.finalize(_serve, lambda: None).detach()
    restore = _library_state()
    for line in sys.stdin:
        returncode, stop = _run(json.loads(line), restore)
        replies.write(json.dumps({"returncode": returncode, "stop": stop}) + "\n")
        replies.flush()
        if stop:
            return


if __name__ == "__main__":
    _serve()
