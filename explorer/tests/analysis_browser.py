"""Analysis views in a real browser: the demo STEP and a generated mesh with each colour map and overlay, the legend,
and the page's own Analysis panel.

The mesh is generated here (a 2 mm plate beside a 10 mm ball), never third-party geometry. It is written into the
evidence folder, which is inside the workbench.
"""

import argparse
import json
from pathlib import Path

import trimesh

from browser_session import BrowserSession, launch_chromium, sync_playwright

WORKBENCH = Path(__file__).resolve().parents[2]


def make_mesh(path: Path) -> int:
    plate = trimesh.creation.box((40, 30, 2))
    plate = plate.subdivide().subdivide()
    ball = trimesh.creation.icosphere(subdivisions=3, radius=10)
    ball.apply_translation((0, 0, 20))
    mesh = trimesh.util.concatenate([plate, ball])
    mesh.export(path)
    return len(mesh.faces)


def run(url, output):
    path = Path(output) / "plate-and-ball.stl"
    triangles = make_mesh(path)
    relative = path.relative_to(WORKBENCH).as_posix()
    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 760})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            # three.js reports a shader that fails to compile on the console.
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.goto(url)
            session = BrowserSession(page, url, errors)
            parts = len(session.settled()["parts"])
            legend = page.locator("canvas.analysis-legend")

            # The demo STEP with every overlay over its overhang map.
            step = session.command("set_analysis", {"map": "overhang", "triangleEdges": True, "backfaces": True, "normals": True})["rendered"]
            step_legend = legend.get_attribute("aria-label")
            page.screenshot(path=str(Path(output) / "step-overhang.png"))
            step_thickness = session.command("set_analysis", {"map": "thickness", "minimumWall": 3, "triangleEdges": False, "backfaces": False, "normals": False})["rendered"]
            page.screenshot(path=str(Path(output) / "step-thickness.png"))

            # The generated mesh: its triangle edges, wall thickness and curvature.
            session.command("load_file", {"file": relative})
            edges = session.command("set_analysis", {"map": "none", "triangleEdges": True})["rendered"]
            mesh_thickness = session.command("set_analysis", {"map": "thickness", "minimumWall": 1, "triangleEdges": False})["rendered"]
            page.screenshot(path=str(Path(output) / "mesh-thickness.png"))
            curvature = session.command("set_analysis", {"map": "curvature"})["rendered"]
            curvature_legend = legend.get_attribute("aria-label")
            page.screenshot(path=str(Path(output) / "mesh-curvature.png"))

            # The page's own panel chooses a map.
            page.get_by_role("button", name="Analysis views", exact=False).click()
            page.get_by_label("Colour map").select_option("zebra")
            zebra = session.wait(lambda state: state["analysis"]["map"] == "zebra" and state["rendered"]["revision"] == state["revision"])
            page.screenshot(path=str(Path(output) / "mesh-zebra.png"))
            report = {
                "parts": parts, "triangles": triangles, "pageErrors": errors,
                "step": {key: step[key] for key in ("analysisSurfaces", "triangleEdgeSegments", "normalArrows", "analysisKey")},
                "stepLegend": step_legend, "stepThinnest": step_thickness["analysisStats"].get("thinnest"),
                "meshEdges": edges["triangleEdgeSegments"], "meshThinnest": mesh_thickness["analysisStats"].get("thinnest"),
                "curvatureScale": curvature["analysisStats"].get("curvatureScale"), "curvatureLegend": curvature_legend,
                "zebraSurfaces": zebra["rendered"]["analysisSurfaces"],
            }
            (Path(output) / "analysis-browser.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(args.url, args.output)
