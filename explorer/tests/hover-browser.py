import argparse
import io
import json
import time
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1000, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait_state(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while True:
                    current = state()
                    if predicate(current):
                        return current
                    assert time.monotonic() < deadline, f"State did not settle: {current}"
                    page.wait_for_timeout(50)

            ready = wait_state(lambda current: not current["loading"] and len(current["parts"]) > 1, timeout=120)
            canvas = page.locator('canvas[aria-label="Interactive STEP assembly"]')
            bounds = canvas.bounding_box()
            point = {"x": bounds["width"] * 0.5, "y": bounds["height"] * 0.5}

            page.get_by_role("button", name="Faces", exact=True).click()
            face_mode = wait_state(lambda current: current["selectionMode"] == "face")
            page.mouse.move(bounds["x"] + 2, bounds["y"] + 2)
            page.wait_for_timeout(100)
            face_baseline = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            canvas.hover(position=point)
            page.wait_for_timeout(100)
            face_hover = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            assert ImageChops.difference(face_baseline, face_hover).getbbox(), "Face hover did not change the rendered preview"
            after_face_hover = state()
            assert after_face_hover["revision"] == face_mode["revision"]
            assert after_face_hover["selectedIds"] == ready["selectedIds"]
            assert after_face_hover["selectedFace"] == ready["selectedFace"]
            face_hover.save(output / "face-hover.png")

            page.get_by_role("button", name="Parts", exact=True).click()
            part_mode = wait_state(lambda current: current["selectionMode"] == "part")
            page.mouse.move(bounds["x"] + 2, bounds["y"] + 2)
            page.wait_for_timeout(100)
            part_baseline = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            canvas.hover(position=point)
            page.wait_for_timeout(100)
            part_hover = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            assert ImageChops.difference(part_baseline, part_hover).getbbox(), "Part hover did not change the rendered preview"
            assert ImageChops.difference(face_hover, part_hover).getbbox(), "Face and part hover previews must remain distinct"
            after_part_hover = state()
            assert after_part_hover["revision"] == part_mode["revision"]
            assert after_part_hover["selectedIds"] == ready["selectedIds"]
            assert after_part_hover["selectedFace"] == ready["selectedFace"]
            part_hover.save(output / "part-hover.png")

            page.get_by_role("button", name="Faces", exact=True).click()
            restored = wait_state(lambda current: current["selectionMode"] == "face")
            assert not errors, errors
            report = {
                "facePreviewChanged": True,
                "partPreviewChanged": True,
                "previewsDiffer": True,
                "selectionUnchanged": True,
                "restoredMode": restored["selectionMode"],
                "pageErrors": errors,
            }
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.url, args.output)
