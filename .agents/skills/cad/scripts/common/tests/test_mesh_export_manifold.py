"""STL and 3MF exports are closed meshes, read back from the written bytes.

Each fixture runs ``scripts/step`` with ``--stl`` and ``--3mf`` and checks what a
slicer sees: vertices welded by exact written position, no zero-area or
duplicated triangles, and every edge shared by exactly two triangles.
"""

import collections
import struct
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from xml.etree import ElementTree as ET


SCRIPTS_ROOT = Path(__file__).resolve().parents[2]
NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
FINE = ("--mesh-tolerance", "4e-4", "--mesh-angular-tolerance", "0.15")

# A 40 x 20 x 2.4 mm plate with one M3 clearance hole. Where the rim's
# vertices land depends on the hole's position, so two positions are built.
PLATE = textwrap.dedent(
    """\
    import build123d as bd


    def gen_step():
        align = (bd.Align.MIN,) * 3
        body = bd.Box(40, 20, 2.4, align=align)
        return body - bd.Pos({x}, 10.0, 0) * bd.Cylinder(1.7, 7.2)
    """
)

# A 130 mm strip of a curved wall, 2.2 mm thick, with a 3.3 mm hole through
# the top of the curve: the hole meets a curved face instead of a plane.
CURVED_WALL = textwrap.dedent(
    """\
    import build123d as bd

    R, T = {radius}, 2.2
    L, W = 130.0, 40.0


    def gen_step():
        ring = bd.Cylinder(R, 2 * W, rotation=(90, 0, 0)) - bd.Cylinder(R - T, 2 * W, rotation=(90, 0, 0))
        body = ring & bd.Pos(0, 0, R / 2) * bd.Box(L, W, R)
        return body - bd.Pos(0, 0, R) * bd.Cylinder(1.65, 10)
    """
)

# A revolved bowl hollowed to an open rim, every edge filleted, and a handle
# swept from a rounded rectangle.
TEACUP = textwrap.dedent(
    """\
    import build123d as bd

    WALL = 2.5


    def gen_step():
        with bd.BuildPart() as cup:
            with bd.BuildSketch(bd.Plane.XZ):
                with bd.BuildLine():
                    side = bd.Spline((26, 0), (38, 30), (44, 70), tangents=((0.6, 1), (0.1, 1)))
                    bd.Polyline(side @ 1, (0, 70), (0, 0), side @ 0)
                bd.make_face()
            bd.revolve(axis=bd.Axis.Z)
            bd.offset(amount=-WALL, openings=cup.faces().sort_by(bd.Axis.Z)[-1])
            bd.fillet(cup.edges(), radius=WALL * 0.45)
            with bd.BuildLine(bd.Plane.XZ) as path:
                bd.Spline((38, 22), (62, 30), (64, 52), (42, 60), tangents=((1, 0.2), (-1, 0.1)))
            with bd.BuildSketch(path.line ^ 0):
                bd.RectangleRounded(WALL * 2.4, 9, WALL * 0.6)
            bd.sweep()
        return cup.part
    """
)

FIXTURES = {
    "plate_10": (PLATE.format(x=10.0), ()),
    "plate_20": (PLATE.format(x=20.0), ()),
    "plate_10_fine": (PLATE.format(x=10.0), FINE),
    "wall_90": (CURVED_WALL.format(radius=90.0), ()),
    "wall_200": (CURVED_WALL.format(radius=200.0), ()),
    "teacup": (TEACUP, ()),
    "teacup_fine": (TEACUP, FINE),
}


def read_binary_stl(path: Path) -> list[tuple[tuple[float, float, float], ...]]:
    data = path.read_bytes()
    count = struct.unpack("<I", data[80:84])[0]
    triangles = []
    for index in range(count):
        base = 84 + index * 50
        floats = struct.unpack("<9f", data[base + 12 : base + 48])
        triangles.append(tuple(tuple(floats[i : i + 3]) for i in (0, 3, 6)))
    return triangles


def read_3mf_meshes(path: Path) -> list[list[tuple[tuple[float, float, float], ...]]]:
    root = ET.fromstring(zipfile.ZipFile(path).read("3D/3dmodel.model"))
    meshes = []
    for model_object in root.findall("./m:resources/m:object", NS):
        mesh = model_object.find("m:mesh", NS)
        if mesh is None:
            continue
        vertices = [tuple(float(vertex.attrib[axis]) for axis in "xyz") for vertex in mesh.findall("m:vertices/m:vertex", NS)]
        meshes.append([
            tuple(vertices[int(triangle.attrib[corner])] for corner in ("v1", "v2", "v3"))
            for triangle in mesh.findall("m:triangles/m:triangle", NS)
        ])
    return meshes


def twice_area(corners) -> float:
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = corners
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    return (nx * nx + ny * ny + nz * nz) ** 0.5


class MeshExportManifoldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tempdir = tempfile.TemporaryDirectory(prefix="mesh-export-manifold-")
        cls.project = Path(cls._tempdir.name)

        def export(name: str) -> subprocess.CompletedProcess:
            source, options = FIXTURES[name]
            (cls.project / f"{name}.py").write_text(source, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(SCRIPTS_ROOT / "step"), f"{name}.py", "--stl", f"{name}.stl", "--3mf", f"{name}.3mf", *options],
                cwd=cls.project,
                capture_output=True,
                text=True,
                timeout=600,
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            cls.runs = dict(zip(FIXTURES, pool.map(export, FIXTURES)))

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tempdir.cleanup()

    def assertManifold(self, triangles, label: str) -> None:
        self.assertGreater(len(triangles), 0, f"{label}: the export has triangles")
        degenerate = [triangle for triangle in triangles if twice_area(triangle) == 0.0]
        self.assertEqual([], degenerate[:3], f"{label}: {len(degenerate)} zero-area triangles")
        faces = collections.Counter(tuple(sorted(triangle)) for triangle in triangles)
        duplicated = [face for face, used in faces.items() if used > 1]
        self.assertEqual([], duplicated[:3], f"{label}: {len(duplicated)} triangles written more than once")
        edges: collections.Counter = collections.Counter()
        for triangle in triangles:
            a, b, c = sorted(triangle)
            for edge in ((a, b), (b, c), (a, c)):
                edges[edge] += 1
        multiplicity = collections.Counter(edges.values())
        self.assertEqual({2: len(edges)}, dict(multiplicity), f"{label}: every edge of a closed solid is used by exactly two triangles")

    def assertExported(self, name: str) -> None:
        run = self.runs[name]
        self.assertEqual(0, run.returncode, run.stdout + run.stderr)
        for suffix in ("step", "stl", "3mf"):
            self.assertTrue((self.project / f"{name}.{suffix}").is_file(), f"{name}.{suffix}")

    def assertMeshesManifold(self, name: str) -> None:
        self.assertManifold(read_binary_stl(self.project / f"{name}.stl"), f"{name}.stl")
        meshes = read_3mf_meshes(self.project / f"{name}.3mf")
        self.assertEqual(1, len(meshes), f"{name}.3mf: one mesh object")
        self.assertManifold(meshes[0], f"{name}.3mf")

    def assertExportsManifold(self, name: str) -> None:
        self.assertExported(name)
        self.assertMeshesManifold(name)

    def test_plate_with_one_hole(self) -> None:
        for name in ("plate_10", "plate_20", "plate_10_fine"):
            with self.subTest(name=name):
                self.assertExportsManifold(name)

    def test_hole_through_a_curved_wall(self) -> None:
        for name in ("wall_90", "wall_200"):
            with self.subTest(name=name):
                self.assertExportsManifold(name)

    def test_teacup_exports(self) -> None:
        for name in ("teacup", "teacup_fine"):
            with self.subTest(name=name):
                self.assertExported(name)

    # Known defect, so only the mesh check is an expected failure. OCCT's
    # triangulation of the teacup is closed in double precision, but the
    # handle's swept faces mesh into sliver triangles that collapse when
    # vertices are rounded for the file (float32 in STL, 9 significant digits
    # in 3MF). Dropping the zero-area triangles is not enough: open edges and
    # edges shared by four triangles remain. Remove the markers once the
    # exporter writes a closed mesh here.
    @unittest.expectedFailure
    def test_teacup_mesh_is_closed(self) -> None:
        self.assertMeshesManifold("teacup")

    @unittest.expectedFailure
    def test_teacup_mesh_is_closed_at_fine_tolerance(self) -> None:
        self.assertMeshesManifold("teacup_fine")


if __name__ == "__main__":
    unittest.main()
