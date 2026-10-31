"""Test-run settings shared by every suite under the workbench."""

import ast
from functools import cache
from pathlib import Path

import pytest


@pytest.hookimpl(optionalhook=True)
def pytest_xdist_make_scheduler(config, log):
    # pytest-xdist's `-n` distribution, refined: a unittest class whose own body defines setUpClass runs on one worker,
    # so its fixture is built once; every other test is its own unit of work, so a slow class of independent tests
    # spreads across workers. An explicit --dist mode other than load keeps xdist's own scheduler.
    if config.getvalue("dist") != "load":
        return None
    from xdist.scheduler import LoadScopeScheduling

    root = Path(config.rootpath)

    @cache
    def classes_with_shared_setup(path):
        try:
            tree = ast.parse((root / path).read_text(encoding="utf-8")) if path.endswith(".py") else None
        except (OSError, SyntaxError, UnicodeDecodeError):
            tree = None
        return {
            node.name for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and any(isinstance(item, ast.FunctionDef) and item.name == "setUpClass" for item in node.body)
        } if tree else set()

    class SharedSetupScheduling(LoadScopeScheduling):
        def _split_scope(self, nodeid):
            path, _, rest = nodeid.partition("::")
            name = rest.partition("::")[0]
            return f"{path}::{name}" if name in classes_with_shared_setup(path) else nodeid

        def remove_node(self, node):
            # A crashed worker's unfinished tests go back in the queue, except the one it was running, which xdist reports
            # as crashed. Requeuing finished units too (as LoadScopeScheduling does) would hand a replacement worker
            # a unit with nothing left to run, and the session would wait for it forever.
            workload = self.assigned_work.pop(node)
            unfinished = {scope: unit for scope, unit in workload.items() if not all(unit.values())}
            if not unfinished:
                return None
            crashitem = next(nodeid for unit in unfinished.values() for nodeid, done in unit.items() if not done)
            unfinished[self._split_scope(crashitem)][crashitem] = True
            self.workqueue.update((scope, unit) for scope, unit in unfinished.items() if not all(unit.values()))
            for other in self.assigned_work:
                self._reschedule(other)
            return crashitem

    return SharedSetupScheduling(config, log)
