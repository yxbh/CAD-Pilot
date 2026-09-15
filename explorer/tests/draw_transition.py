import argparse
import base64
import io
import json
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import expect, sync_playwright


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait(predicate, timeout=20):
                deadline = time.monotonic() + timeout
                while not predicate():
                    assert time.monotonic() < deadline, f"Timed out: {state()}"
                    page.wait_for_timeout(50)

            def settled():
                wait(lambda: state().get("rendered") and state()["rendered"]["revision"] == state()["revision"])

            wait(lambda: not state()["loading"] and state()["documentRevision"], 120)
            if state()["activeReviewId"]:
                page.request.post(url + "api/command", data={"name": "close_review", "input": {}})
            page.request.post(url + "api/command", data={"name": "fit_view", "input": {}})
            settled()
            viewport = page.locator(".viewport")
            canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            canvas.evaluate("""canvas => {
                window.firstCanvas = canvas;
                window.contextLosses = 0;
                window.initialPixels = canvas.toDataURL('image/png');
                window.viewportRects = [];
                canvas.addEventListener('webglcontextlost', () => window.contextLosses++);
                window.watchLayout = () => {
                    const r = document.querySelector('.viewport').getBoundingClientRect();
                    window.viewportRects.push([r.x, r.y, r.width, r.height]);
                    window.layoutFrame = requestAnimationFrame(window.watchLayout);
                };
                window.layoutFrame = requestAnimationFrame(window.watchLayout);
            }""")
            model_rect = viewport.bounding_box()
            assert model_rect["y"] <= 96, model_rect
            assert model_rect["height"] >= 0.8 * 920, model_rect
            model_ids = state()["rendered"]["geometryIds"]
            draw = page.get_by_role("button", name="Draw", exact=True)
            draw.hover()
            expect(page.get_by_role("tooltip").filter(has_text="Draw")).to_be_visible()
            draw.focus()
            expect(page.get_by_role("tooltip").filter(has_text="Draw")).to_be_visible()
            assert draw.inner_text() == ""
            draw.click()
            wait(lambda: state()["activeReviewId"] is not None)
            review_id = state()["activeReviewId"]
            stage = page.get_by_label("Drawing canvas")
            expect(stage).to_be_visible()
            page.wait_for_timeout(650)
            assert page.evaluate("window.contextLosses") == 0, "Draw triggered WebGL teardown"
            assert canvas.evaluate("canvas => window.firstCanvas === canvas")
            expect(page.get_by_role("alert")).to_have_count(0)
            assert viewport.bounding_box() == model_rect
            assert stage.bounding_box() == model_rect
            captured = page.request.get(url + f"api/reviews/{review_id}").json()
            stored_pixels = Image.open(io.BytesIO(base64.b64decode(captured["image"]["dataUrl"].split(",", 1)[1]))).convert("RGB")
            original_pixels = Image.open(io.BytesIO(base64.b64decode(page.evaluate("window.initialPixels").split(",", 1)[1]))).convert("RGB")
            assert stored_pixels.size == original_pixels.size
            difference = ImageStat.Stat(ImageChops.difference(stored_pixels, original_pixels)).mean
            assert max(difference) < 0.5, difference
            page.mouse.move(model_rect["x"] + 20, model_rect["y"] + 20)
            page.get_by_role("button", name="Pen", exact=True).focus()
            expect(page.get_by_role("tooltip").filter(has_text="Pen")).to_be_visible()
            for label in ["Pen", "Line", "Arrow", "Double arrow", "Rectangle", "Ellipse", "Highlight", "Erase",
                          "Undo drawing", "Redo drawing", "Clear drawing", "Copy marked image", "Save marked image"]:
                button = page.get_by_role("button", name=label, exact=True)
                assert button.inner_text() == "", label
                expect(button.locator("svg")).to_have_count(1)
            stage.focus()
            page.screenshot(path=str(output / "compact-draw-desktop.png"))
            for _ in range(3):
                page.get_by_role("button", name="Back to model", exact=True).click()
                wait(lambda: state()["activeReviewId"] is None)
                settled()
                assert viewport.bounding_box() == model_rect
                assert state()["rendered"]["geometryIds"] == model_ids
                assert canvas.evaluate("canvas => canvas === window.firstCanvas")
                page.get_by_label("Saved reviews").select_option(review_id)
                expect(page.get_by_label("Drawing canvas")).to_be_visible()
            rects = page.evaluate("() => { cancelAnimationFrame(window.layoutFrame); return window.viewportRects; }")
            expected = [model_rect["x"], model_rect["y"], model_rect["width"], model_rect["height"]]
            assert all(all(abs(a-b) < 0.5 for a, b in zip(rect, expected)) for rect in rects), "Transient layout shifts occurred during mode switches"
            assert page.evaluate("window.contextLosses") == 0
            expect(page.get_by_role("alert")).to_have_count(0)

            page.set_viewport_size({"width": 390, "height": 844})
            narrow = viewport.bounding_box()
            assert narrow["y"] <= 124, narrow
            assert narrow["height"] >= 0.7 * 844, narrow
            assert page.evaluate("document.documentElement.scrollHeight <= innerHeight + 1")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            buttons = page.locator(".drawing-toolbar button")
            toolbar = page.locator(".mode-toolbar").bounding_box()
            for index in range(buttons.count()):
                rect = buttons.nth(index).bounding_box()
                assert rect["y"] >= toolbar["y"] and rect["y"] + rect["height"] <= toolbar["y"] + toolbar["height"] + 1, rect
                assert rect["x"] >= 0 and rect["x"] + rect["width"] <= 390, rect
            page.screenshot(path=str(output / "compact-draw-narrow.png"))
            page.get_by_role("button", name="Back to model").click()
            wait(lambda: state()["activeReviewId"] is None)
            settled()
            assert viewport.bounding_box() == narrow
            page.screenshot(path=str(output / "compact-model-narrow.png"))
            assert page.evaluate("window.contextLosses") == 0
            # A real context-loss event remains visible; only intentional teardown is ignored.
            canvas.evaluate("canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()")
            expect(page.get_by_role("alert")).to_contain_text("Graphics context lost")
            assert not errors, errors
            report = {
                "desktopViewport": model_rect, "narrowViewport": narrow, "trackedFrames": len(rects),
                "sameCanvasAcrossModes": True, "geometryRetained": True, "modeSwitchContextLosses": 0,
                "noTransientLayoutShift": True, "cameraAndSnapshotPreserved": True, "hoverAndFocusTooltips": True,
                "genuineContextLossReported": True, "pageErrors": errors,
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
