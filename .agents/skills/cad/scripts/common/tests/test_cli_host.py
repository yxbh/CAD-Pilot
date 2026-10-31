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

    def test_exit_status_crash_and_timeout_are_a_process_s(self) -> None:
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
