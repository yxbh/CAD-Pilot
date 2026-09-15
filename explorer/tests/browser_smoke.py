import argparse
import hashlib
import io
import json
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright


class ReferenceMarkup(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.refs = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        if tag == "copilot-ref":
            self.refs.append(dict(attrs))


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1000, "height": 1000}, permissions=["clipboard-read", "clipboard-write"])
            errors, external, draft_requests = [], [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: external.append(request.url) if urlparse(request.url).hostname not in ("127.0.0.1", None) else None)
            page.on("request", lambda request: draft_requests.append(request.url) if any(endpoint in request.url for endpoint in ("/add-reference", "/send-selection")) else None)
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

            def settled():
                return wait_state(lambda current: current.get("rendered") and current["rendered"]["revision"] == current["revision"])

            def api_command(name, value=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": value or {}})
                assert response.status == 200, response.text()
                return settled()

            def copied():
                expect(page.locator(".reference-bar")).to_have_attribute("data-copy-status", "copied")
                text = page.evaluate("navigator.clipboard.readText()")
                refs = ReferenceMarkup(text).refs
                assert len(refs) == 1 and refs[0]["kind"] == "file", text
                path = Path(refs[0]["target-id"])
                assert path.is_file(), "Clipboard reference was reported ready before its descriptor existed"
                descriptor = json.loads(path.read_text(encoding="utf-8"))
                assert descriptor["kind"] == "cad-prototype-selection"
                return text, refs[0], descriptor

            def click_selected_face():
                point = settled()["rendered"]["selectedFaceScreen"]
                assert point is not None
                page.locator("canvas").click(position={"x": point[0], "y": point[1]})

            wait_state(lambda current: not current["loading"] and len(current["parts"]) > 1, timeout=120)
            api_command("reset_view")
            api_command("show_all")
            api_command("set_selection_mode", {"mode": "face"})
            original = api_command("set_auto_copy", {"enabled": True})
            expect(page.get_by_role("switch", name="Auto-copy reference")).to_be_checked()
            expect(page.locator("footer")).to_have_count(0)
            expect(page.get_by_role("button", name="Add reference", exact=True)).to_have_count(0)
            expect(page.get_by_text("Click a face, then paste into chat", exact=True)).to_have_count(0)
            expect(page.locator(".warnings")).to_have_count(0)
            assert original["rendered"]["inFrame"]
            viewport = page.locator(".viewport")
            image = Image.open(io.BytesIO(viewport.screenshot())).convert("RGB")
            assert max(high - low for low, high in image.getextrema()) > 40

            canvas = page.locator("canvas")
            bounds = canvas.bounding_box()
            canvas.click(position={"x": bounds["width"] * 0.5, "y": bounds["height"] * 0.5})
            wait_state(lambda current: current["selectedFace"] is not None)
            picked = settled()
            original_face = picked["selectedFace"]
            text, native, descriptor = copied()
            assert descriptor["face"]["id"] == original_face["faceId"]
            assert descriptor["occurrence"]["id"] == original_face["nodeId"]
            assert descriptor["source"]["sha256"] == picked["documentRevision"]
            assert descriptor["reference"] == picked["selectedReferences"][0]["reference"]
            assert native["label"] == "Cover plate \u00b7 Face f6"
            assert native["label"].replace("\\", "/").split("/")[-1] == native["label"], "Host file-chip formatting must not discard the part name"
            assert picked["rendered"]["highlightedTriangles"] == 2
            assert not draft_requests, "Face click must not directly modify the message draft"
            page.screenshot(path=str(output / "face-copied.png"))

            page.get_by_role("switch", name="Auto-copy reference").uncheck()
            wait_state(lambda current: not current["autoCopy"])
            sentinel = "Auto-copy off leaves this text alone"
            page.evaluate("(text) => navigator.clipboard.writeText(text)", sentinel)
            click_selected_face()
            settled()
            assert page.evaluate("navigator.clipboard.readText()") == sentinel
            page.get_by_role("button", name="Copy reference", exact=True).click()
            assert copied()[0] == text
            page.reload()
            settled()
            expect(page.get_by_role("switch", name="Auto-copy reference")).not_to_be_checked()
            page.get_by_role("switch", name="Auto-copy reference").check()
            wait_state(lambda current: current["autoCopy"])
            page.evaluate("(text) => navigator.clipboard.writeText(text)", sentinel)
            api_command("select_face", {"id": original_face["nodeId"], "faceId": original_face["faceId"], "topologyRevision": picked["topologyRevision"]})
            assert page.evaluate("navigator.clipboard.readText()") == sentinel

            held = []
            preparations = []

            def delay_first_preparation(route):
                preparations.append(route)
                if len(preparations) == 1:
                    held.append(route)
                else:
                    route.continue_()

            page.route("**/api/clipboard-reference", delay_first_preparation)
            page.locator(".part-select").first.click()
            page.locator(".part-select").last.click()
            assert len(held) == 1
            held[0].continue_()
            wait_state(lambda current: current["selectedFace"] is None and current["selectedIds"] == [original_face["nodeId"]])
            assert copied()[1]["label"] == "Cover plate \u00b7 Part", "Late preparation must not restore an older clipboard target"
            assert len(preparations) == 2
            page.unroute("**/api/clipboard-reference", delay_first_preparation)

            page.locator(".part-select").first.click()
            wait_state(lambda current: current["selectedIds"][0] != original_face["nodeId"])
            copied()
            page.get_by_role("button", name="Keep fixed", exact=True).click()
            wait_state(lambda current: bool(current["fixedId"]))
            fixed = settled()["fixedId"]
            api_command("select_face", {"id": original_face["nodeId"], "faceId": original_face["faceId"], "topologyRevision": picked["topologyRevision"]})
            before_explosion = settled()["rendered"]["camera"]
            slider = page.get_by_role("slider", name="Explode amount")
            slider.focus()
            slider.press("End")
            wait_state(lambda current: current["explode"] == 1)
            exploded = settled()
            assert exploded["rendered"]["camera"] == before_explosion
            exploded = api_command("fit_view")
            assert exploded["rendered"]["inFrame"]
            before_positions = {item["id"]: item["position"] for item in original["rendered"]["positions"]}
            after_positions = {item["id"]: item["position"] for item in exploded["rendered"]["positions"]}
            assert before_positions[fixed] == after_positions[fixed]
            assert any(before_positions[key] != value for key, value in after_positions.items() if key != fixed)
            click_selected_face()
            assert settled()["selectedFace"] == original_face
            assert copied()[0] == text
            assert ImageChops.difference(image, Image.open(io.BytesIO(viewport.screenshot())).convert("RGB")).getbbox()
            page.screenshot(path=str(output / "exploded-face-copied.png"))

            page.evaluate("""() => {
                window.savedWrite = navigator.clipboard.write.bind(navigator.clipboard);
                window.savedWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
                window.savedExecCommand = document.execCommand.bind(document);
                navigator.clipboard.write = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
                navigator.clipboard.writeText = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
                document.execCommand = () => false;
            }""")
            click_selected_face()
            expect(page.locator(".reference-bar")).to_have_attribute("data-copy-status", "blocked")
            reference_field = page.get_by_label("Selected CAD reference")
            assert reference_field.input_value() == text
            assert reference_field.evaluate("(element) => document.activeElement === element && element.selectionStart === 0 && element.selectionEnd === element.value.length")
            page.evaluate("""() => {
                navigator.clipboard.write = window.savedWrite;
                navigator.clipboard.writeText = window.savedWriteText;
                document.execCommand = window.savedExecCommand;
            }""")
            page.get_by_role("button", name="Copy reference", exact=True).click()
            assert copied()[0] == text
            page.get_by_role("button", name="Reassemble", exact=True).click()
            wait_state(lambda current: current["explode"] == 0)
            assert settled()["rendered"]["positions"] == original["rendered"]["positions"]
            page.set_viewport_size({"width": 390, "height": 850})
            api_command("fit_view")
            assert settled()["rendered"]["inFrame"]
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(output / "narrow.png"))

            assert not errors, errors
            assert not external, external
            assert not draft_requests, draft_requests
            report = {
                "pickedFace": original_face, "nativeClipboard": text, "referenceFile": native["target-id"],
                "exactCachedFace": descriptor["reference"], "autoCopy": True, "manualCopyWhileOff": True,
                "persistedPreference": True, "agentDoesNotCopy": True, "latestClipboardSelection": True,
                "sameReferenceWhenExploded": True, "clipboardDenialFallback": True, "noDraftSideEffects": True,
                "footerRemoved": True, "genericImportNoticeRemoved": True, "pageErrors": errors,
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
