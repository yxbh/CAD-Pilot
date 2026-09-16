import argparse
import io
import json
import math
import time
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright

from browser_smoke import ReferenceMarkup


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 900}, device_scale_factor=2,
                                    permissions=["clipboard-read", "clipboard-write"])
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while True:
                    current = state()
                    if predicate(current):
                        return current
                    assert time.monotonic() < deadline, f"View did not settle: {current}; errors={errors}; alerts={page.get_by_role('alert').all_text_contents()}"
                    page.wait_for_timeout(50)

            def settled():
                return wait(lambda current: current.get("rendered") and current["rendered"]["revision"] == current["revision"])

            def command(name, data=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": data or {}})
                assert response.ok, response.text()
                return settled()

            def toolbar(name):
                previous = state()["revision"]
                page.get_by_role("button", name=name, exact=True).click()
                wait(lambda current: current["revision"] > previous)
                return settled()

            wait(lambda current: not current["loading"] and current["documentRevision"], 120)
            settled()
            model = page.request.get(url + "api/model").json()
            canvas = page.locator('canvas[aria-label="Interactive STEP assembly"]')
            parts = {part["id"]: part for part in model["parts"]}
            leaves = [node for node in model["nodes"] if node["partId"]]
            cover = next(node for node in leaves if node["label"] == "Cover plate")
            spacer = next(node for node in leaves if node["label"] == "Spacer 1")
            second_spacer = next(node for node in leaves if node["label"] == "Spacer 2")

            def top_edge(node, kind):
                part = parts[node["partId"]]
                return next(edge for edge in part["edges"] if edge["curveType"].lower() == kind
                            and abs(edge["bounds"]["min"][2] - part["bounds"]["max"][2]) < 1e-4
                            and abs(edge["bounds"]["max"][2] - part["bounds"]["max"][2]) < 1e-4)

            def target(node, edge):
                current = command("select_edge", {"id": node["id"], "edgeId": edge["id"],
                                                   "topologyRevision": model["topologyRevision"]})
                point = current["rendered"]["selectedEdgeScreen"]
                assert point is not None
                command("select_parts", {"ids": []})
                return {"x": point[0], "y": point[1]}

            def click_edge(node, edge, point=None):
                point = point or target(node, edge)
                previous = state()["revision"]
                canvas.click(position=point)
                wait(lambda current: current["revision"] > previous)
                current = settled()
                assert current["selectedEdge"] == {"nodeId": node["id"], "edgeId": edge["id"]}, current
                assert current["selectedFace"] is None
                assert current["rendered"]["highlightedSegments"] == len(edge["positions"]) // 3 - 1
                return current

            def copied(node, edge):
                expect(page.locator(".reference-bar")).to_have_attribute("data-copy-status", "copied")
                text = page.evaluate("navigator.clipboard.readText()")
                refs = ReferenceMarkup(text).refs
                assert len(refs) == 1, text
                descriptor = json.loads(Path(refs[0]["target-id"]).read_text(encoding="utf-8"))
                assert descriptor["edge"]["id"] == edge["id"]
                assert descriptor["occurrence"]["id"] == node["id"]
                assert descriptor["reference"].endswith("/" + edge["id"])
                assert "Edge " + edge["id"] in refs[0]["label"]
                assert math.isclose(descriptor["edge"]["length"], edge["length"], rel_tol=1e-9)
                return descriptor["reference"], text

            toolbar("Top view (+Z)")
            toolbar("Orthographic projection (parallel)")
            toolbar("Edges")
            expect(page.get_by_role("button", name="Edges", exact=True)).to_have_attribute("aria-pressed", "true")
            edge = top_edge(cover, "line")
            point = target(cover, edge)
            # Offset normal to the top-view line to exercise a forgiving CSS-pixel hit area.
            axis = "y" if edge["bounds"]["max"][0] - edge["bounds"]["min"][0] > 1 else "x"
            point[axis] += 3
            page.mouse.move(3, 3)
            page.wait_for_timeout(100)
            baseline = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            sentinel = "Hover must not copy or select"
            page.evaluate("(text) => navigator.clipboard.writeText(text)", sentinel)
            before = state()
            canvas.hover(position=point)
            page.wait_for_timeout(100)
            hovered = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
            diff = ImageChops.difference(baseline, hovered).getbbox()
            assert diff and max(diff[2] - diff[0], diff[3] - diff[1]) > 100, "Hover must preview the full CAD edge"
            assert state()["revision"] == before["revision"]
            assert state()["selectedEdge"] is None
            assert page.evaluate("navigator.clipboard.readText()") == sentinel
            click_edge(cover, edge, point)
            copied(cover, edge)
            expect(page.locator(".selection-info")).to_contain_text(f"Edge {edge['id']}")
            page.mouse.move(3, 3)
            page.screenshot(path=str(output / "straight-edge.png"))

            # Existing modes still use surface/object picking, not the nearby edge.
            toolbar("Faces")
            box = canvas.bounding_box()
            canvas.click(position={"x": box["width"] / 2, "y": box["height"] / 2})
            wait(lambda current: current["selectedFace"] is not None)
            assert settled()["selectedEdge"] is None
            toolbar("Parts")
            canvas.click(position={"x": box["width"] / 2, "y": box["height"] / 2})
            wait(lambda current: bool(current["selectedIds"]) and current["selectedFace"] is None)
            assert settled()["selectedEdge"] is None
            toolbar("Edges")

            circle = top_edge(spacer, "circle")
            blocked = target(spacer, circle)
            previous = state()["revision"]
            canvas.click(position=blocked)
            wait(lambda current: current["revision"] > previous)
            assert settled()["selectedEdge"] is None, "Must not pick spacer edges through the cover"

            command("isolate", {"id": spacer["id"]})
            click_edge(spacer, circle)
            first_reference, _ = copied(spacer, circle)
            assert math.isclose(circle["length"], 8 * math.pi, rel_tol=1e-6)
            page.mouse.move(3, 3)
            page.screenshot(path=str(output / "curved-edge.png"))
            command("isolate", {"id": second_spacer["id"]})
            click_edge(second_spacer, circle)
            second_reference, _ = copied(second_spacer, circle)
            assert first_reference != second_reference, "Repeated geometry must keep distinct occurrence addresses"

            camera = settled()["rendered"]["camera"]
            exploded = command("set_explode", {"amount": 0.6, "direction": "x"})
            assert exploded["rendered"]["camera"] == camera
            command("fit_view")
            click_edge(second_spacer, circle)
            assert copied(second_spacer, circle)[0] == second_reference
            toolbar("Perspective projection")
            toolbar("Studio appearance")
            assert state()["showEdges"] is False
            click_edge(second_spacer, circle)
            assert copied(second_spacer, circle)[0] == second_reference

            page.get_by_role("switch", name="Auto-copy reference").uncheck()
            wait(lambda current: not current["autoCopy"])
            page.evaluate("(text) => navigator.clipboard.writeText(text)", sentinel)
            click_edge(second_spacer, circle)
            assert page.evaluate("navigator.clipboard.readText()") == sentinel
            page.get_by_role("button", name="Copy reference", exact=True).click()
            assert copied(second_spacer, circle)[0] == second_reference
            selected = settled()["selectedEdge"]
            page.reload()
            assert settled()["selectedEdge"] == selected
            expect(page.get_by_role("button", name="Edges", exact=True)).to_have_attribute("aria-pressed", "true")
            # Require a fresh render report, not the pre-reload report retained by the server.
            command("fit_view")

            page.get_by_role("button", name="Draw", exact=True).click()
            review_state = wait(lambda current: current["activeReviewId"] is not None)
            review_response = page.request.get(url + "api/reviews/" + review_state["activeReviewId"])
            assert review_response.ok
            assert review_response.json()["pose"]["selectedEdge"] == selected
            page.get_by_role("button", name="Back to model", exact=True).click()
            wait(lambda current: current["activeReviewId"] is None)
            settled()
            page.set_viewport_size({"width": 390, "height": 850})
            command("fit_view")
            expect(page.get_by_role("button", name="Edges", exact=True)).to_be_visible()
            click_edge(second_spacer, circle)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert not errors, errors
            report = {
                "straightEdgePicked": True, "curvedEdgePicked": True, "wholeEdgeHover": True,
                "hoverHasNoSideEffects": True, "occludedEdgeRejected": True, "faceAndPartPickingPreserved": True,
                "repeatedOccurrenceIdentity": True, "explodedIdentityStable": True, "studioPicking": True,
                "manualCopyWhileOff": True, "selectionSurvivesReload": True, "drawingPoseRetainsEdge": True,
                "narrowWindowAndHighDpr": True, "pageErrors": errors,
                "edgeReference": second_reference,
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
