"""Conventions every Playwright scenario script follows."""

from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
SCRIPTS = sorted(path for path in TESTS.glob("*.py")
                 if path.name != Path(__file__).name and "sync_playwright" in path.read_text(encoding="utf-8"))


def test_scenario_scripts_are_found():
    assert len(SCRIPTS) >= 10


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_scenarios_launch_chromium_through_the_shared_helper(script):
    # launch_chromium gives expectations the same 30 s as BrowserSession.wait(), not Playwright's 5 s.
    text = script.read_text(encoding="utf-8")
    assert "chromium.launch(" not in text
    assert "launch_chromium(playwright)" in text
