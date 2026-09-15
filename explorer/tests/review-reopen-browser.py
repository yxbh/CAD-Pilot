"""Verify that review opening suspends live rendering before waiting for HTTP."""

import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        reads, opens = [], []
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)

            def state():
                return page.request.get(url + "api/state").json()

            def settled():
                deadline = time.monotonic() + 30
                while True:
                    value = state()
                    if value.get("rendered") and value["rendered"]["revision"] == value["revision"]:
                        return value
                    assert time.monotonic() < deadline, value
                    page.wait_for_timeout(50)

            settled()
            for name, data in [
                ("set_projection", {"projection": "orthographic"}),
                ("set_appearance", {"mode": "studio", "finish": "satin"}),
            ]:
                result = page.request.post(url + "api/command", data={"name": name, "input": data})
                assert result.ok, result.text()
                settled()
            page.get_by_role("button", name="Draw", exact=True).click()
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            review_id = state()["activeReviewId"]
            original = page.request.get(url + f"api/reviews/{review_id}").json()
            page.get_by_role("button", name="Back to model").click()
            expect(page.get_by_label("Drawing canvas")).to_have_count(0)
            settled()
            page.reload()

            # Hold each response rather than rely on GPU speed or a longer assertion timeout.
            endpoint = url + f"api/reviews/{review_id}"

            def hold_read(route):
                reads.append(route)

            def hold_open(route):
                if route.request.post_data_json["name"] == "open_review":
                    opens.append(route)
                else:
                    route.continue_()

            page.route(endpoint, hold_read)
            page.route(url + "api/command", hold_open)
            live = page.locator(".live-scene")
            canvas = page.get_by_label("Interactive STEP assembly")
            expect(canvas).to_be_visible()
            canvas.evaluate("canvas => { window.originalCanvas = canvas; }")
            viewport = page.locator(".viewport").bounding_box()

            def opening():
                expect(live).to_have_attribute("aria-hidden", "true")
                assert live.evaluate("element => element.inert")
                expect(page.get_by_role("status").filter(has_text="Opening captured review")).to_be_visible()
                assert canvas.evaluate("canvas => canvas === window.originalCanvas")
                assert page.locator(".viewport").bounding_box() == viewport

            page.get_by_label("Saved reviews").select_option(review_id)
            opening()
            assert len(reads) == 1
            reads.pop().fulfill(status=503, json={"error": "Review read deliberately unavailable"})
            expect(live).to_have_attribute("aria-hidden", "false")
            expect(page.get_by_label("Saved reviews")).to_be_enabled()
            expect(page.get_by_label("Saved reviews")).to_have_value("")
            expect(page.get_by_role("alert").filter(has_text="Review read deliberately unavailable")).to_be_visible()
            page.get_by_role("button", name="Dismiss message").click()
            assert not opens, "A failed read must not change the server view"
            assert state()["activeReviewId"] is None

            page.get_by_label("Saved reviews").select_option(review_id)
            opening()
            read = reads.pop()
            read.fulfill(response=read.fetch())
            deadline = time.monotonic() + 5
            while not opens:
                assert time.monotonic() < deadline
                page.wait_for_timeout(20)
            opening()
            opens.pop().fulfill(status=503, json={"error": "Opening review deliberately unavailable"})
            expect(live).to_have_attribute("aria-hidden", "false")
            expect(page.get_by_label("Saved reviews")).to_be_enabled()
            expect(page.get_by_role("alert").filter(has_text="Opening review deliberately unavailable")).to_be_visible()
            page.get_by_role("button", name="Dismiss message").click()
            assert state()["activeReviewId"] is None

            page.unroute(endpoint, hold_read)
            page.unroute(url + "api/command", hold_open)
            page.get_by_label("Saved reviews").select_option(review_id)
            expect(page.get_by_label("Drawing canvas")).to_be_visible()
            expect(page.get_by_label("Saved reviews")).to_have_value(review_id)
            assert canvas.evaluate("canvas => canvas === window.originalCanvas")
            assert page.locator(".viewport").bounding_box() == viewport
            assert page.request.get(endpoint).json() == original
            assert not errors, errors
            report = {
                "suspendedBeforeReviewRead": True, "suspendedBeforeOpenResponse": True,
                "readFailureRestoresModel": True, "openFailureRestoresModel": True,
                "sameCanvas": True, "fixedViewport": True, "reloadThenReopen": True, "pageErrors": errors,
            }
            (output / "reopen-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        finally:
            for route in [*reads, *opens]:
                route.abort()
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.url, args.output)
