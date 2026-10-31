"""The ray-traced view in a real browser: the page's Appearance settings set it and its sample counter shows.

Without a GPU the page keeps the Studio view and says so, as compiling the tracer in software would hold the browser's
GPU process for a minute or more; the test's capture traces in the background renderer, which has a browser of its own.
"""

import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import expect

from browser_session import BrowserSession, launch_chromium, sync_playwright


def run(url, output):
    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        try:
            page = browser.new_page(viewport={"width": 900, "height": 640})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            session = BrowserSession(page, url, errors)
            session.settled()
            page.get_by_role("button", name="Appearance settings").click()
            # The box follows the view, which changes once the command is answered.
            page.get_by_label("Ray traced").click()
            state = session.wait(lambda current: current["appearance"] == "raytraced" and current["rendered"]["revision"] == current["revision"])
            # A GPU compiles the tracer in seconds and counts samples; without one the page says it stays on Studio's view.
            status = page.locator(".trace-status")
            expect(status).to_have_text(re.compile(r"Ray traced · \d+ of 512 samples|Ray tracing needs a GPU"), timeout=60_000)
            report = {
                "appearance": state["appearance"], "status": status.inner_text(),
                "studioPressed": page.get_by_role("button", name="Studio appearance").get_attribute("aria-pressed"),
                "pageErrors": errors,
            }
            page.screenshot(path=str(Path(output) / "raytraced.png"))
            (Path(output) / "raytrace-browser.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(args.url, args.output)
