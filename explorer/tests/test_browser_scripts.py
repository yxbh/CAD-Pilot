"""Conventions every Playwright scenario script follows."""

import re
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
HELPERS = {Path(__file__).name, "browser_session.py", "browser_host.py"}
SCRIPTS = sorted(path for path in TESTS.glob("*.py")
                 if path.name not in HELPERS and "sync_playwright" in path.read_text(encoding="utf-8"))


def test_scenario_scripts_are_found():
    assert len(SCRIPTS) >= 10


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_scenarios_take_playwright_and_chromium_from_browser_session(script):
    # browser_session's sync_playwright and launch_chromium let browser_host.py run the scenario on its shared Chromium,
    # and give expectations the same 30 s as BrowserSession.wait(), not Playwright's 5 s.
    text = script.read_text(encoding="utf-8")
    assert "chromium.launch(" not in text
    assert "launch_chromium(playwright)" in text
    assert not re.search(r"^from playwright\.sync_api import .*\bsync_playwright\b", text, re.M)
    assert re.search(r"^from browser_session import .*\bsync_playwright\b", text, re.M)
