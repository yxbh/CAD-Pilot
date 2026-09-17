import argparse
import json
import time
from pathlib import Path

from OCP.BRep import BRep_Builder
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeSphere
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.gp import gp_Pnt
from playwright.sync_api import expect, sync_playwright


def rounded_fixture(path):
    box = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
    fillet = BRepFilletAPI_MakeFillet(box)
    edges = TopExp_Explorer(box, TopAbs_EDGE)
    while edges.More():
        fillet.Add(2, TopoDS.Edge_s(edges.Current()))
        edges.Next()
    fillet.Build()
    assert fillet.IsDone()
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    builder.Add(compound, fillet.Shape())
    builder.Add(compound, BRepPrimAPI_MakeSphere(gp_Pnt(35, 10, 12), 12).Shape())
    writer = STEPControl_Writer()
    assert writer.Transfer(compound, STEPControl_AsIs) == IFSelect_RetDone
    assert writer.Write(str(path)) == IFSelect_RetDone


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
            cleanup = {"degenerateEdges": 120, "zeroAreaTriangles": 60}

            def inject_warnings(route):
                response = route.fetch()
                model = response.json()
                model["warnings"] = warnings
                model["cleanup"] = cleanup
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
                expect(page.get_by_role("region", name="Display geometry cleanup")).to_be_in_viewport()
                details.locator("li").last.scroll_into_view_if_needed()
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
            cleanup = {"degenerateEdges": 0, "zeroAreaTriangles": 0}
            uploaded = page.request.post(url + "api/upload", data=source.read_bytes(), headers={"x-file-name": "No warnings.step"})
            assert uploaded.ok, uploaded.text()
            expect(page.get_by_role("button", name="Import warnings", exact=False)).to_have_count(0)
            expect(page.get_by_role("dialog", name="Import warnings", exact=False)).to_have_count(0)
            expect(page.get_by_role("button", name="Import information", exact=True)).to_have_count(0)
            settled()
            expect(page.get_by_role("alert")).to_have_count(0)

            # An actual rounded STEP import, with no intercepted diagnostic response.
            page.unroute("**/api/model", inject_warnings)
            rounded = output / "Rounded fixture.step"
            rounded_fixture(rounded)
            with page.expect_file_chooser() as chooser:
                page.get_by_role("button", name="Open STEP", exact=True).click()
            chooser.value.set_files(rounded)
            wait(lambda current: current["modelName"] == rounded.name and not current["loading"])
            settled()
            actual = page.request.get(url + "api/model").json()
            assert actual["warnings"] == []
            assert actual["cleanup"]["degenerateEdges"] == 10
            assert actual["cleanup"]["zeroAreaTriangles"] >= 8
            assert sum(len(part["faces"]) for part in actual["parts"]) == 27
            assert sum(len(part["edges"]) for part in actual["parts"]) == 49
            info = page.get_by_role("button", name="Import information", exact=True)
            info_dialog = page.get_by_role("dialog", name="Import information", exact=True)
            expect(info).to_be_visible()
            expect(info).to_have_class("icon-button information-button")
            expect(info.locator(".warning-count")).to_have_count(0)
            expect(page.get_by_role("button", name="Import warnings", exact=False)).to_have_count(0)
            info_measurements = []
            for width, height in [(1248, 920), (390, 844), (320, 480), (1248, 360)]:
                page.set_viewport_size({"width": width, "height": height})
                command("fit_view")
                before = settled()
                viewport = page.locator(".viewport").bounding_box()
                info.click()
                expect(info_dialog).to_be_visible()
                expect(page.get_by_role("button", name="Dismiss notice", exact=True)).to_have_count(0)
                expect(info_dialog).to_have_class("import-warnings-panel information-panel")
                expect(info_dialog).to_contain_text("Low-priority information")
                expect(info_dialog).to_contain_text("no CAD faces were removed")
                expect(info_dialog.locator("dd")).to_have_text([
                    str(actual["cleanup"]["degenerateEdges"]), str(actual["cleanup"]["zeroAreaTriangles"]),
                ])
                expect(info_dialog.locator("li")).to_have_count(0)
                assert settled()["rendered"]["camera"] == before["rendered"]["camera"]
                assert settled()["rendered"]["geometryIds"] == before["rendered"]["geometryIds"]
                assert page.locator(".viewport").bounding_box() == viewport
                box = info_dialog.bounding_box()
                controls = page.locator(".bottom-bar").bounding_box()
                assert box["y"] + box["height"] <= controls["y"]
                assert 0 <= box["x"] and box["x"] + box["width"] <= width
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                assert info_dialog.locator("dd").evaluate_all("""elements => elements.every(element => {
                    const r = element.getBoundingClientRect();
                    return element.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));
                })"""), "Cleanup counts must not be covered by another notice"
                slider_accessible()
                slider.press("End")
                wait(lambda current: current["explode"] == 1)
                settled()
                slider.press("Home")
                wait(lambda current: current["explode"] == 0)
                settled()
                page.screenshot(path=str(output / f"information-{width}x{height}.png"))
                page.get_by_role("button", name="Close import information", exact=True).click()
                expect(info).to_be_focused()
                info.press("Enter")
                expect(info_dialog).to_be_visible()
                page.keyboard.press("Escape")
                expect(info_dialog).to_have_count(0)
                info_measurements.append({"viewport": [width, height], "panel": box, "controlsTop": controls["y"]})

            page.set_viewport_size({"width": 1248, "height": 920})
            command("fit_view")
            node = next(node for node in actual["nodes"] if node["partId"])
            part = next(part for part in actual["parts"] if part["id"] == node["partId"])
            command("select_edge", {"id": node["id"], "edgeId": part["edges"][0]["id"], "topologyRevision": actual["topologyRevision"]})
            selected = settled()
            reference = selected["selectedReferences"][0]["reference"]
            info.click()
            page.get_by_role("button", name="Draw", exact=True).click()
            reviewing = wait(lambda current: current["activeReviewId"] is not None)
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            expect(info).to_have_count(0)
            expect(info_dialog).to_have_count(0)
            review_id = reviewing["activeReviewId"]
            review_before = page.request.get(url + f"api/reviews/{review_id}").json()
            page.get_by_role("button", name="Back to model", exact=True).click()
            wait(lambda current: current["activeReviewId"] is None)
            settled()
            expect(info).to_be_visible()
            page.reload()
            settled()
            expect(info).to_be_visible()
            expect(info_dialog).to_have_count(0)
            assert state()["selectedReferences"][0]["reference"] == reference
            page.get_by_label("Saved reviews").select_option(review_id)
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            expect(info).to_have_count(0)
            assert page.request.get(url + f"api/reviews/{review_id}").json() == review_before
            page.get_by_role("button", name="Back to model", exact=True).click()
            wait(lambda current: current["activeReviewId"] is None)
            settled()

            # Legacy-normalized diagnostics use unknown counts, never guessed totals.
            warnings = ["STEP transfer: actual warning"]
            cleanup = {"degenerateEdges": None, "zeroAreaTriangles": None}
            page.route("**/api/model", inject_warnings)
            page.reload()
            mixed = page.get_by_role("button", name="Import warnings (1)", exact=True)
            mixed.click()
            details = page.get_by_role("region", name="Import warning details")
            expect(details.locator("li")).to_have_text(warnings)
            expect(details.locator("dd")).to_have_text(["Count unavailable", "Count unavailable"])
            expect(details).to_contain_text("older import did not record exact cleanup counts")
            page.screenshot(path=str(output / "legacy-mixed-information.png"))
            page.unroute("**/api/model", inject_warnings)
            page.reload()
            settled()
            failed = page.request.post(url + "api/upload", data=b"invalid STEP", headers={"x-file-name": "Broken.step"})
            assert not failed.ok
            expect(page.get_by_role("alert")).to_contain_text("STEP")
            assert page.request.get(url + "api/model").json() == actual
            info.click()
            expect(page.get_by_role("alert")).to_contain_text("STEP")
            assert not errors, errors
            report = {
                "injectedWarningCount": 42, "sliderPointerAndKeyboardAccessible": True,
                "closeEscapeAndToggleReopen": True, "warningDetailsScroll": True, "cameraAndViewportUnchanged": True,
                "reviewAndModelChangesHideOldWarnings": True, "measurements": measurements, "pageErrors": errors,
                "nativeCleanup": actual["cleanup"], "nativeFaces": 27, "nativeSelectableEdges": 49,
                "informationMeasurements": info_measurements, "legacyUnknownCountsAndRealWarning": True,
                "savedReviewAndEdgeReferencePreserved": True, "invalidImportStillErrors": True,
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
