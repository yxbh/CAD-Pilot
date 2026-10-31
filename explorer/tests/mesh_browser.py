"""Mesh files in a real browser: a faulty scan-like mesh beside the demo STEP, faults, point picking and section.

The scan is generated here (a noisy torus with a hole, a duplicated triangle, a flipped patch and a zero-area
triangle), never third-party geometry. It is written into the evidence folder, which is inside the workbench.
"""

import argparse
import json
from pathlib import Path
import time

import numpy as np
from playwright.sync_api import sync_playwright
import trimesh

from browser_session import BrowserSession, launch_chromium

WORKBENCH = Path(__file__).resolve().parents[2]


def make_scan(path: Path) -> int:
    torus = trimesh.creation.torus(60, 20, major_sections=500, minor_sections=300)
    vertices = torus.vertices + np.random.default_rng(1).normal(0, 0.05, torus.vertices.shape)
    faces = torus.faces.copy()
    centres = vertices[faces].mean(axis=1)
    faces = faces[~((centres[:, 0] > 70) & (np.abs(centres[:, 1]) < 8) & (centres[:, 2] > 10))]
    centres = vertices[faces].mean(axis=1)
    patch = (centres[:, 1] > 70) & (np.abs(centres[:, 0]) < 5)
    faces[patch] = faces[patch][:, ::-1]
    faces = np.vstack([faces, faces[:1], [[faces[2, 0], faces[2, 0], faces[2, 1]]]])
    trimesh.Trimesh(vertices, faces, process=False).export(path)
    return len(faces)


def run(url, output):
    scan = Path(output) / "scan.stl"
    triangles = make_scan(scan)
    relative = scan.relative_to(WORKBENCH).as_posix()
    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 800})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            session = BrowserSession(page, url, errors)
            session.settled()

            session.command("add_file", {"file": relative})
            beside = session.settled()
            ghosts = beside["rendered"]["ghostParts"]
            session.command("set_layout", {"mode": "side"})
            page.screenshot(path=str(Path(output) / "beside.png"))

            # The scan alone: time from command to the first frame drawn with it. Added files outlast a new main file.
            session.command("remove_file", {"id": "ref1"})
            started = time.monotonic()
            response = page.request.post(url + "api/command", data={"name": "load_file", "input": {"file": relative}})
            assert response.ok, response.text()
            alone = session.wait(lambda state: state.get("rendered") and state["rendered"]["revision"] == state["revision"]
                                 and state["rendered"]["meshTriangles"] > 0, timeout=120)
            load_seconds = time.monotonic() - started
            model = page.request.get(url + "api/model").json()
            faults = model["parts"][0]["faults"]
            shown = session.command("set_faults", {"visible": True})["rendered"]["faultMarks"]

            # Pick a point on the ring from straight above: the tube's centreline is 60 of the 80 mm radius.
            session.command("set_view", {"preset": "top"})
            # Picking goes through the tree the worker built, whose triangle numbers must still be the file's own.
            deadline = time.monotonic() + 60
            while not session.command("set_selection_mode", {"mode": "part"})["rendered"]["pickingTrees"]:
                assert time.monotonic() < deadline, "No picking tree arrived from the worker"
                page.wait_for_timeout(200)
            state = session.command("set_selection_mode", {"mode": "point"})
            low, high = state["rendered"]["projectedBounds"]["min"], state["rendered"]["projectedBounds"]["max"]
            canvas = page.locator("canvas[aria-label='Interactive model']").bounding_box()
            x = (low[0] + (high[0] - low[0]) * 0.875 + 1) / 2 * canvas["width"]
            y = (1 - ((low[1] + high[1]) / 2)) / 2 * canvas["height"]
            page.mouse.click(canvas["x"] + x, canvas["y"] + y)
            picked = session.wait(lambda current: current["selectedPoint"] is not None and current["rendered"]["revision"] == current["revision"])
            reference = picked["selectedReferences"][0]["reference"]
            inspected = page.request.post(url + "api/command", data={"name": "inspect_reference", "input": {"reference": reference}}).json()

            section = session.command("set_section", {"enabled": True, "axis": "x", "position": 0})
            session.command("set_view", {"preset": "right"})
            page.screenshot(path=str(Path(output) / "section.png"))
            report = {
                "triangles": triangles, "ghosts": ghosts, "beside": beside["modelName"],
                "aloneTriangles": alone["rendered"]["meshTriangles"], "loadSeconds": round(load_seconds, 2),
                "faults": faults, "faultMarks": shown,
                "point": picked["selectedPoint"], "pointScreen": picked["rendered"]["selectedPointScreen"], "clicked": [x, y],
                "inspectedDistance": inspected["point"]["distanceToTriangle"], "inspectedWorldZ": inspected["point"]["world"][2],
                "section": section["rendered"]["section"], "outlineSegments": section["rendered"]["sectionOutlineSegments"], "pageErrors": errors,
            }
            (Path(output) / "mesh-browser.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(args.url, args.output)
