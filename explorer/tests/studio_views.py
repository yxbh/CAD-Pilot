import argparse
import base64
import io
import json
import math
import time
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import expect, sync_playwright


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920}, permissions=["clipboard-read", "clipboard-write"])
            errors, external, graphics_errors = [], [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: graphics_errors.append(message.text) if message.type == "error" else None)
            page.on("request", lambda request: external.append(request.url) if urlparse(request.url).hostname not in ("127.0.0.1", None) else None)
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while True:
                    current = state()
                    if predicate(current):
                        return current
                    assert time.monotonic() < deadline, f"View did not settle: {current}; errors={errors}; graphics={graphics_errors}"
                    page.wait_for_timeout(50)

            def settled():
                return wait(lambda current: current.get("rendered") and current["rendered"]["revision"] == current["revision"])

            def command(name, data=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": data or {}})
                assert response.ok, response.text()
                return settled()

            def click(label):
                before = state()["revision"]
                page.get_by_role("button", name=label, exact=True).click()
                wait(lambda current: current["revision"] > before)
                return settled()

            def pixels():
                data = canvas.evaluate("canvas => canvas.toDataURL('image/png')")
                return Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))).convert("RGB")

            def same_pose(a, b):
                for field in ["position", "target", "up"]:
                    assert max(abs(x - y) for x, y in zip(a[field], b[field])) < 1e-6, (field, a, b)
                assert abs(a["viewHeight"] - b["viewHeight"]) < 1e-6, (a, b)

            wait(lambda current: not current["loading"] and current["documentRevision"], 120)
            initial = settled()
            canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            canvas.evaluate("""canvas => {
              window.originalCanvas = canvas; window.contextLosses = 0;
              canvas.addEventListener('webglcontextlost', () => window.contextLosses++);
            }""")
            frame = page.locator(".viewport").bounding_box()
            geometry_ids = initial["rendered"]["geometryIds"]
            reference_source = initial["topologyRevision"]
            expect(page.get_by_role("separator", name="Drawing and view tools")).to_be_visible()
            expect(page.get_by_role("group", name="View orientation: X red, Y green, Z blue")).to_be_visible()
            view_labels = {
                "Right view (+X)": [1, 0, 0], "Left view (-X)": [-1, 0, 0],
                "Back view (+Y)": [0, 1, 0], "Front view (-Y)": [0, -1, 0],
                "Top view (+Z)": [0, 0, 1], "Bottom view (-Z)": [0, 0, -1],
            }
            for label, direction in view_labels.items():
                current = click(label)
                camera = current["rendered"]["camera"]
                delta = [p - t for p, t in zip(camera["position"], camera["target"])]
                length = math.sqrt(sum(value * value for value in delta))
                assert max(abs(value / length - expected) for value, expected in zip(delta, direction)) < 1e-6, (label, camera)
                assert current["rendered"]["inFrame"], label
                page.get_by_role("button", name=label, exact=True).hover()
                expect(page.get_by_role("tooltip").filter(has_text=label)).to_be_visible()
            click("Isometric view")
            before = settled()["rendered"]["camera"]
            ortho = click("Orthographic projection (parallel)")
            same_pose(before, ortho["rendered"]["camera"])
            assert ortho["rendered"]["camera"]["projection"] == "orthographic"
            expect(page.get_by_role("button", name="Orthographic projection (parallel)")).to_have_attribute("aria-pressed", "true")
            page.mouse.move(frame["x"] + frame["width"] / 2, frame["y"] + frame["height"] / 2)
            old_height = ortho["rendered"]["camera"]["viewHeight"]
            page.mouse.wheel(0, -160)
            wait(lambda current: current.get("camera") and current["camera"].get("viewHeight", old_height) < old_height)
            zoomed = settled()["rendered"]["camera"]
            perspective = click("Perspective projection")["rendered"]["camera"]
            assert abs(perspective["viewHeight"] - zoomed["viewHeight"]) < 1e-6
            returned = click("Orthographic projection (parallel)")["rendered"]["camera"]
            assert abs(returned["viewHeight"] - zoomed["viewHeight"]) < 1e-6
            assert returned["target"] == zoomed["target"]
            directions = []
            for camera in [zoomed, returned]:
                delta = [p - t for p, t in zip(camera["position"], camera["target"])]
                length = math.sqrt(sum(value * value for value in delta))
                directions.append([value / length for value in delta])
            assert max(abs(a - b) for a, b in zip(*directions)) < 1e-6
            command("fit_view")
            before = settled()["rendered"]["camera"]
            inspect = pixels()
            inspect.save(output / "inspect.png")
            studio = click("Studio appearance")
            same_pose(before, studio["rendered"]["camera"])
            assert studio["showEdges"] is False
            studio_image = pixels()
            difference = ImageStat.Stat(ImageChops.difference(inspect, studio_image)).mean
            assert max(difference) > 8, difference
            studio_image.save(output / "studio.png")
            page.mouse.move(3, 3)
            page.screenshot(path=str(output / "studio-toolbar.png"))
            click("Inspect appearance")
            difference = ImageStat.Stat(ImageChops.difference(inspect, pixels())).mean
            assert max(difference) < 0.1, difference
            click("Studio appearance")
            page.get_by_role("button", name="Appearance settings", exact=True).click()
            expect(page.get_by_role("dialog", name="Appearance settings")).to_be_visible()
            finishes = {}
            for finish in ["plastic", "satin", "polished", "rubber"]:
                before_revision = state()["revision"]
                page.get_by_role("combobox", name="Studio finish").select_option(finish)
                wait(lambda current: current["revision"] > before_revision)
                current = settled()
                assert current["materialFinish"] == finish
                finishes[finish] = pixels()
                finishes[finish].save(output / f"studio-{finish}.png")
            for a, b in zip(finishes, list(finishes)[1:]):
                diff = ImageStat.Stat(ImageChops.difference(finishes[a], finishes[b])).mean
                assert max(diff) > 0.4, (a, b, diff)
            page.get_by_role("checkbox", name="Outlines", exact=True).click()
            wait(lambda current: current["showEdges"])
            expect(page.get_by_role("checkbox", name="Outlines", exact=True)).to_be_checked()
            settled()
            page.get_by_role("button", name="Close appearance settings").click()
            command("set_appearance", {"finish": "satin", "showEdges": False})
            before_explosion = settled()["rendered"]["camera"]
            command("set_explode", {"amount": 0.65, "direction": "z"})
            same_pose(before_explosion, settled()["rendered"]["camera"])
            command("fit_view")
            assert settled()["rendered"]["inFrame"]
            command("reset_view")
            click("Top view (+Z)")
            cover = next(part["id"] for part in state()["parts"] if "cover" in part["label"].lower())
            selected = command("select_face", {"id": cover, "faceId": "f6", "topologyRevision": reference_source})
            reference = selected["selectedReferences"]
            point = selected["rendered"]["selectedFaceScreen"]
            canvas.click(position={"x": point[0], "y": point[1]})
            expect(page.locator(".reference-bar")).to_have_attribute("data-copy-status", "copied")
            assert "copilot-ref" in page.evaluate("navigator.clipboard.readText()")
            settled()
            click("Isometric view")
            click("Inspect appearance")
            assert settled()["selectedReferences"] == reference
            click("Studio appearance")
            assert settled()["selectedReferences"] == reference
            assert state()["rendered"]["geometryIds"] == geometry_ids
            assert canvas.evaluate("canvas => canvas === window.originalCanvas")
            assert page.locator(".viewport").bounding_box() == frame
            assert page.evaluate("window.contextLosses") == 0
            actual = pixels()
            captured_pose = settled()["rendered"]["camera"]
            page.get_by_role("button", name="Draw", exact=True).click()
            review_id = wait(lambda current: current["activeReviewId"])["activeReviewId"]
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            review = page.request.get(url + f"api/reviews/{review_id}").json()
            same_pose(captured_pose, review["pose"]["camera"])
            assert review["pose"]["camera"]["projection"] == "orthographic"
            assert review["pose"]["appearance"] == "studio"
            assert review["pose"]["materialFinish"] == "satin"
            captured = Image.open(io.BytesIO(base64.b64decode(review["image"]["dataUrl"].split(",", 1)[1]))).convert("RGB")
            assert max(ImageStat.Stat(ImageChops.difference(actual, captured)).mean) < 0.1
            page.get_by_role("button", name="Back to model").click()
            wait(lambda current: current["activeReviewId"] is None)
            restored = settled()
            same_pose(captured_pose, restored["rendered"]["camera"])
            assert canvas.evaluate("canvas => canvas === window.originalCanvas")
            page.reload()
            settled()
            same_pose(captured_pose, state()["rendered"]["camera"])
            assert state()["projection"] == "orthographic"
            assert state()["appearance"] == "studio"
            page.get_by_label("Saved reviews").select_option(review_id)
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            page.get_by_role("button", name="Back to model").click()
            wait(lambda current: current["activeReviewId"] is None)
            settled()
            for width in [760, 590, 390, 320]:
                page.set_viewport_size({"width": width, "height": 844})
                page.wait_for_timeout(150)
                toolbar = page.locator(".mode-toolbar").bounding_box()
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                for button in page.locator(".model-toolbar button").all():
                    rect = button.bounding_box()
                    assert rect["x"] >= 0 and rect["x"] + rect["width"] <= width + 1, (width, rect)
                    assert rect["y"] + rect["height"] <= toolbar["y"] + toolbar["height"] + 1, (width, rect, toolbar)
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(output / "studio-narrow.png"))
            expect(page.get_by_role("alert")).to_have_count(0)
            assert not errors, errors
            assert not graphics_errors, graphics_errors
            assert not external, external
            report = {
                "signedAxes": 6, "orthographicZoomAndRoundTrip": True, "cameraCanvasGeometryPreserved": True,
                "studioFinishes": list(finishes), "offline": True, "referenceClipboard": True,
                "reviewId": review_id, "projectionAppearanceAndPixelsCaptured": True,
                "reloadedPose": captured_pose, "desktopViewport": frame, "narrowWidths": [760, 590, 390, 320],
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
