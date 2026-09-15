"""Live R3F camera ownership regression; run against an isolated fixture view."""

import argparse
import json
import math
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


# Observe the actual R3F store through React's devtools contract, without a
# production debug API or importing a second copy of Three/R3F into the page.
LIVE_STORE = """
(() => {
  window.cameraTest = { store: null, losses: 0 };
  let renderer = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => ++renderer,
    onCommitFiberRoot: (_id, root) => {
      const visit = fiber => {
        if (!fiber) return;
        const store = fiber.memoizedProps?.store;
        if (store?.getState?.().gl?.domElement) window.cameraTest.store = store;
        visit(fiber.child);
        visit(fiber.sibling);
      };
      visit(root.current);
    },
    onCommitFiberUnmount: () => {},
  };
})();
"""


def close(actual, expected, label, tolerance=1e-6):
    assert math.isclose(actual, expected, rel_tol=1e-9, abs_tol=tolerance), (label, actual, expected)


def same_camera(expected, actual, position=True):
    assert expected["projection"] == actual["projection"], (expected, actual)
    for field in ["target", "up"] + (["position"] if position else []):
        for a, b in zip(actual[field], expected[field]):
            close(a, b, field)
    for field in ["fov", "viewHeight"]:
        close(actual[field], expected[field], field)


def run(url, output):
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1248, "height": 920})
            cdp = page.context.new_cdp_session(page)
            page.add_init_script(LIVE_STORE)
            errors, reports = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: reports.append(request.post_data_json) if request.url == url + "api/rendered" else None)
            page.goto(url)

            def state():
                response = page.request.get(url + "api/state")
                assert response.ok, response.text()
                return response.json()

            def wait(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while True:
                    current = state()
                    if predicate(current):
                        return current
                    assert time.monotonic() < deadline, f"Camera did not settle: {current}; errors={errors}"
                    page.wait_for_timeout(50)

            def settled():
                return wait(lambda current: current.get("rendered") and current["rendered"]["revision"] == current["revision"])

            def command(name, data=None):
                response = page.request.post(url + "api/command", data={"name": name, "input": data or {}})
                assert response.ok, response.text()
                return settled()

            def changed(action):
                revision = state()["revision"]
                action()
                wait(lambda current: current["revision"] > revision)
                return settled()

            def fresh():
                # Size/DPR need not change the document revision. Do not accept a
                # pre-resize report merely because its revision still matches.
                return command("set_auto_copy", {"enabled": False})

            def resize(action):
                previous_reports = len(reports)
                revision = state()["revision"]
                action()
                wait(lambda _: len(reports) > previous_reports)
                page.wait_for_timeout(200)
                assert state()["revision"] == revision, "Resize must not issue a model/view command"
                assert reports[-1]["revision"] == revision, "Resize must publish a fresh report at the same revision"

            def live():
                return page.evaluate("""() => {
                  const s = window.cameraTest.store.getState(), c = s.camera;
                  const e = c.matrixWorld.elements;
                  return {
                    projection: c.isOrthographicCamera ? "orthographic" : "perspective",
                    position: c.position.toArray(), up: c.up.toArray(),
                    direction: [-e[8], -e[9], -e[10]], zoom: c.zoom,
                    matrix: c.projectionMatrix.toArray(), manual: c.manual === true,
                    frustum: c.isOrthographicCamera ? [c.left, c.right, c.top, c.bottom] : null,
                    aspect: c.aspect ?? null, fov: c.fov ?? null,
                    width: s.size.width, height: s.size.height, dpr: s.viewport.dpr,
                    pixels: [s.gl.domElement.width, s.gl.domElement.height],
                    canvasRetained: s.gl.domElement === window.cameraTest.canvas,
                    contextRetained: s.gl.getContext() === window.cameraTest.context,
                    cameraRetained: c === window.cameraTest.camera,
                    losses: window.cameraTest.losses,
                  };
                }""")

            def measured(current=None):
                current = current or fresh()
                report = current["rendered"]["camera"]
                actual = live()
                assert actual["projection"] == report["projection"]
                assert actual["manual"], "The active camera must opt out of R3F automatic projection updates"
                for field in ["position", "up"]:
                    for a, b in zip(actual[field], report[field]):
                        close(a, b, f"live {field}")
                distance = math.dist(actual["position"], report["target"])
                for axis in range(3):
                    close(actual["direction"][axis], (report["target"][axis] - actual["position"][axis]) / distance, "live direction")
                # Measure the real projection matrix, not saved viewHeight or a
                # controller constant: its Y scale determines the visible span.
                height = 2 / actual["matrix"][5]
                if actual["projection"] == "perspective":
                    height *= distance
                    close(actual["fov"], report["fov"], "live fov")
                    close(actual["aspect"], actual["width"] / actual["height"], "live aspect")
                else:
                    left, right, top, bottom = actual["frustum"]
                    close((top - bottom) / actual["zoom"], height, "live frustum")
                    close((right - left) / (top - bottom), actual["width"] / actual["height"], "live ortho aspect")
                close(height, report["viewHeight"], "reported height versus actual projection")
                for pixels, logical in zip(actual["pixels"], [actual["width"], actual["height"]]):
                    assert abs(pixels - logical * actual["dpr"]) <= 1
                return report, actual

            def remember():
                page.evaluate("""() => {
                  const t = window.cameraTest, s = t.store.getState();
                  t.canvas = s.gl.domElement; t.context = s.gl.getContext(); t.camera = s.camera;
                  t.canvas.addEventListener("webglcontextlost", () => t.losses++);
                }""")

            def preserved(expected, prior, label):
                camera, actual = measured()
                same_camera(expected, camera)
                for field in ["direction"]:
                    for a, b in zip(actual[field], prior[field]):
                        close(a, b, label + " " + field)
                close(actual["zoom"], prior["zoom"], label + " zoom")
                assert actual["canvasRetained"] and actual["contextRetained"] and actual["cameraRetained"], (label, actual)
                assert actual["losses"] == 0
                assert state()["fitNonce"] == fit_nonce, label
                return actual

            wait(lambda current: not current["loading"] and current["documentRevision"], 120)
            wait(lambda _: page.evaluate("() => !!window.cameraTest.store?.getState().camera"))
            settled()
            canvas = page.locator("canvas[aria-label='Interactive STEP assembly']")
            cases = []
            for projection in ["orthographic", "perspective"]:
                page.set_viewport_size({"width": 1248, "height": 920})
                command("reset_view")
                command("set_projection", {"projection": projection})
                command("set_appearance", {"mode": "inspect"})
                initial = command("set_view", {"preset": "front"})["rendered"]["camera"]
                frame = canvas.bounding_box()
                x, y = frame["x"] + frame["width"] / 2, frame["y"] + frame["height"] / 2

                def drag(button, dx, dy):
                    page.mouse.move(x, y)
                    page.mouse.down(button=button)
                    page.mouse.move(x + dx, y + dy, steps=12)
                    page.mouse.up(button=button)

                changed(lambda: drag("left", 76, 43))
                changed(lambda: drag("right", 29, -18))
                changed(lambda: (page.mouse.move(x, y), page.mouse.wheel(0, -100)))
                remember()
                camera, actual = measured()
                assert camera["position"] != initial["position"]
                assert camera["target"] != initial["target"]
                assert abs(camera["viewHeight"] - initial["viewHeight"]) > 1
                fit_nonce = state()["fitNonce"]
                sizes = []
                for _ in range(2):
                    resize(lambda: page.get_by_role("button", name="Toggle parts panel", exact=True).click())
                    resized = preserved(camera, actual, "parts panel")
                    assert resized["width"] != actual["width"]
                    actual = resized
                    sizes.append([actual["width"], actual["height"]])
                for width, height in [(920, 920), (920, 640), (560, 850), (1248, 920)]:
                    resize(lambda: page.set_viewport_size({"width": width, "height": height}))
                    actual = preserved(camera, actual, "viewport resize")
                    sizes.append([actual["width"], actual["height"]])
                for dpr in [2, 1.25, 1]:
                    # Keep Canvas's [1, 2] DPR policy in sync with emulated device
                    # metrics, then exercise the real DPR-only store subscription.
                    def change_dpr():
                        cdp.send("Emulation.setDeviceMetricsOverride", {
                            "width": 1248, "height": 920, "deviceScaleFactor": dpr, "mobile": False,
                        })
                        page.evaluate("dpr => window.cameraTest.store.getState().setDpr(dpr)", dpr)

                    resize(change_dpr)
                    actual = preserved(camera, actual, "DPR")
                    close(actual["dpr"], dpr, "R3F DPR")
                other = "perspective" if projection == "orthographic" else "orthographic"
                command("set_projection", {"projection": other})
                converted, converted_live = measured()
                close(converted["viewHeight"], camera["viewHeight"], "projection conversion")
                for a, b in zip(converted["target"], camera["target"]):
                    close(a, b, "projection target")
                for a, b in zip(converted_live["direction"], actual["direction"]):
                    close(a, b, "projection direction")
                command("set_projection", {"projection": projection})
                returned, returned_live = measured()
                same_camera(camera, returned, position=projection == "perspective")
                assert returned_live["canvasRetained"] and returned_live["contextRetained"] and returned_live["losses"] == 0
                for a, b in zip(returned_live["direction"], actual["direction"]):
                    close(a, b, "roundtrip direction")
                remember()
                fit_nonce = state()["fitNonce"]
                resize(lambda: page.set_viewport_size({"width": 1080, "height": 760}))
                preserved(returned, returned_live, "pre-capture resize")
                page.get_by_role("button", name="Draw", exact=True).click()
                review_id = wait(lambda current: current["activeReviewId"])["activeReviewId"]
                expect(page.get_by_label("Drawing canvas")).to_be_visible()
                review = page.request.get(url + f"api/reviews/{review_id}").json()
                same_camera(returned, review["pose"]["camera"])
                page.get_by_role("button", name="Back to model").click()
                wait(lambda current: current["activeReviewId"] is None)
                restored, restored_live = measured()
                same_camera(returned, restored)
                assert restored_live["canvasRetained"] and restored_live["contextRetained"] and restored_live["losses"] == 0
                page.reload()
                wait(lambda _: page.evaluate("() => !!window.cameraTest.store?.getState().camera"))
                expect(canvas).to_be_visible()
                restored, _ = measured()
                same_camera(returned, restored)
                command("set_explode", {"amount": 1, "direction": "z"})
                same_camera(restored, measured()[0])
                fitted = command("fit_view")
                assert fitted["fitNonce"] > fit_nonce
                assert fitted["rendered"]["inFrame"]
                assert fitted["rendered"]["camera"]["position"] != restored["position"]
                # Loading a model explicitly resets/refits even after a custom
                # zoomed pose; the server's demo keeps this fixture self-contained.
                old_revision = state()["revision"]
                command("load_demo")
                loaded = wait(lambda current: current["revision"] > old_revision and not current["loading"])
                assert loaded["fitNonce"] > fit_nonce
                assert measured()[0]["position"] != restored["position"]
                assert settled()["rendered"]["inFrame"]
                expect(page.get_by_role("alert")).to_have_count(0)
                cases.append({"projection": projection, "camera": camera, "sizes": sizes, "dprs": [2, 1.25, 1], "reviewId": review_id})
            assert not errors, errors
            report = {"cases": cases, "liveProjectionMeasured": True, "resizePreservesCamera": True, "freshResizeReports": True, "captureAndReload": True, "explicitFitAndLoad": True}
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
