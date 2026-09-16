import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            warnings = [
                "Transparency is unsupported; transparent parts are shown opaque.",
                "Per-face/subshape colors are unsupported; affected parts use a single RGB color.",
            ] + [f"Warning {i}: " + "long-diagnostic-" * 30 for i in range(3, 43)]

            def inject_warnings(route):
                response = route.fetch()
                model = response.json()
                model["warnings"] = warnings
                route.fulfill(response=response, json=model)

            # Exercise presentation without changing a cached model or manufacturing a converter failure.
            page.route("**/api/model", inject_warnings)
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while True:
                    current = state()
                    if predicate(current):
                        return current
                    assert time.monotonic() < deadline, f"State did not settle: {current}; errors={errors}"
                    page.wait_for_timeout(50)

            def settled():
                return wait(lambda current: current.get("rendered") and current["rendered"]["revision"] == current["revision"])

            def command(name, data=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": data or {}})
                assert response.ok, response.text()
                return settled()

            def slider_accessible():
                assert slider.evaluate("""slider => {
                    const r = slider.getBoundingClientRect();
                    return [0.2, 0.5, 0.8].every(f =>
                      document.elementFromPoint(r.x + r.width*f, r.y + r.height/2) === slider);
                }"""), "Import warnings cover the explosion slider"

            wait(lambda current: not current["loading"] and current["documentRevision"], 120)
            settled()
            canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            expect(canvas).to_be_visible()
            canvas.evaluate("canvas => window.warningCanvas = canvas")
            slider = page.get_by_role("slider", name="Explode amount")
            slider_accessible()
            trigger = page.get_by_role("button", name="Import warnings (42)", exact=True)
            dialog = page.get_by_role("dialog", name="Import warnings (42)", exact=True)
            expect(trigger).to_be_visible()
            expect(trigger).to_have_attribute("aria-expanded", "false")
            expect(dialog).to_have_count(0)
            trigger.hover()
            expect(page.get_by_role("tooltip").filter(has_text="Import warnings (42)")).to_be_visible()
            measurements = []
            for width, height in [(1248, 920), (760, 844), (390, 844), (320, 480), (1248, 360)]:
                page.set_viewport_size({"width": width, "height": height})
                command("fit_view")
                before = page.locator(".viewport").bounding_box()
                snapshot = settled()
                trigger.focus()
                trigger.press("Enter")
                expect(dialog).to_be_visible()
                expect(dialog).to_be_focused()
                expect(trigger).to_have_attribute("aria-expanded", "true")
                assert page.locator(".viewport").bounding_box() == before
                assert settled()["rendered"]["camera"] == snapshot["rendered"]["camera"]
                assert settled()["rendered"]["geometryIds"] == snapshot["rendered"]["geometryIds"]
                assert canvas.evaluate("canvas => canvas === window.warningCanvas")
                box = dialog.bounding_box()
                workspace = page.locator(".workspace").bounding_box()
                controls = page.locator(".bottom-bar").bounding_box()
                assert box["y"] >= workspace["y"]
                assert box["y"] + box["height"] <= controls["y"]
                assert 0 <= box["x"] and box["x"] + box["width"] <= width
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                details = page.get_by_role("region", name="Import warning details")
                expect(details.locator("li")).to_have_count(len(warnings))
                assert details.evaluate("element => element.scrollHeight > element.clientHeight")
                details.focus()
                details.press("End")
                expect(details.locator("li").last).to_be_in_viewport()
                slider_accessible()
                slider.press("End")
                wait(lambda current: current["explode"] == 1)
                settled()
                expect(dialog).to_be_visible()
                slider.press("Home")
                wait(lambda current: current["explode"] == 0)
                settled()
                slider.click(position={"x": slider.bounding_box()["width"] * 0.55, "y": 2})
                wait(lambda current: 0.3 < current["explode"] < 0.8)
                settled()
                expect(dialog).to_be_visible()
                assert page.locator(".viewport").bounding_box() == before
                page.screenshot(path=str(output / f"warnings-{width}x{height}.png"))
                page.get_by_role("button", name="Close import warnings", exact=True).click()
                expect(dialog).to_have_count(0)
                expect(trigger).to_be_focused()
                trigger.press("Enter")
                expect(dialog).to_be_visible()
                page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                expect(trigger).to_be_focused()
                trigger.click()
                expect(dialog).to_be_visible()
                trigger.click()
                expect(dialog).to_have_count(0)
                slider_accessible()
                measurements.append({"viewport": [width, height], "panel": box, "controlsTop": controls["y"]})

            page.set_viewport_size({"width": 1248, "height": 920})
            command("fit_view")
            trigger.click()
            page.get_by_role("button", name="Draw", exact=True).click()
            wait(lambda current: current["activeReviewId"] is not None)
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            expect(trigger).to_have_count(0)
            expect(dialog).to_have_count(0)
            page.get_by_role("button", name="Back to model", exact=True).click()
            wait(lambda current: current["activeReviewId"] is None)
            settled()
            expect(trigger).to_be_visible()
            expect(dialog).to_have_count(0)
            trigger.click()
            response = page.request.get(url + "api/model").json()
            source = Path(state()["runtimeRoot"]) / "inputs" / f"{response['source']['sha256']}.step"
            assert source.is_file()
            warnings = ["A warning for a different STEP snapshot."]
            uploaded = page.request.post(url + "api/upload", data=source.read_bytes(), headers={"x-file-name": "Another assembly.step"})
            assert uploaded.ok, uploaded.text()
            renamed = page.get_by_role("button", name="Import warnings (1)", exact=True)
            expect(renamed).to_be_visible()
            expect(page.get_by_role("dialog", name="Import warnings", exact=False)).to_have_count(0)
            renamed.click()
            expect(page.get_by_role("region", name="Import warning details")).to_contain_text("Another assembly.step")
            expect(page.get_by_role("region", name="Import warning details")).not_to_contain_text("Transparency")
            warnings = []
            uploaded = page.request.post(url + "api/upload", data=source.read_bytes(), headers={"x-file-name": "No warnings.step"})
            assert uploaded.ok, uploaded.text()
            expect(page.get_by_role("button", name="Import warnings", exact=False)).to_have_count(0)
            expect(page.get_by_role("dialog", name="Import warnings", exact=False)).to_have_count(0)
            settled()
            expect(page.get_by_role("alert")).to_have_count(0)
            assert not errors, errors
            report = {
                "injectedWarningCount": 42, "sliderPointerAndKeyboardAccessible": True,
                "closeEscapeAndToggleReopen": True, "warningDetailsScroll": True, "cameraAndViewportUnchanged": True,
                "reviewAndModelChangesHideOldWarnings": True, "measurements": measurements, "pageErrors": errors,
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
