"""Print meshes: a STEP or STL part as triangles, turned into its print orientation and set on the bed."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import numpy as np
import trimesh

from common.step_scene import load_step_scene, mesh_step_scene, scene_leaf_occurrences, scene_occurrence_shape
from common.threemf import shape_mesh


# Chord and angle limits for meshing STEP faces: well inside a 0.4 mm nozzle's line, so curved fits
# and holes keep their size in the slicer.
LINEAR_DEFLECTION_MM = 0.01
ANGULAR_DEFLECTION_RAD = 0.1
STEP_SUFFIXES = {".step", ".stp"}
MESH_SUFFIXES = {".stl"}


class MeshError(ValueError):
    pass


@dataclass(frozen=True, eq=False)
class PrintMesh:
    """A closed triangle mesh in millimetres; ``vertices`` (n, 3) and ``faces`` (m, 3). A turned mesh
    keeps the turn and offset from its model coordinates: print = rotation @ model + offset."""

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


def _closed(vertices, faces, source: str) -> trimesh.Trimesh:
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float), faces=np.asarray(faces, dtype=np.int64), process=True)
    if len(mesh.faces) == 0:
        raise MeshError(f"{source} holds no triangles")
    if not mesh.is_watertight:
        raise MeshError(f"{source} is not a closed solid: its mesh has open or non-manifold edges; repair it before printing")
    if mesh.volume < 0:
        mesh.invert()
    return mesh


def _joined(bodies: list[trimesh.Trimesh]) -> PrintMesh:
    """Bodies as one print object, each kept closed on its own: touching bodies share no vertices."""
    offsets = np.cumsum([0] + [len(body.vertices) for body in bodies[:-1]])
    vertices = np.concatenate([np.asarray(body.vertices, dtype=float) for body in bodies])
    faces = np.concatenate([np.asarray(body.faces, dtype=np.int64) + offset for body, offset in zip(bodies, offsets)])
    return PrintMesh(vertices, faces, bodies=len(bodies))


def load_mesh(path: Path) -> PrintMesh:
    """A STEP file's solids (every occurrence, placed as in the file) or an STL's triangles, in mm.
    Several bodies print as one object, as the file places them."""
    suffix = path.suffix.lower()
    if not path.is_file():
        raise MeshError(f"Part file not found: {path}")
    if suffix in STEP_SUFFIXES:
        scene = load_step_scene(path)
        mesh_step_scene(scene, linear_deflection=LINEAR_DEFLECTION_MM, angular_deflection=ANGULAR_DEFLECTION_RAD, relative=False)
        bodies = []
        for leaf in scene_leaf_occurrences(scene):
            vertices, faces = shape_mesh(scene_occurrence_shape(scene, leaf))
            bodies.append(_closed(vertices, faces, f"{path} body {leaf.name or len(bodies) + 1}"))
        if not bodies:
            raise MeshError(f"{path} holds no solids")
        return _joined(bodies)
    if suffix in MESH_SUFFIXES:
        loaded = trimesh.load_mesh(path, force="mesh", process=False)
        return _joined([_closed(loaded.vertices, loaded.faces, str(path))])
    raise MeshError(f"Part files must be STEP, STP or STL, not {path.name}")
