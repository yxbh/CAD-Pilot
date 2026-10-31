"""Assembly steps in a real browser: renders and captures wait for a step to settle, and drafts never strand the view.

Runs against the demo, whose sequence lifts the four spacers 45 mm and the cover 70 mm.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

from browser_session import BrowserSession, launch_chromium

SPACER_LIFT, COVER_LIFT = 45, 70


def positions(state):
    return {item["id"]: item["position"] for item in state["rendered"]["positions"]}


def lift(state, assembled):
    """Height above the assembled pose, per part label."""
    labels = {part["id"]: part["label"] for part in state["parts"]}
    return {labels[node]: round(position[2] - assembled[node][2], 3) for node, position in positions(state).items()}


def section_max(page):
    page.get_by_role("button", name="Section view").click()
    value = float(page.get_by_label("Section plane position").get_attribute("max"))
    page.get_by_role("button", name="Close section view settings").click()
    return value


def run(url, output):
    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            session = BrowserSession(page, url, errors)
            state = session.settled()
            assert [step["title"] for step in state["assembly"]["steps"]] == [
                "Stand the four spacers on the base plate", "Lay the cover plate on the spacers"], state["assembly"]
            assembled = positions(state)
            session.command("set_section", {"axis": "z"})
            assembled_max = section_max(page)

            # The command commits at once; the renderer reports only after the parts have finished moving.
            response = page.request.post(url + "api/command", data={"name": "set_step", "input": {"step": 0}})
            assert response.ok, response.text()
            committed = response.json()["revision"]
            moving = session.state()
            reported_while_moving = moving["rendered"] is not None and moving["rendered"]["revision"] == committed
            capture = page.request.post(url + "api/capture")
            assert capture.ok, capture.text()
            captured = capture.json()
            state = session.settled()
            apart = lift(state, assembled)
            exploded_max = section_max(page)

            session.command("set_step", {"mode": "buildup"})
            buildup = session.state()
            buildup_max = section_max(page)

            # A cancelled slider drag must not hold the displayed step away from the committed one.
            session.command("set_step", {"mode": "exploded"})
            page.evaluate("""() => {
                const input = document.querySelector('input[aria-label="Assembly step"]');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1.4');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
            }""")
            after_cancel = session.command("set_step", {"step": 1})
            off = session.command("set_step", {"off": True})
            report = {
                "reportedWhileMoving": reported_while_moving,
                "capturedStep": captured["step"],
                "renderedStep": state["rendered"]["step"],
                "apart": apart,
                "buildupVisibleParts": buildup["rendered"]["visibleParts"],
                "sectionMax": {"assembled": assembled_max, "exploded": exploded_max, "buildup": buildup_max},
                "afterCancelStep": after_cancel["rendered"]["step"],
                "afterCancelLift": lift(after_cancel, assembled),
                "offStep": off["step"],
                "offLift": lift(off, assembled),
                "pageErrors": errors,
            }
            (Path(output) / "assembly-browser.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(args.url, args.output)
