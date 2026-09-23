import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import expect, sync_playwright

from browser_session import BrowserSession


FIXTURE_NAME = "section-fixture.step"


def _name(label, text):
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(text))


def _location(x=0, y=0, z=0):
    transform = gp_Trsf()
    transform.SetTranslationPart(gp_Vec(x, y, z))
    return TopLoc_Location(transform)


def create_fixture(path):
    document = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 0.001)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    root = shapes.NewShape()
    _name(root, "Section fixture")

    block = BRepPrimAPI_MakeBox(gp_Pnt(-12, -9, -6), gp_Pnt(12, 9, 6)).Shape()
    bore = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(-12, 0, 0), gp_Dir(1, 0, 0)), 3, 24).Shape()
    ring = shapes.AddShape(BRepAlgoAPI_Cut(block, bore).Shape(), False)
    _name(ring, "Through-hole block")
    colors.SetColor(ring, Quantity_Color(0.16, 0.44, 0.68, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    ring_occurrence = shapes.AddComponent(root, ring, TopLoc_Location())
    _name(ring_occurrence, "Through-hole block")

    bar_shape = BRepPrimAPI_MakeBox(gp_Pnt(-6, -3, -3), gp_Pnt(6, 3, 3)).Shape()
    bar = shapes.AddShape(bar_shape, False)
    _name(bar, "Repeated gap bar")
    colors.SetColor(bar, Quantity_Color(0.76, 0.34, 0.12, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    left = shapes.AddComponent(root, bar, _location(0, -3.25, 12))
    right = shapes.AddComponent(root, bar, _location(0, 3.25, 12))
    _name(left, "Gap bar left")
    _name(right, "Gap bar right")

    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    assert writer.Transfer(document)
    assert writer.Write(str(path)) == IFSelect_RetDone


def _image(canvas):
    data = canvas.evaluate("canvas => canvas.toDataURL('image/png')")
    return Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))).convert("RGB")


def _vector(values):
    length = math.sqrt(sum(value * value for value in values))
    return [value / length for value in values]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def project(world, model_center, camera, width, height):
    scene = [world[index] - model_center[index] for index in range(3)]
    forward = _vector([camera["target"][index] - camera["position"][index] for index in range(3)])
    right = _vector(_cross(forward, camera["up"]))
    up = _cross(right, forward)
    relative = [scene[index] - camera["target"][index] for index in range(3)]
    view_height = camera["viewHeight"]
    view_width = view_height * width / height
    return (
        round((0.5 + _dot(relative, right) / view_width) * width),
        round((0.5 - _dot(relative, up) / view_height) * height),
    )


def pixel(image, point, radius=2):
    x, y = point
    values = []
    for px in range(max(0, x - radius), min(image.width, x + radius + 1)):
        for py in range(max(0, y - radius), min(image.height, y + radius + 1)):
            values.append(image.getpixel((px, py)))
    return tuple(sum(value[channel] for value in values) / len(values) for channel in range(3))


def difference(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def run(url, output, fixture):
    output.mkdir(parents=True, exist_ok=True)
    source_before = hashlib.sha256(fixture.read_bytes()).hexdigest()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1120, "height": 820}, permissions=["clipboard-read", "clipboard-write"])
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)

            session = BrowserSession(page, url, errors)
            state, wait, settled, command = session.state, session.wait, session.settled, session.command

            wait(lambda current: not current["loading"] and current["documentRevision"], 120)
            current = settled()
            fixture_file = fixture.resolve().relative_to(Path(current["projectRoot"]).resolve()).as_posix()
            model = page.request.get(url + "api/model").json()
            assert current["documentRevision"] == source_before
            assert all(part["sectionCaps"] for part in model["parts"])
            repeated = [node for node in model["nodes"] if node["label"].startswith("Gap bar")]
            assert len(repeated) == 2 and repeated[0]["partId"] == repeated[1]["partId"]

            canvas = page.locator('canvas[aria-label="Interactive STEP assembly"]')
            canvas.evaluate("""canvas => {
                window.sectionCanvas = canvas;
                window.sectionContextLosses = 0;
                canvas.addEventListener('webglcontextlost', () => window.sectionContextLosses++);
            }""")
            command("set_view", {"preset": "right"})
            command("set_projection", {"projection": "orthographic"})
            command("fit_view")
            camera = settled()["rendered"]["camera"]
            geometry_ids = settled()["rendered"]["geometryIds"]
            baseline = _image(canvas)
            enabled = command("set_section", {"enabled": True, "axis": "x", "position": 0, "flipped": False})
            assert enabled["rendered"]["section"] == enabled["section"]
            assert enabled["rendered"]["camera"] == camera
            section_image = _image(canvas)
            section_image.save(output / "section.png")
            assert ImageChops.difference(baseline, section_image).getbbox()

            bounds = model["bounds"]
            model_center = [(bounds["min"][axis] + bounds["max"][axis]) / 2 for axis in range(3)]
            box = canvas.bounding_box()
            camera = enabled["rendered"]["camera"]
            points = {
                "ring": project([0, 5, 0], model_center, camera, box["width"], box["height"]),
                "hole": project([0, 0, 0], model_center, camera, box["width"], box["height"]),
                "gap": project([0, 0, 12], model_center, camera, box["width"], box["height"]),
                "bar": project([0, -2, 12], model_center, camera, box["width"], box["height"]),
                "background": project([0, 0, 20], model_center, camera, box["width"], box["height"]),
            }
            colors = {name: pixel(section_image, point) for name, point in points.items()}
            baseline_ring = pixel(baseline, points["ring"])
            stencil_bits = canvas.evaluate("canvas => canvas.getContext('webgl2').getParameter(canvas.getContext('webgl2').STENCIL_BITS)")
            assert stencil_bits >= 8, stencil_bits
            assert difference(colors["ring"], baseline_ring) > 25, {**colors, "baselineRing": baseline_ring, "stencilBits": stencil_bits}
            assert difference(colors["ring"], colors["background"]) > 45, colors
            assert difference(colors["bar"], colors["background"]) > 45, colors
            assert difference(colors["hole"], colors["background"]) < 30, colors
            assert difference(colors["gap"], colors["background"]) < 30, colors

            command("select_parts", {"ids": []})
            revision = state()["revision"]
            page.mouse.click(box["x"] + points["ring"][0], box["y"] + points["ring"][1])
            page.wait_for_timeout(200)
            assert state()["revision"] == revision
            assert state()["selectedIds"] == [], "A display-derived cap must block click-through without becoming a CAD selection"

            parts = {part["id"]: part for part in model["parts"]}
            ring_node = next(node for node in model["nodes"] if node["label"] == "Through-hole block" and node["partId"])
            hidden_camera = settled()["rendered"]["camera"]
            hidden = command("set_visibility", {"ids": [repeated[1]["id"]], "visible": False})
            assert hidden["rendered"]["visibleParts"] == len(repeated)
            assert hidden["rendered"]["camera"] == hidden_camera
            command("set_visibility", {"ids": [repeated[1]["id"]], "visible": True})
            isolated = command("isolate", {"id": ring_node["id"]})
            assert isolated["rendered"]["visibleParts"] == 1
            assert isolated["rendered"]["section"] == isolated["section"]
            command("show_all")
            crossing_edges = [
                edge for edge in parts[ring_node["partId"]]["edges"]
                if edge["bounds"]["min"][0] < -0.1 and edge["bounds"]["max"][0] > 0.1 and edge["curveType"] == "line"
            ]
            assert crossing_edges
            command("set_view", {"preset": "iso"})
            picked_edge = None
            reference = None
            for edge in crossing_edges:
                selected = command("select_edge", {
                    "id": ring_node["id"], "edgeId": edge["id"], "topologyRevision": model["topologyRevision"],
                })
                point = selected["rendered"]["selectedEdgeScreen"]
                if point is None:
                    continue
                expected_reference = selected["selectedReferences"][0]["reference"]
                command("select_parts", {"ids": []})
                before = state()["revision"]
                canvas.click(position={"x": point[0], "y": point[1]})
                page.wait_for_timeout(150)
                clicked = state()
                if clicked["revision"] > before and clicked["selectedEdge"] == {"nodeId": ring_node["id"], "edgeId": edge["id"]}:
                    picked_edge = edge
                    reference = settled()["selectedReferences"][0]["reference"]
                    assert reference == expected_reference
                    break
            assert picked_edge is not None, "A retained portion of a crossing native edge must remain pickable"

            section_camera = settled()["rendered"]["camera"]
            command("set_explode", {"amount": 0, "direction": "x"})
            assembled_max = settled()["rendered"]["bounds"]["max"][0]
            explode_slider = page.get_by_role("slider", name="Explode amount")
            explode_slider.evaluate("""element => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '100');
                element.dispatchEvent(new Event('input', {bubbles: true}));
            }""")
            expect(page.locator(".explode-panel output")).to_have_text("100%")
            assert state()["explode"] == 0, "Regression requires a client explosion preview ahead of committed state"
            page.get_by_role("button", name="Section view", exact=True).click()
            expect(page.get_by_role("dialog", name="Section view settings")).to_be_visible()
            section_slider = page.get_by_role("slider", name="Section plane position")
            number_input = page.get_by_label("Section position in model-world millimeters")
            preview_min = float(section_slider.get_attribute("min"))
            preview_max = float(section_slider.get_attribute("max"))
            assert preview_max > assembled_max
            assert math.isclose(float(number_input.get_attribute("min")), preview_min, abs_tol=1e-9)
            assert math.isclose(float(number_input.get_attribute("max")), preview_max, abs_tol=1e-9)
            number_input.fill(str(preview_max))
            number_input.press("Tab")
            target_position = preview_max
            reached = wait(lambda current: current["explode"] == 1 and math.isclose(current["section"]["position"], target_position, abs_tol=1e-6))
            assert math.isclose(reached["rendered"]["bounds"]["max"][0], preview_max, abs_tol=1e-6)
            assert reached["rendered"]["camera"] == section_camera
            page.get_by_role("button", name="Close section view settings").click()
            reassembled = command("reset_view")
            assert math.isclose(reassembled["section"]["position"], reassembled["rendered"]["bounds"]["max"][0], abs_tol=1e-6)
            assert reassembled["rendered"]["camera"] == section_camera
            command("set_section", {"axis": "x", "position": 0})

            exploded = command("set_explode", {"amount": 0.35, "direction": "z"})
            assert exploded["rendered"]["camera"] == section_camera
            assert exploded["rendered"]["section"] == exploded["section"]
            command("set_explode", {"amount": 0})
            command("set_appearance", {"mode": "studio"})
            assert settled()["rendered"]["section"]["enabled"]
            command("set_view", {"preset": "right"})
            command("set_projection", {"projection": "orthographic"})
            command("fit_view")
            studio_camera = settled()["rendered"]["camera"]
            studio_image = _image(canvas)
            studio_points = {
                name: project(world, model_center, studio_camera, box["width"], box["height"])
                for name, world in {
                    "ring": [0, 5, 0], "hole": [0, 0, 0], "gap": [0, 0, 12], "background": [0, 0, 20],
                }.items()
            }
            studio_colors = {name: pixel(studio_image, point) for name, point in studio_points.items()}
            assert difference(studio_colors["ring"], studio_colors["background"]) > 35, studio_colors
            assert difference(studio_colors["hole"], studio_colors["background"]) < 35, studio_colors
            assert difference(studio_colors["gap"], studio_colors["background"]) < 35, studio_colors
            command("set_appearance", {"mode": "inspect"})
            assert canvas.evaluate("canvas => canvas === window.sectionCanvas")
            assert page.evaluate("window.sectionContextLosses") == 0
            assert settled()["rendered"]["geometryIds"] == geometry_ids

            page.reload()
            restored = settled()
            restored = command("fit_view")
            canvas.evaluate("""canvas => {
                window.sectionCanvas = canvas;
                window.sectionContextLosses = 0;
                canvas.addEventListener('webglcontextlost', () => window.sectionContextLosses++);
            }""")
            geometry_ids = restored["rendered"]["geometryIds"]
            assert restored["section"] == {"enabled": True, "axis": "x", "position": 0, "flipped": False}
            assert restored["rendered"]["section"] == restored["section"]

            command("set_view", {"preset": "right"})
            command("set_projection", {"projection": "orthographic"})
            command("fit_view")
            command("select_parts", {"ids": []})
            flip = command("set_section", {"flipped": True})
            flipped_image = _image(canvas)
            command("set_section", {"enabled": False})
            restored_image = _image(canvas)
            restored_difference = ImageStat.Stat(ImageChops.difference(baseline, restored_image)).mean
            assert max(restored_difference) < 0.4, {
                "difference": restored_difference,
                "baselineCamera": camera,
                "restoredCamera": settled()["rendered"]["camera"],
                "showEdges": state()["showEdges"],
            }
            assert ImageChops.difference(section_image, flipped_image).getbbox()

            unchanged = command("select_edge", {
                "id": ring_node["id"], "edgeId": picked_edge["id"], "topologyRevision": model["topologyRevision"],
            })
            assert unchanged["selectedReferences"][0]["reference"] == reference

            command("set_section", {"enabled": True, "axis": "x", "position": 0, "flipped": False})
            capture_response = page.request.post(url + "api/capture")
            assert capture_response.ok, capture_response.text()
            capture = capture_response.json()
            capture_metadata = json.loads(Path(str(capture["path"]) + ".json").read_text(encoding="utf-8"))
            assert capture_metadata["section"] == state()["section"]

            captured_pixels = _image(canvas)
            page.get_by_role("button", name="Draw", exact=True).click()
            review_state = wait(lambda current: current["activeReviewId"] is not None)
            review = page.request.get(url + "api/reviews/" + review_state["activeReviewId"]).json()
            assert review["pose"]["section"] == {"enabled": True, "axis": "x", "position": 0, "flipped": False}
            review_image = Image.open(io.BytesIO(base64.b64decode(review["image"]["dataUrl"].split(",", 1)[1]))).convert("RGB")
            assert max(ImageStat.Stat(ImageChops.difference(captured_pixels, review_image)).mean) < 0.2
            page.get_by_role("button", name="Back to model", exact=True).click()
            wait(lambda current: current["activeReviewId"] is None)
            command("set_section", {"position": -3, "flipped": True})
            saved_review = page.request.get(url + "api/reviews/" + review["id"]).json()
            assert saved_review["pose"]["section"]["position"] == 0
            assert saved_review["pose"]["section"]["flipped"] is False

            page.get_by_role("button", name="Section view", exact=True).click()
            expect(page.get_by_role("dialog", name="Section view settings")).to_be_visible()
            expect(page.get_by_text("displayed pose", exact=False)).to_be_visible()
            page.set_viewport_size({"width": 390, "height": 500})
            page.wait_for_timeout(100)
            popover = page.get_by_role("dialog", name="Section view settings").bounding_box()
            bottom = page.locator(".bottom-bar").bounding_box()
            assert popover["y"] + popover["height"] <= bottom["y"] + 1
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert canvas.evaluate("canvas => canvas === window.sectionCanvas")
            assert page.evaluate("window.sectionContextLosses") == 0
            assert settled()["rendered"]["geometryIds"] == geometry_ids

            reset = command("load_file", {"file": fixture_file})
            assert reset["section"]["enabled"] is False
            assert reset["section"]["axis"] == "x"
            assert math.isclose(reset["section"]["position"], (model["bounds"]["min"][0] + model["bounds"]["max"][0]) / 2, abs_tol=1e-9)
            assert hashlib.sha256(fixture.read_bytes()).hexdigest() == source_before
            assert not errors, errors
            print(json.dumps({
                "sourceHash": source_before,
                "capPreservesHole": True,
                "capPreservesHalfMillimeterGap": True,
                "capBlocksClickThrough": True,
                "partiallyClippedEdgeReference": reference,
                "persistence": True,
                "capturePath": capture["path"],
                "reviewId": review["id"],
            }))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--url")
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--fixtures-only", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    fixture = args.fixture or args.output / FIXTURE_NAME
    if args.fixtures_only:
        create_fixture(fixture)
    else:
        run(args.url, args.output, fixture)
