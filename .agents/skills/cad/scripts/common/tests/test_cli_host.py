"""Commands run in a test host (cli_host.py) answer as they do in a process of their own."""

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from build123d import Box, Compound, Pos, export_step

from common.tests import cli_host

INSPECT = Path(__file__).resolve().parents[2] / "inspect"
# The least a Python process needs to start: Windows needs SYSTEMROOT.
BARE = {name: os.environ[name] for name in ("PATH", "SYSTEMROOT") if name in os.environ}


def own_process(script, *args, cwd, env=None):
    return subprocess.run([sys.executable, str(script), *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=300, check=False)


class CliHostTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="cli host ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()

    def script(self, name: str, source: str) -> Path:
        path = self.root / name
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        return path

    def test_commands_answer_alike_from_folder_to_folder(self) -> None:
        base = Box(20, 20, 4)
        base.label = "base"
        lid = Pos(0, 0, 3) * Box(20, 20, 2)
        lid.label = "lid"
        (self.root / "kits").mkdir()
        export_step(Compound(children=[base, lid], label="kit"), self.root / "kits" / "kit.step")
        # The design root is the working folder, which the inspect modules fix when imported: the host's second run,
        # from another folder, names the parts from there, as a new process does.
        for cwd, args in [(self.root, ("parts", "kits/kit.step")), (self.root / "kits", ("parts", "kit.step")), (self.root, ("parts", "missing.step"))]:
            with self.subTest(cwd=cwd.name, args=args):
                expected, actual = own_process(INSPECT, *args, cwd=cwd), cli_host.run(INSPECT, *args, cwd=cwd)
                self.assertEqual((expected.returncode, expected.stdout, expected.stderr), (actual.returncode, actual.stdout, actual.stderr))

    def test_a_command_gets_its_own_environment_folder_arguments_and_no_input(self) -> None:
        script = self.script("show.py", """\
            import os, sys
            print(os.environ.get("CLI_HOST_PROBE"), os.path.basename(os.getcwd()), sys.argv[1:], repr(sys.stdin.read()))
            print("to stderr", file=sys.stderr)
            os.write(1, b"straight to the descriptor\\n")
        """)
        (self.root / "elsewhere").mkdir()
        runs = [(self.root / "elsewhere", ("a", "b c"), {**BARE, "CLI_HOST_PROBE": "set"}), (self.root, (), BARE)]
        for cwd, args, env in runs:
            with self.subTest(cwd=cwd.name, args=args):
                expected, actual = own_process(script, *args, cwd=cwd, env=env), cli_host.run(script, *args, cwd=cwd, env=env)
                self.assertEqual((expected.returncode, expected.stdout, expected.stderr), (actual.returncode, actual.stdout, actual.stderr))
                self.assertIn(f"{env.get('CLI_HOST_PROBE')} {cwd.name} {list(args)} ''", actual.stdout)

    def assertAlike(self, script, *args, cwd=None) -> subprocess.CompletedProcess:
        cwd = cwd or self.root
        expected, actual = own_process(script, *args, cwd=cwd), cli_host.run(script, *args, cwd=cwd)
        self.assertEqual((expected.returncode, expected.stdout, expected.stderr), (actual.returncode, actual.stdout, actual.stderr))
        return actual

    def test_a_command_ends_as_its_process_would(self) -> None:
        library = '"ucrtbase" if os.name == "nt" else None'
        scripts = {
            # C's buffered output is flushed, and only into this command's capture.
            "c_output.py": f"import ctypes, os\nctypes.CDLL({library}).printf(b'from C')\n",
            # Standard error is line-buffered: a line written before the process dies is kept.
            "dies.py": "import os, sys\nprint('last words', file=sys.stderr)\nos._exit(4)\n",
            "exit_handler.py": "import atexit\natexit.register(print, 'at exit')\nprint('running')\n",
            "thread.py": "import threading, time\nthreading.Thread(target=lambda: (time.sleep(0.2), print('thread done'))).start()\n",
            "exits_256.py": "import sys\nsys.exit(256)\n",
            "raises.py": "raise ValueError('bad input')\n",
        }
        for name, source in scripts.items():
            with self.subTest(name):
                self.assertAlike(self.script(name, source))

    def test_a_command_that_makes_a_temporary_folder_leaves_its_host_running(self) -> None:
        script = self.script("temporary.py", "import os, tempfile\nwith tempfile.TemporaryDirectory():\n    print(os.getpid())\n")
        first, second = (cli_host.run(script, cwd=self.root) for _ in range(2))
        self.assertEqual((0, first.stdout), (second.returncode, second.stdout))

    def test_message_levels_one_command_turns_down_are_back_for_the_next(self) -> None:
        # STEP export turns OCCT's messages down to failures for the rest of a process.
        quiet = self.script("quiet.py", """\
            from OCP.Message import Message, Message_Gravity
            for printer in Message.DefaultMessenger_s().Printers():
                printer.SetTraceLevel(Message_Gravity.Message_Fail)
        """)
        warns = self.script("warns.py", """\
            from OCP.Message import Message, Message_Gravity
            Message.DefaultMessenger_s().Send("probe warning", Message_Gravity.Message_Warning)
        """)
        cli_host.run(quiet, cwd=self.root)
        self.assertIn("probe warning", self.assertAlike(warns).stdout)

    def test_crash_and_timeout_are_a_process_s(self) -> None:
        exits = self.script("exits.py", "import sys\nsys.exit(3)\n")
        crashes = self.script("crashes.py", "import os\nprint('partial', flush=True)\nos._exit(5)\n")
        hangs = self.script("hangs.py", "import time\ntime.sleep(60)\n")
        self.assertEqual(3, cli_host.run(exits, cwd=self.root).returncode)
        crashed = cli_host.run(crashes, cwd=self.root)
        self.assertEqual((5, "partial\n"), (crashed.returncode, crashed.stdout))
        with self.assertRaises(subprocess.TimeoutExpired):
            cli_host.run(hangs, cwd=self.root, timeout=1)
        # A host that died or was stopped is replaced for the next command.
        self.assertEqual(3, cli_host.run(exits, cwd=self.root).returncode)
