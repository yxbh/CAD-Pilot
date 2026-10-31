"""Test-run settings shared by every suite under the workbench."""

import ast
from functools import cache
from pathlib import Path

import pytest


@pytest.hookimpl(optionalhook=True)
def pytest_xdist_make_scheduler(config, log):
    # pytest-xdist: a unittest class that builds a fixture in setUpClass runs on one worker, so the fixture is built once;
    # every other test is its own unit of work, so a slow class of independent tests spreads across workers.
    from xdist.scheduler import LoadScopeScheduling

    root = Path(config.rootpath)

    @cache
    def classes_with_shared_setup(path):
        tree = ast.parse((root / path).read_text(encoding="utf-8"))
        return {
            node.name for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and any(isinstance(item, ast.FunctionDef) and item.name == "setUpClass" for item in node.body)
        }

    class SharedSetupScheduling(LoadScopeScheduling):
        def _split_scope(self, nodeid):
            path, _, rest = nodeid.partition("::")
            name = rest.partition("::")[0]
            return f"{path}::{name}" if name in classes_with_shared_setup(path) else nodeid

    return SharedSetupScheduling(config, log)
