import argparse
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


def check_viewer(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.context.grant_permissions(["clipboard-read", "clipboard-write"])
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            canvas = page.locator("canvas").first
            canvas.wait_for(state="visible")
            page.get_by_role("button", name="Jump to top view", exact=True).wait_for()
            page.screenshot(path=str(output / "desktop.png"))
            pixels = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            extrema = pixels.getextrema()
            assert max(high - low for low, high in extrema) > 30, "Canvas appears blank"
            page.get_by_role("button", name="Jump to top view", exact=True).click()
            after = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            assert ImageChops.difference(pixels, after).getbbox(), "View control did not change the canvas"
            bounds = canvas.bounding_box()
            canvas.click(position={"x": bounds["width"] * 0.5, "y": bounds["height"] * 0.5})
            page.screenshot(path=str(output / "selection.png"))
            reference_button = page.get_by_role("button", name=re.compile(r"^Copy @cad\["))
            reference_button.click()
            reference = page.evaluate("navigator.clipboard.readText()")
            assert re.fullmatch(r"@cad\[outputs/mounting_plate#f\d+\]", reference), reference
            page.get_by_role("button", name="Draw", exact=True).click()
            assert page.get_by_role("button", name="Draw", exact=True).get_attribute("aria-pressed") == "true"
            page.mouse.move(bounds["x"] + bounds["width"] * 0.45, bounds["y"] + bounds["height"] * 0.45)
            page.mouse.down()
            page.mouse.move(bounds["x"] + bounds["width"] * 0.55, bounds["y"] + bounds["height"] * 0.55, steps=12)
            page.mouse.up()
            page.screenshot(path=str(output / "drawing.png"))
            page.get_by_role("button", name="Select", exact=True).click()
            page.set_viewport_size({"width": 390, "height": 844})
            page.get_by_role("button", name="Reset to default isometric view", exact=True).focus()
            page.keyboard.press("Enter")
            page.screenshot(path=str(output / "mobile.png"))
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Horizontal overflow"
            assert not errors, errors
            report = {"url": url, "copiedReference": reference, "pageErrors": errors, "screenshots": ["desktop.png", "selection.png", "drawing.png", "mobile.png"]}
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report, indent=2))
            print("Viewer canvas, camera control, face-reference copying, draw mode, and mobile width checks passed.")
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    check_viewer(arguments.url, arguments.output)