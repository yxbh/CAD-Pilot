import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from browser_session import BrowserSession


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)

            session = BrowserSession(page, url, errors)
            state, wait, settled, command = session.state, session.wait, session.settled, session.command

            def changed(action):
                revision = state()["revision"]
                action()
                wait(lambda current: current["revision"] > revision)
                return settled()

            def same_camera(expected, actual):
                assert expected["projection"] == actual["projection"]
                for field in ["position", "target", "up"]:
                    assert max(abs(a - b) for a, b in zip(expected[field], actual[field])) < 1e-6, (field, expected, actual)
                for field in ["viewHeight", "fov"]:
                    assert abs(expected[field] - actual[field]) < 1e-6, (field, expected, actual)

            wait(lambda current: not current["loading"] and current["documentRevision"], 120)
            settled()
            canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            slider = page.get_by_role("slider", name="Explode amount")
            cases = []
            for projection, appearance in [("perspective", "inspect"), ("orthographic", "studio")]:
                command("reset_view")
                command("set_projection", {"projection": projection})
                command("set_appearance", {"mode": appearance})
                named = command("set_view", {"preset": "front"})
                viewport = canvas.bounding_box()
                x, y = viewport["width"] * 0.5, viewport["y"] + viewport["height"] * 0.5

                def drag(button, dx, dy):
                    page.mouse.move(x, y)
                    page.mouse.down(button=button)
                    page.mouse.move(x + dx, y + dy, steps=12)
                    page.mouse.up(button=button)

                changed(lambda: drag("left", 76, 43))
                changed(lambda: drag("right", 29, -18))
                changed(lambda: (page.mouse.move(x, y), page.mouse.wheel(0, -100)))
                current = settled()
                camera = current["rendered"]["camera"]
                assert camera["position"] != named["rendered"]["camera"]["position"], "Regression requires an orbited view, not the original preset"
                assert camera["target"] != named["rendered"]["camera"]["target"], "Regression requires a panned view"
                assert abs(camera["viewHeight"] - named["rendered"]["camera"]["viewHeight"]) > 1, "Regression requires a zoomed view"
                geometry = current["rendered"]["geometryIds"]
                fit_nonce = current["fitNonce"]
                initial_positions = current["rendered"]["positions"]
                command("select_parts", {"ids": [current["parts"][0]["id"]]})
                reference = state()["selectedReferences"]
                canvas.evaluate("canvas => window.explosionCanvas = canvas")
                page.evaluate("""() => {
                    window.axisFrames = [];
                    window.readAxes = () => [...document.querySelectorAll('.axis-indicator button')]
                      .map(button => [button.getAttribute('aria-label'), button.style.left, button.style.top]).sort();
                    window.axesBefore = JSON.stringify(window.readAxes());
                    const track = () => {
                      window.axisFrames.push(JSON.stringify(window.readAxes()));
                      window.axisFrame = requestAnimationFrame(track);
                    }; track();
                }""")
                box = slider.bounding_box()
                page.mouse.move(box["x"] + 8, box["y"] + box["height"] / 2)
                page.mouse.down()
                page.mouse.move(box["x"] + box["width"] - 8, box["y"] + box["height"] / 2, steps=20)
                assert int(slider.input_value()) > 90
                assert state()["explode"] == 0, "Pointer drag should preview before release"
                page.mouse.up()
                wait(lambda current: current["explode"] > 0.9)
                exploded = settled()
                same_camera(camera, exploded["rendered"]["camera"])
                assert exploded["rendered"]["positions"] != initial_positions
                assert exploded["fitNonce"] == fit_nonce
                assert exploded["selectedReferences"] == reference
                assert exploded["rendered"]["geometryIds"] == geometry
                assert canvas.evaluate("canvas => canvas === window.explosionCanvas")
                frames = page.evaluate("() => { cancelAnimationFrame(window.axisFrame); return window.axisFrames; }")
                assert frames and all(frame == page.evaluate("window.axesBefore") for frame in frames), "Orientation changed during slider drag"
                for key in ["Home", "ArrowRight", "End"]:
                    same_camera(camera, changed(lambda key=key: slider.press(key))["rendered"]["camera"])
                same_camera(camera, changed(lambda: page.get_by_label("Explosion direction", exact=True).select_option("z"))["rendered"]["camera"])
                same_camera(camera, changed(lambda: page.get_by_role("button", name="Keep fixed", exact=True).click())["rendered"]["camera"])
                same_camera(camera, command("set_explode", {"amount": 0.45, "direction": "y", "fixedId": ""})["rendered"]["camera"])
                same_camera(camera, changed(lambda: page.get_by_role("button", name="Reassemble", exact=True).click())["rendered"]["camera"])
                command("set_explode", {"amount": 0.4})
                page.get_by_role("button", name="Draw", exact=True).click()
                review_id = wait(lambda current: current["activeReviewId"])["activeReviewId"]
                expect(page.get_by_label("Drawing canvas")).to_be_visible()
                review = page.request.get(url + f"api/reviews/{review_id}").json()
                same_camera(camera, review["pose"]["camera"])
                page.get_by_role("button", name="Back to model").click()
                wait(lambda current: current["activeReviewId"] is None)
                same_camera(camera, settled()["rendered"]["camera"])
                page.reload()
                expect(canvas).to_be_visible()
                same_camera(camera, command("set_auto_copy", {"enabled": False})["rendered"]["camera"])
                command("set_explode", {"amount": 1, "direction": "z"})
                same_camera(camera, settled()["rendered"]["camera"])
                fitted = changed(lambda: page.get_by_role("button", name="Fit assembly", exact=True).click())
                assert fitted["rendered"]["inFrame"], "Explicit fit must include exploded parts"
                assert fitted["rendered"]["camera"]["position"] != camera["position"]
                expect(page.get_by_role("alert")).to_have_count(0)
                cases.append({"projection": projection, "appearance": appearance, "camera": camera, "trackedFrames": len(frames)})
            assert not errors, errors
            report = {
                "cases": cases, "pointerAndKeyboardRetainCamera": True, "directionFixedPartAndReassembleRetainCamera": True,
                "agentExplosionRetainsCamera": True, "captureAndReloadRetainCamera": True, "explicitFitFramesExplodedParts": True,
                "geometryAndReferenceRetained": True, "pageErrors": errors,
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
