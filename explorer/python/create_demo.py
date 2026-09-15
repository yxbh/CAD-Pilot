"""Generate a self-contained colored STEP assembly for prototype testing.

This is a synthetic visual fixture, not a manufactured or printable product.
Geometry is in mm, with a centered XY footprint and positive Z height.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.Standard import Standard_Failure
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Pnt, gp_Trsf, gp_Vec

BASE_WIDTH = 100.0
BASE_DEPTH = 65.0
BASE_THICKNESS = 4.0
SPACER_HEIGHT = 27.0
SPACER_RADIUS = 4.0
COVER_WIDTH = 90.0
COVER_DEPTH = 55.0
COVER_THICKNESS = 4.0
SPACER_CENTERS = ((-38.0, -21.0), (38.0, -21.0), (-38.0, 21.0), (38.0, 21.0))


def _name(label, text: str) -> None:
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(text))


def _location(x: float, y: float, z: float) -> TopLoc_Location:
    transform = gp_Trsf()
    transform.SetTranslation(gp_Vec(x, y, z))
    return TopLoc_Location(transform)


def create_demo(output: str | Path) -> None:
    output = Path(output)
    if output.suffix.lower() not in {".step", ".stp"}:
        raise ValueError("Demo output must have a .step or .stp extension.")
    document = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 0.001)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    root = shapes.NewShape()
    _name(root, "Raised cover demo")

    def part(shape, name, color):
        if not BRepCheck_Analyzer(shape).IsValid():
            raise RuntimeError(f"Invalid demo geometry: {name}")
        label = shapes.AddShape(shape, False)
        _name(label, name)
        colors.SetColor(label, Quantity_Color(*color, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
        return label

    base = part(
        BRepPrimAPI_MakeBox(gp_Pnt(-BASE_WIDTH / 2, -BASE_DEPTH / 2, 0),
                           BASE_WIDTH, BASE_DEPTH, BASE_THICKNESS).Shape(),
        "Base plate", (0.12, 0.32, 0.65),
    )
    spacer = part(
        BRepPrimAPI_MakeCylinder(SPACER_RADIUS, SPACER_HEIGHT).Shape(),
        "Spacer", (0.85, 0.46, 0.08),
    )
    cover = part(
        BRepPrimAPI_MakeBox(gp_Pnt(-COVER_WIDTH / 2, -COVER_DEPTH / 2, 0),
                           COVER_WIDTH, COVER_DEPTH, COVER_THICKNESS).Shape(),
        "Cover plate", (0.18, 0.62, 0.39),
    )
    _name(shapes.AddComponent(root, base, _location(0, 0, 0)), "Base plate")
    supports = shapes.NewShape()
    _name(supports, "Four spacers")
    for index, (x, y) in enumerate(SPACER_CENTERS, 1):
        _name(shapes.AddComponent(supports, spacer, _location(x, y, 0)), f"Spacer {index}")
    _name(shapes.AddComponent(root, supports, _location(0, 0, BASE_THICKNESS)), "Four spacers")
    _name(shapes.AddComponent(root, cover, _location(0, 0, BASE_THICKNESS + SPACER_HEIGHT)),
          "Cover plate")
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(document):
        raise RuntimeError("Native demo STEP transfer failed.")
    output.parent.mkdir(parents=True, exist_ok=True)
    if writer.Write(str(output)) != IFSelect_RetDone:
        raise OSError(f"Native demo STEP write failed: {output}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        create_demo(args.output)
    except (OSError, RuntimeError, ValueError, Standard_Failure) as error:
        print(f"Demo generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
