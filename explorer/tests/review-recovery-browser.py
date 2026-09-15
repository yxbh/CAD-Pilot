"""Exercise recovery through the maintained UI against an isolated review server."""

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
            context = browser.new_context(viewport={"width": 1100, "height": 1000}, permissions=["clipboard-read", "clipboard-write"])
            page = context.new_page()
            errors, requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: requests.append((request.method, request.url)))
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def review(review_id):
                response = page.request.get(url + f"api/reviews/{review_id}")
                assert response.status == 200, response.text()
                return response.json()

            def wait(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while not predicate():
                    assert time.monotonic() < deadline, "Timed out waiting for recovery"
                    page.wait_for_timeout(50)

            def command(name, data=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": data or {}})
                assert response.status == 200, response.text()

            def stroke(target=page, y=0.15):
                target.get_by_role("button", name="Line", exact=True).click()
                canvas = target.get_by_label("Drawing canvas")
                bounds = canvas.bounding_box()
                target.mouse.move(bounds["x"] + bounds["width"] * 0.16, bounds["y"] + bounds["height"] * y)
                target.mouse.down()
                target.mouse.move(bounds["x"] + bounds["width"] * 0.42, bounds["y"] + bounds["height"] * (y + 0.04), steps=5)
                target.mouse.up()

            def mark_paths(target=page):
                return target.locator(".drawing-review-canvas > svg > g")

            def saved(count, review_id):
                wait(lambda: len(review(review_id)["drawing"]["present"]) == count)
                expect(page.get_by_label("Saved reviews")).to_be_enabled()

            def new_review():
                page.get_by_role("button", name="Draw", exact=True).click()
                expect(page.get_by_label("Drawing canvas")).to_be_visible()
                expect(page.get_by_role("button", name="Line", exact=True)).to_be_enabled()
                return state()["activeReviewId"]

            wait(lambda: state().get("rendered") and state()["rendered"]["revision"] == state()["revision"], 120)
            viewport = page.locator(".viewport").bounding_box()
            first_id = new_review()
            requests.clear()
            for index in range(4):
                stroke(y=0.12 + 0.07 * index)
                saved(index + 1, first_id)
            assert not [(method, address) for method, address in requests if method == "GET" and address in (url + "api/reviews", url + f"api/reviews/{first_id}")], "Settled strokes must not refresh the review list or reread full reviews"
            assert len([(method, address) for method, address in requests if method == "POST" and address == url + f"api/reviews/{first_id}"]) == 4
            assert page.locator(".viewport").bounding_box() == viewport

            other = context.new_page()
            other.goto(url)
            expect(mark_paths(other)).to_have_count(4)
            expect(other.get_by_role("button", name="Line", exact=True)).to_be_enabled()
            stroke(other, 0.42)
            saved(5, first_id)
            remote = review(first_id)
            stroke(y=0.48)
            expect(page.get_by_role("button", name="Retry save")).to_be_visible()
            expect(mark_paths()).to_have_count(5)
            page.get_by_role("button", name="Retry save").click()
            expect(page.get_by_role("alert").filter(has_text="different marks on the server")).to_be_visible()
            assert review(first_id) == remote, "Reconciliation overwrote remote marks"
            page.screenshot(path=str(output / "conflict.png"))
            page.get_by_role("button", name="Save separate review").click()
            wait(lambda: state()["activeReviewId"] != first_id)
            copy_id = state()["activeReviewId"]
            expect(page.get_by_label("Saved reviews")).to_have_value(copy_id)
            local_copy = review(copy_id)
            assert local_copy["version"] == 1
            assert len(local_copy["drawing"]["present"]) == 5
            assert local_copy["drawing"]["present"][-1] != remote["drawing"]["present"][-1]
            for field in ("image", "source", "pose"):
                assert local_copy[field] == remote[field]
            assert review(first_id) == remote, "Copy recovery changed the original"
            other.close()

            # A saved request with a lost response must reconcile the attempted drawing.
            endpoint = url + f"api/reviews/{copy_id}"
            dropped = []

            def lose_response(route):
                if route.request.method == "POST":
                    response = route.fetch()
                    assert response.status == 200, response.text()
                    dropped.append(response.json())
                    route.abort("failed")
                else:
                    route.continue_()

            page.route(endpoint, lose_response)
            stroke(y=0.19)
            expect(page.get_by_role("button", name="Retry save")).to_be_visible()
            assert dropped and review(copy_id)["version"] == 2
            stroke(y=0.26)
            expect(mark_paths()).to_have_count(7)
            assert len(dropped) == 1, "Queued edits must stop posting after an unconfirmed save"
            page.unroute(endpoint, lose_response)
            page.get_by_role("button", name="Retry save").click()
            saved(7, copy_id)
            assert review(copy_id)["version"] == 3, "Lost response should acknowledge the actual version, then save only the newer local drawing"
            expect(page.get_by_role("dialog", name="Unsaved drawing recovery")).to_have_count(0)

            def fail_save(route):
                if route.request.method == "POST":
                    route.fulfill(status=507, json={"error": "Simulated storage failure"})
                else:
                    route.continue_()

            held = []

            def hold_save(route):
                if route.request.method == "POST":
                    held.append(route)
                else:
                    route.continue_()

            page.route(endpoint, hold_save)
            stroke(y=0.33)
            wait(lambda: bool(held))
            stroke(y=0.39)
            command("open_review", {"id": first_id})
            held[0].fulfill(status=507, json={"error": "Simulated delayed storage failure"})
            expect(page.get_by_role("button", name="Retry save")).to_be_visible()
            expect(mark_paths()).to_have_count(9)
            assert len(held) == 1, "A queued stroke must not post after the preceding save fails"
            page.get_by_label("Saved reviews").select_option(first_id)
            expect(page.get_by_role("button", name="Discard local changes and leave")).to_be_visible()
            expect(page.get_by_label("Saved reviews")).to_have_value(copy_id)
            assert len(review(copy_id)["drawing"]["present"]) == 7
            page.get_by_role("button", name="Keep editing").click()
            page.wait_for_timeout(150)
            expect(page.get_by_label("Saved reviews")).to_have_value(copy_id)
            expect(mark_paths()).to_have_count(9)
            page.unroute(endpoint, hold_save)
            page.get_by_role("button", name="Retry save").click()
            saved(9, copy_id)
            assert review(copy_id)["version"] == 4
            page.get_by_role("button", name="Back to model").click()
            expect(page.get_by_label("Drawing canvas")).to_have_count(0)
            page.get_by_label("Saved reviews").select_option(copy_id)
            expect(mark_paths()).to_have_count(9)

            # Explicit loading replaces local marks only after a successful read.
            remote = review(copy_id)
            changed = json.loads(json.dumps(remote["drawing"]))
            changed["present"].append({**changed["present"][0], "id": "second-client-only"})
            response = page.request.post(endpoint, data={"drawing": changed, "version": remote["version"]})
            assert response.status == 200, response.text()
            remote = response.json()
            stroke(y=0.46)
            page.get_by_role("button", name="Retry save").click()
            expect(page.get_by_role("alert").filter(has_text="different marks on the server")).to_be_visible()
            page.get_by_role("button", name="Load server version...").click()
            expect(page.get_by_role("button", name="Discard local changes and load server")).to_be_visible()
            page.get_by_role("button", name="Discard local changes and load server").click()
            expect(page.get_by_role("dialog", name="Unsaved drawing recovery")).to_have_count(0)
            expect(mark_paths()).to_have_count(10)
            assert review(copy_id) == remote

            # A slow external review GET must not discard a stroke started after that GET.
            held_loads = []
            first_endpoint = url + f"api/reviews/{first_id}"

            def hold_load(route):
                if route.request.method == "GET":
                    held_loads.append(route)
                else:
                    route.continue_()

            page.route(first_endpoint, hold_load)
            page.route(endpoint, fail_save)
            command("open_review", {"id": first_id})
            wait(lambda: bool(held_loads))
            stroke(y=0.18)
            expect(page.get_by_role("button", name="Retry save")).to_be_visible()
            held_loads[0].fulfill(response=held_loads[0].fetch())
            page.wait_for_timeout(150)
            expect(mark_paths()).to_have_count(11)
            expect(page.get_by_label("Saved reviews")).to_have_value(copy_id)
            page.unroute(first_endpoint, hold_load)
            page.unroute(endpoint, fail_save)
            page.get_by_role("button", name="Retry save").click()
            saved(11, copy_id)
            page.get_by_role("button", name="Back to model").click()
            page.get_by_label("Saved reviews").select_option(copy_id)
            expect(mark_paths()).to_have_count(11)
            remote = review(copy_id)

            # Local export and explicit exit work with all browser network calls unavailable.
            def offline(route):
                route.abort("internetdisconnected")

            page.route(url + "api/**", offline)
            stroke(y=0.22)
            expect(page.get_by_role("button", name="Retry save")).to_be_visible()
            expect(mark_paths()).to_have_count(12)
            page.get_by_role("button", name="Retry save").click()
            expect(page.get_by_role("dialog", name="Unsaved drawing recovery")).to_be_visible()
            expect(mark_paths()).to_have_count(12)
            page.get_by_role("button", name="Load server version...").click()
            page.get_by_role("button", name="Discard local changes and load server").click()
            expect(mark_paths()).to_have_count(12)
            page.get_by_role("button", name="Keep editing").click()
            page.get_by_role("button", name="Copy local image").click()
            expect(page.get_by_role("status").filter(has_text="Marked image copied")).to_be_visible()
            copied = page.evaluate("""async () => {
                const items = await navigator.clipboard.read();
                const blob = await items.find(item => item.types.includes('image/png')).getType('image/png');
                return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
            }""")
            with page.expect_download() as download:
                page.get_by_role("button", name="Download local image").click()
            local_path = output / "local-unsaved.png"
            download.value.save_as(local_path)
            expect(page.get_by_role("status").filter(has_text="not saved to the server")).to_be_visible()
            local_image = Image.open(local_path).convert("RGB")
            clipboard_image = Image.open(io.BytesIO(base64.b64decode(copied.split(",", 1)[1]))).convert("RGB")
            assert not ImageChops.difference(local_image, clipboard_image).getbbox(), "Offline PNG download differs from native copied local image"
            assert review(copy_id) == remote, "Local export must not be presented as a server save"
            assert page.locator(".viewport").bounding_box() == viewport, "Recovery UI shifted the fixed viewport"
            page.screenshot(path=str(output / "offline-export.png"))
            page.get_by_role("button", name="Leave review...").click()
            page.get_by_role("button", name="Discard local changes and leave").click()
            expect(page.get_by_label("Drawing canvas")).to_have_count(0)
            expect(page.get_by_role("alert").filter(has_text="server could not be updated")).to_be_visible()
            assert review(copy_id) == remote
            page.unroute(url + "api/**", offline)
            page.reload()
            expect(mark_paths()).to_have_count(11)
            assert review(copy_id) == remote, "Reload must retain the server drawing, not discarded local-only marks"
            assert not errors, errors
            report = {
                "settledStrokeListCalls": 0, "settledStrokeReviewReads": 0, "settledStrokePosts": 4,
                "secondPanelConflict": True, "localAndRemoteMarksPreserved": True,
                "separateCopyPreservesCapture": True, "lostResponseReconciled": True,
                "transientRetryWithQueuedEdits": True, "switchPreservesUnsavedDrawing": True,
                "switchDuringReadPreservesLocal": True,
                "explicitLoadServer": True, "offlineLoadFailurePreservesLocal": True,
                "offlineDownloadMatchesNativeClipboard": True, "offlineExplicitExit": True,
                "discardedMarksNotReloaded": True, "fixedViewport": True, "pageErrors": errors,
            }
            (output / "recovery-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.url, args.output)
