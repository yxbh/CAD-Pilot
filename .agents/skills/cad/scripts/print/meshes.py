"""Print meshes: a STEP or STL part as triangles, turned into its print orientation and set on the bed."""

from __future__ import annotations

import sys
import zipfile
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import numpy as np

from common.cache import cache_path, prune, sha256_file, touch
from common.step_scene import load_step_scene, mesh_step_scene, scene_leaf_occurrences, scene_occurrence_shape
from common.threemf import shape_mesh


# Chord and angle limits for meshing STEP faces: well inside a 0.4 mm nozzle's line, so curved fits
# and holes keep their size in the slicer.
LINEAR_DEFLECTION_MM = 0.01
ANGULAR_DEFLECTION_RAD = 0.1
STEP_SUFFIXES = {".step", ".stp"}
MESH_SUFFIXES = {".stl"}
# Checked STEP meshes are kept in the cad tools' user cache, named by the STEP's contents and the
# meshing limits. Bump the version when meshing or the checks a kept mesh has passed change.
MESH_CACHE = "print-meshes"
MESH_CACHE_VERSION = 1


class MeshError(ValueError):
    pass


def _workbench_python() -> Path | None:
    """The interpreter of the workbench holding this skill (<workbench>/.agents/skills/cad/scripts/print)."""
    venv = Path(__file__).resolve().parents[5] / ".venv"
    return next((python for python in (venv / "bin" / "python", venv / "Scripts" / "python.exe") if python.is_file()), None)


def trimesh_module():
    """trimesh and its graph functions, which the workbench's environment has and a design project's own
    environment may not: imported only when a part is meshed, so the other print commands run without it."""
    try:
        import trimesh
        import trimesh.graph
    except ModuleNotFoundError as error:
        workbench = _workbench_python()
        raise MeshError(
            f"scripts/print needs {error.name or 'trimesh'}, which {sys.executable} cannot import; run it with the "
            f"workbench's Python interpreter{f' ({workbench})' if workbench else ''}"
        ) from None
    return trimesh


@dataclass(frozen=True, eq=False)
class PrintMesh:
    """A closed triangle mesh in millimetres; ``vertices`` (n, 3) and ``faces`` (m, 3). A turned mesh
    keeps the turn and offset from its model coordinates: print = rotation @ model + offset.
    ``bodies`` counts its separate solids: closed shells that hold material, not voids inside them."""

    vertices: np.ndarray
    faces: np.ndarray
    rotation: np.ndarray = field(default_factory=lambda: np.eye(3))
    offset: np.ndarray = field(default_factory=lambda: np.zeros(3))
    bodies: int = 1

    def model_point(self, point) -> np.ndarray:
        """A point of this mesh in the coordinates of the model it was turned from."""
        return self.rotation.T @ (np.asarray(point, dtype=float) - self.offset)

    @cached_property
    def triangles(self) -> np.ndarray:
        return self.vertices[self.faces]

    @cached_property
    def normals(self) -> np.ndarray:
        tri = self.triangles
        cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        length = np.linalg.norm(cross, axis=1)
        return cross / np.where(length > 0, length, 1.0)[:, None]

    @cached_property
    def areas(self) -> np.ndarray:
        tri = self.triangles
        return 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)

    @property
    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        return self.vertices.min(axis=0), self.vertices.max(axis=0)

    @property
    def size(self) -> np.ndarray:
        low, high = self.bounds
        return high - low

    def oriented(self, rotate_xyz: tuple[float, float, float]) -> "PrintMesh":
        """Turned about the fixed X, then Y, then Z axes by these degrees, and moved so its lowest
        point sits on the bed and its footprint starts at the origin."""
        rx, ry, rz = np.radians(rotate_xyz)
        cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
        x = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
        y = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
        z = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
        # Rounding keeps quarter turns exact, so a face turned onto the bed stays flat.
        turn = np.round(z @ y @ x, 12)
        turned = self.vertices @ turn.T
        low = turned.min(axis=0)
        return PrintMesh(turned - low, self.faces, turn @ self.rotation, turn @ self.offset - low, self.bodies)


def _closed(vertices, faces, source: str):
    trimesh = trimesh_module()
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float), faces=np.asarray(faces, dtype=np.int64), process=True)
    if len(mesh.faces) == 0:
        raise MeshError(f"{source} holds no triangles")
    if not mesh.is_watertight:
        raise MeshError(f"{source} is not a closed solid: its mesh has open or non-manifold edges; repair it before printing")
    if not mesh.is_winding_consistent:
        # Each edge of a consistently wound closed mesh runs once each way; a flipped triangle runs its edges
        # the same way as its neighbours do, so its outside faces into the part.
        _, counts = np.unique(mesh.edges, axis=0, return_counts=True)
        raise MeshError(
            f"{source} is not a closed solid: some triangles face inwards ({int((counts > 1).sum())} edges join "
            "triangles wound opposite ways); repair it before printing"
        )
    if mesh.volume < 0:
        mesh.invert()
    return mesh


def _solids(mesh) -> int:
    """The separate solids in a closed mesh: its connected shells that enclose material (a positive
    signed volume), not the inward-facing shells of voids inside them."""
    groups = trimesh_module().graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(mesh.faces)), min_len=1)
    tri = np.asarray(mesh.triangles)
    signed = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])) / 6.0
    return max(1, sum(1 for group in groups if signed[np.asarray(group)].sum() > 0))


def _joined(bodies: list) -> PrintMesh:
    """Bodies as one print object, each kept closed on its own: touching bodies share no vertices."""
    offsets = np.cumsum([0] + [len(body.vertices) for body in bodies[:-1]])
    vertices = np.concatenate([np.asarray(body.vertices, dtype=float) for body in bodies])
    faces = np.concatenate([np.asarray(body.faces, dtype=np.int64) + offset for body, offset in zip(bodies, offsets)])
    return PrintMesh(vertices, faces, bodies=sum(_solids(body) for body in bodies))


def load_mesh(path: Path) -> PrintMesh:
    """A STEP file's solids (every occurrence, placed as in the file) or an STL's triangles, in mm.
    Several bodies print as one object, as the file places them."""
    suffix = path.suffix.lower()
    if not path.is_file():
        raise MeshError(f"Part file not found: {path}")
    if suffix in STEP_SUFFIXES:
        return _cached_step_mesh(path)
    if suffix in MESH_SUFFIXES:
        loaded = trimesh_module().load_mesh(path, force="mesh", process=False)
        return _joined([_closed(loaded.vertices, loaded.faces, str(path))])
    raise MeshError(f"Part files must be STEP, STP or STL, not {path.name}")


def _step_mesh(path: Path) -> PrintMesh:
    try:
        scene = load_step_scene(path)
    except RuntimeError as error:
        # The reader's own message ends in the path again.
        raise MeshError(f"{path} could not be read as STEP ({str(error).split(':', 1)[0]})") from None
    mesh_step_scene(scene, linear_deflection=LINEAR_DEFLECTION_MM, angular_deflection=ANGULAR_DEFLECTION_RAD, relative=False)
    bodies = []
    for leaf in scene_leaf_occurrences(scene):
        vertices, faces = shape_mesh(scene_occurrence_shape(scene, leaf))
        bodies.append(_closed(vertices, faces, f"{path} body {leaf.name or len(bodies) + 1}"))
    if not bodies:
        raise MeshError(f"{path} holds no solids")
    return _joined(bodies)


def _cached_step_mesh(path: Path) -> PrintMesh:
    """A STEP's checked print mesh, from the user cache when this exact file was meshed before, so
    comparing orientations of one part meshes it once."""
    from common.atomic_replace import replacing

    name = f"{sha256_file(path.resolve())}.{LINEAR_DEFLECTION_MM:g}-{ANGULAR_DEFLECTION_RAD:g}.v{MESH_CACHE_VERSION}.npz"
    cached = cache_path(MESH_CACHE, name)
    try:
        with np.load(cached, allow_pickle=False) as stored:
            mesh = PrintMesh(stored["vertices"], stored["faces"].astype(np.int64), bodies=int(stored["bodies"]))
        touch(cached)
        return mesh
    except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
        pass
    mesh = _step_mesh(path)
    try:
        with replacing(cached) as temp, open(temp, "wb") as handle:
            np.savez(handle, vertices=mesh.vertices, faces=mesh.faces.astype(np.int32), bodies=np.array(mesh.bodies))
    except OSError:
        pass  # a cache that cannot be written only costs the next run its meshing
    prune(MESH_CACHE, keep=cached)
    return mesh
