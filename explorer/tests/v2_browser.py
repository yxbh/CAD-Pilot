import argparse
import base64
import io
import json
import time
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 1100}, permissions=["clipboard-read", "clipboard-write"])
            errors, reference_requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: reference_requests.append(request.url) if any(x in request.url for x in ("clipboard-reference", "add-reference")) else None)
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while True:
                    if predicate():
                        return
                    assert time.monotonic() < deadline, "Timed out waiting for review state"
                    page.wait_for_timeout(50)

            def command(name, value=None):
                result = page.request.post(url + "api/command", data={"name": name, "input": value or {}})
                assert result.status == 200, result.text()

            wait(lambda: not state()["loading"] and state()["documentRevision"], 120)
            if state()["activeReviewId"]:
                command("close_review")
            command("reset_view")
            command("show_all")
            wait(lambda: state().get("rendered") and state()["rendered"]["revision"] == state()["revision"])
            report = state()["rendered"]
            assert report["visibleParts"] == 6
            assert report["geometryDefinitions"] == 3
            assert len({part["geometry"] for part in report["geometryIds"]}) == 3, "Repeated occurrences must share GPU geometry"
            command("set_explode", {"amount": 0.4})
            wait(lambda: state()["rendered"]["revision"] == state()["revision"])
            assert state()["rendered"]["geometryIds"] == report["geometryIds"], "Explosion recreated geometry"
            before = state()
            live_canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            live_canvas.evaluate("(canvas) => { window.originalCadCanvas = canvas; window.cadContextLosses = 0; canvas.addEventListener('webglcontextlost', () => window.cadContextLosses++); }")
            original_viewport = page.locator(".viewport").bounding_box()
            page.get_by_role("button", name="Draw", exact=True).click()
            wait(lambda: state()["activeReviewId"] is not None)
            review_id = state()["activeReviewId"]
            drawing = page.get_by_label("Drawing canvas")
            expect(drawing).to_be_visible()
            expect(live_canvas).to_have_count(1)
            assert live_canvas.evaluate("(canvas) => canvas === window.originalCadCanvas"), "Draw replaced the renderer"
            expect(page.locator(".live-scene")).to_have_attribute("aria-hidden", "true")
            expect(page.get_by_role("slider", name="Explode amount")).to_be_disabled()
            assert page.locator(".viewport").bounding_box() == original_viewport, "Draw moved or resized the viewport"
            source_review = page.request.get(url + f"api/reviews/{review_id}").json()
            assert source_review["pose"]["explode"] == 0.4
            assert source_review["source"]["topologyRevision"] == before["topologyRevision"]
            snapshot = Image.open(io.BytesIO(base64.b64decode(source_review["image"]["dataUrl"].split(",", 1)[1]))).convert("RGB")
            stale = page.request.post(url + "api/command", data={"name": "set_explode", "input": {"amount": 1}})
            assert stale.status == 409, "An agent must not move the model while a captured review is open"

            def review():
                return page.request.get(url + f"api/reviews/{review_id}").json()

            def stroke_count():
                return len(review()["drawing"]["present"])

            def stroke(tool, start, end):
                page.get_by_role("button", name=tool, exact=True).click()
                bounds = drawing.bounding_box()
                page.mouse.move(bounds["x"] + start[0] * bounds["width"], bounds["y"] + start[1] * bounds["height"])
                page.mouse.down()
                page.mouse.move(bounds["x"] + end[0] * bounds["width"], bounds["y"] + end[1] * bounds["height"], steps=12)
                page.mouse.up()

            for index, tool in enumerate(["Pen", "Line", "Arrow", "Double arrow", "Rectangle", "Ellipse", "Highlight"]):
                y = 0.12 + index * 0.095
                stroke(tool, (0.18, y), (0.48, y + 0.065))
                wait(lambda: stroke_count() == index + 1)
            assert not reference_requests, "Drawing must not copy CAD references or modify chat"
            page.get_by_role("button", name="Undo drawing").click()
            wait(lambda: stroke_count() == 6)
            page.get_by_role("button", name="Redo drawing").click()
            wait(lambda: stroke_count() == 7)
            page.get_by_role("button", name="Clear drawing").click()
            wait(lambda: stroke_count() == 0)
            page.get_by_role("button", name="Undo drawing").click()
            wait(lambda: stroke_count() == 7)
            page.get_by_role("button", name="Erase", exact=True).click()
            box = drawing.bounding_box()
            page.mouse.click(box["x"] + 0.33 * box["width"], box["y"] + 0.1525 * box["height"])
            wait(lambda: stroke_count() == 6)
            page.get_by_role("button", name="Undo drawing").click()
            wait(lambda: stroke_count() == 7)

            def fail_save(route):
                if route.request.method == "POST":
                    route.fulfill(status=507, json={"error": "Simulated review storage failure"})
                else:
                    route.continue_()

            page.route(url + f"api/reviews/{review_id}", fail_save)
            stroke("Line", (0.65, 0.2), (0.8, 0.35))
            expect(page.get_by_role("button", name="Retry save")).to_be_visible()
            page.get_by_role("button", name="Back to model").click()
            assert state()["activeReviewId"] == review_id, "Unsaved review must not disappear on close"
            page.get_by_role("button", name="Keep editing").click()
            page.unroute(url + f"api/reviews/{review_id}", fail_save)
            page.get_by_role("button", name="Retry save").click()
            wait(lambda: stroke_count() == 8)
            page.get_by_role("button", name="Undo drawing").click()
            wait(lambda: stroke_count() == 7)

            page.get_by_role("button", name="Copy marked image").click()
            expect(page.get_by_role("status").filter(has_text="Marked image copied")).to_be_visible(timeout=15000)
            image_data = page.evaluate("""async () => {
                for (const item of await navigator.clipboard.read()) {
                    if (!item.types.includes('image/png')) continue;
                    const blob = await item.getType('image/png');
                    return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
                }
                return null;
            }""")
            assert image_data, "Copy marked image must write PNG to the clipboard"
            marked = Image.open(io.BytesIO(base64.b64decode(image_data.split(",", 1)[1]))).convert("RGB")
            assert marked.size == snapshot.size
            assert ImageChops.difference(snapshot, marked).getbbox(), "Copied image omitted all markup"
            marked.save(output / "marked.png")
            copied_pixels = marked.copy()
            page.get_by_role("button", name="Save marked image").click()
            notice = page.get_by_role("status").filter(has_text="Marked image saved:")
            expect(notice).to_be_visible()
            image_path = notice.inner_text().split("Marked image saved:", 1)[1].strip().rstrip("x").strip()
            # Use the server's saved files, not a text-only success indicator.
            stored = list((Path(state()["runtimeRoot"]) / "reviews").glob(f"*/{review_id}-v*.png"))
            assert stored
            saved = Image.open(max(stored, key=lambda file: file.stat().st_mtime)).convert("RGB")
            assert saved.size == marked.size
            assert not ImageChops.difference(saved, marked).getbbox(), "Saved image differs from copied review"

            original_strokes = review()["drawing"]
            exported = page.request.post(url + "api/capture", data={})
            assert exported.status == 200, exported.text()
            exported_path = Path(exported.json()["path"])
            assert exported_path.is_file()
            assert not ImageChops.difference(Image.open(exported_path).convert("RGB"), marked).getbbox(), "Agent capture omitted the drawing layer"
            page.set_viewport_size({"width": 420, "height": 900})
            expect(drawing).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(output / "narrow-drawing.png"))
            assert review()["drawing"] == original_strokes
            assert page.evaluate("window.cadContextLosses") == 0
            page.reload()
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            live_canvas.evaluate("(canvas) => { window.originalCadCanvas = canvas; window.cadContextLosses = 0; canvas.addEventListener('webglcontextlost', () => window.cadContextLosses++); }")
            assert state()["activeReviewId"] == review_id
            assert stroke_count() == 7
            page.get_by_role("button", name="Copy marked image").click()
            expect(page.get_by_role("status").filter(has_text="Marked image copied")).to_be_visible(timeout=15000)
            restored_image = page.evaluate("""async () => {
                const items = await navigator.clipboard.read();
                const blob = await items.find(item => item.types.includes('image/png')).getType('image/png');
                return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
            }""")
            restored = Image.open(io.BytesIO(base64.b64decode(restored_image.split(",", 1)[1]))).convert("RGB")
            assert not ImageChops.difference(copied_pixels, restored).getbbox(), "Reload/resize shifted drawing coordinates"
            page.get_by_role("button", name="Back to model").click()
            wait(lambda: state()["activeReviewId"] is None)
            expect(page.locator("canvas[aria-label='Interactive STEP assembly']")).to_be_visible()
            assert state()["explode"] == 0.4
            assert live_canvas.evaluate("(canvas) => canvas === window.originalCadCanvas")
            assert page.evaluate("window.cadContextLosses") == 0
            page.get_by_label("Saved reviews").select_option(review_id)
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            assert stroke_count() == 7
            assert not errors, errors
            result = {
                "reviewId": review_id, "tools": 7, "savedMarks": 7, "undoRedo": True,
                "reversibleClear": True, "clipboardContainsMarkup": True, "savedImageMatchesClipboard": True,
                "reloadResizeAlignment": True, "sharedGpuGeometry": True, "drawingDoesNotCopyReferences": True,
                "eraserUndo": True, "failedSaveRecovery": True, "agentCaptureIncludesMarkup": True,
                "originalPosePreserved": True, "pageErrors": errors,
            }
            (output / "report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result))
            page.get_by_role("button", name="Back to model").click()
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.url, args.output)
