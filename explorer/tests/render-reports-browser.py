import argparse
import json
import math
import time
import uuid
from pathlib import Path

from build123d import Box, export_step
from playwright.sync_api import expect, sync_playwright


def fixtures(output):
    output.mkdir(parents=True, exist_ok=True)
    for name, width in [("a", 10), ("b", 12)]:
        solid = Box(width, 10, 10)
        assert solid.is_valid and solid.volume > 0
        source = output / f"{name}.step"
        export_step(solid, source)
        with source.open("a") as stream:
            stream.write(f"\n/* isolated render-report fixture {uuid.uuid4()} */\n")
    (output / "broken.step").write_text(f"not a STEP {uuid.uuid4()}\n")


def run(url, output):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        pending_routes = set()
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            held = []
            mode = None

            def intercept(route):
                nonlocal mode
                if mode is None:
                    route.continue_()
                    return
                chosen, mode = mode, None
                report = route.request.post_data_json
                response = route.fetch() if chosen == "response" else None
                pending_routes.add(route)
                held.append((route, report, response))

            page.route("**/api/rendered", intercept)
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def wait(predicate):
                deadline = time.monotonic() + 20
                while True:
                    current = state()
                    if predicate(current):
                        return current
                    assert time.monotonic() < deadline, f"State did not settle: {current}; errors={errors}"
                    page.wait_for_timeout(25)

            def settled():
                return wait(lambda s: s.get("rendered") and s["rendered"]["revision"] == s["revision"])

            def command(name, data=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": data or {}})
                assert response.ok, response.text()
                return response.json()

            def hold(kind):
                nonlocal mode
                mode = kind
                command("fit_view")
                wait(lambda _: bool(held))
                return held.pop()

            def release(route, response=None, **kwargs):
                with page.expect_response(lambda response: response.request == route.request):
                    route.fulfill(response=response, **kwargs)
                pending_routes.remove(route)
                # Let the fetch rejection and React error update run before checking the banner.
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

            def assert_current(expected):
                current = settled()
                assert current == expected, "Late renderer completion changed the current view"
                report = current["rendered"]
                assert report["modelHash"] == current["documentRevision"]
                assert report["topologyRevision"] == current["topologyRevision"]
                assert report["camera"] == current["camera"]
                assert report["selectedIds"] == current["selectedIds"]
                assert report["selectedEdge"] == current["selectedEdge"]
                assert report["inFrame"] and not current["loading"] and not current["error"]
                expect(page.locator(".message.error")).to_have_count(0)

            settled()
            canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            expect(canvas).to_be_visible()
            canvas.evaluate("canvas => window.oldRenderCanvas = canvas")
            route, old, _ = hold("request")
            command("load_file", {"file": "b.step"})
            settled()
            command("set_view", {"preset": "top"})
            settled()
            model = page.request.get(url + "api/model").json()
            node = next(node for node in model["nodes"] if node.get("partId"))
            part = next(part for part in model["parts"] if part["id"] == node["partId"])
            command("select_edge", {"id": node["id"], "edgeId": part["edges"][0]["id"], "topologyRevision": model["topologyRevision"]})
            current = settled()
            assert current["documentRevision"] != old["modelHash"]
            assert current["topologyRevision"] != old["topologyRevision"]
            assert math.isclose(model["bounds"]["max"][0] - model["bounds"]["min"][0], 12, abs_tol=1e-6)
            assert canvas.evaluate("canvas => canvas !== window.oldRenderCanvas && !window.oldRenderCanvas.isConnected")
            reference = current["selectedReferences"][0]["reference"]
            assert reference.startswith("cadproto:v2:")
            inspected = command("inspect_reference", {"reference": reference})
            assert inspected["occurrence"]["id"] == node["id"]
            response = route.fetch()
            assert response.status == 200
            assert response.json() == {"accepted": False, "reason": "superseded_view"}
            release(route, response=response)
            assert_current(current)

            # A response already in flight may fail after its entire renderer has unmounted.
            canvas.evaluate("canvas => window.oldRenderCanvas = canvas")
            route, old, response = hold("response")
            assert response.ok and response.json() == {"accepted": True}
            command("load_file", {"file": "a.step"})
            current = settled()
            assert current["topologyRevision"] != old["topologyRevision"]
            assert canvas.evaluate("canvas => canvas !== window.oldRenderCanvas && !window.oldRenderCanvas.isConnected")
            release(route, status=409, json={"error": "Renderer revision does not match the model", "code": "bad_render_report"})
            assert_current(current)

            # A newer view can supersede a request without unmounting the renderer.
            canvas.evaluate("canvas => window.oldRenderCanvas = canvas")
            route, _, _ = hold("request")
            command("set_view", {"preset": "right"})
            current = settled()
            assert canvas.evaluate("canvas => canvas === window.oldRenderCanvas")
            release(route, status=503, json={"error": "Obsolete render request failed", "code": "test_failure"})
            assert_current(current)

            # Do not suppress a current failure, or erase it on a later successful frame.
            route, report, _ = hold("request")
            report["modelHash"] = "0" * 64
            response = route.fetch(post_data=json.dumps(report))
            assert response.status == 409
            release(route, response=response)
            expect(page.locator(".message.error")).to_contain_text("Renderer revision does not match the model")
            page.set_viewport_size({"width": 1240, "height": 900})
            settled()
            expect(page.locator(".message.error")).to_contain_text("Renderer revision does not match the model")
            command("fit_view")
            settled()
            page.reload()
            settled()
            expect(page.locator(".message.error")).to_have_count(0)

            # A failed upload keeps the previous model, and its error must survive render success.
            before = state()
            route, _, _ = hold("request")
            page.locator("input[type='file']").set_input_files(str(output / "broken.step"))
            failed = wait(lambda s: not s["loading"] and bool(s["error"]))
            settled()
            assert failed["documentRevision"] == before["documentRevision"]
            assert failed["topologyRevision"] == before["topologyRevision"]
            expect(page.locator(".message.error")).to_contain_text("STEP conversion failed")
            release(route, status=409, json={"error": "Renderer revision does not match the model", "code": "bad_render_report"})
            expect(page.locator(".message.error")).to_contain_text("STEP conversion failed")
            page.set_viewport_size({"width": 1220, "height": 880})
            settled()
            expect(page.locator(".message.error")).to_contain_text("STEP conversion failed")
            assert not errors, errors
            print(json.dumps({"delayedOldModel": "superseded_view", "unmountedFailure": "ignored",
                              "olderViewFailure": "ignored", "currentFailure": "visible",
                              "failedImport": "visible", "reference": reference,
                              "currentRevision": state()["revision"]}))
        finally:
            for route in pending_routes:
                route.abort()
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixtures-only", action="store_true")
    args = parser.parse_args()
    if args.fixtures_only:
        fixtures(args.output)
    else:
        run(args.url, args.output)
