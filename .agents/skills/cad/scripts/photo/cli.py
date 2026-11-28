"""Printed-part photos: a scene of part files rendered in Blender as the FDM prints they will be."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import trimesh

from common.paths import command_line_path
from print.meshes import MeshError, load_mesh

from .scene import Scene, SceneError, checked_samples, checked_size, checked_view, load_scene, posed, print_direction

BLENDER_ENV = "CAD_PILOT_BLENDER"
BLENDER_SCRIPT = Path(__file__).with_name("blender_scene.py")
RENDERED = "photo.png"


class BlenderError(RuntimeError):
    pass


def locate_blender() -> Path:
    """Blender's executable: the one the environment names (an app or its executable), the one on
    PATH, or the usual place it installs to."""
    configured = os.environ.get(BLENDER_ENV)
    candidates: list[Path] = []
    if configured:
        path = Path(configured).expanduser()
        candidates.append(path / "Contents" / "MacOS" / "Blender" if path.suffix == ".app" else path)
    else:
        on_path = shutil.which("blender")
        if on_path:
            candidates.append(Path(on_path))
        if sys.platform == "darwin":
            candidates.append(Path("/Applications/Blender.app/Contents/MacOS/Blender"))
        for root in (os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432")):
            if root:
                candidates += sorted(Path(root).glob("Blender Foundation/Blender*/blender.exe"), key=_version, reverse=True)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    tried = ", ".join(str(path) for path in candidates) or "nothing on PATH"
    raise BlenderError(f"Blender not found (tried {tried}). Install it, or set the {BLENDER_ENV} environment variable to the app or its executable.")


def _version(path: Path) -> tuple[int, ...]:
    """The version in an install folder's name, so 4.10 sorts above 4.2."""
    return tuple(int(part) for part in "".join(c if c.isdigit() else " " for c in path.parent.name).split())


def stage(scene: Scene, folder: Path) -> Path:
    """Write what Blender reads: each part posed as a mesh of its own, and the scene's description.
    The picture is rendered into the folder too, so a failed run leaves no half-written output and
    the output's own path never reaches Blender, which reads braces in a path as a template."""
    parts = []
    for index, spec in enumerate(scene.parts):
        mesh = load_mesh(spec.file)
        name = f"part-{index}.stl"
        trimesh.Trimesh(vertices=posed(mesh.vertices, spec), faces=mesh.faces, process=False).export(folder / name)
        parts.append({"name": spec.name, "mesh": name, "colour": spec.colour, "print_direction": [round(float(v), 9) for v in print_direction(spec)]})
    description = {
        "parts": parts,
        "output": str(folder / RENDERED),
        "view": list(scene.view),
        "size": list(scene.size),
        "samples": scene.samples,
        "backdrop": scene.backdrop,
        "layer_height": scene.layer_height,
        "fill": scene.fill,
    }
    path = folder / "scene.json"
    path.write_text(json.dumps(description, indent=1), encoding="utf-8")
    return path


def render(scene: Scene, blender: Path, *, timeout: float = 3600) -> None:
    scene.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cad-photo-") as temp:
        staged = stage(scene, Path(temp))
        command = [str(blender), "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(BLENDER_SCRIPT), "--", str(staged)]
        try:
            result = subprocess.run(command, cwd=temp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", timeout=timeout)
        except OSError as error:
            raise BlenderError(f"Could not run Blender {blender}: {error}") from error
        except subprocess.TimeoutExpired:
            raise BlenderError(f"Blender was still rendering after {timeout:g} s; lower the scene's size or samples") from None
        rendered = Path(temp) / RENDERED
        if result.returncode != 0 or not rendered.is_file():
            raise BlenderError(f"Blender did not render the picture:\n{_failure(result.stdout)}")
        try:
            shutil.move(rendered, scene.output)
        except OSError as error:
            raise BlenderError(f"Could not write {scene.output}: {error}") from error


def _failure(output: str) -> str:
    """What Blender said went wrong: its Python traceback or error lines, or else its last lines."""
    lines = [line for line in output.splitlines() if line.strip()]
    start = next((i for i, line in enumerate(lines) if line.startswith(("Traceback", "Error", "error:"))), max(len(lines) - 12, 0))
    return "\n".join(lines[start:][-25:])


def _path(value: str) -> Path:
    try:
        return command_line_path(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _pair(kind, separator: str, what: str):
    def read(value: str):
        try:
            first, second = (kind(v) for v in value.split(separator))
        except ValueError:
            raise argparse.ArgumentTypeError(f"expected {what}, not {value!r}") from None
        return first, second

    return read


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scripts/photo",
        description="Render a scene of part files in Blender so they look like the FDM prints they will be: layer lines along each part's print direction, in its filament's colour.",
    )
    parser.add_argument("scene", type=_path, help="The photo scene, <name>.photo.json: the part files, their colours, print rotations and places in the picture.")
    parser.add_argument("-o", "--output", type=_path, help="The PNG to write (default: the scene's output, or <name>.png beside it).")
    parser.add_argument("--size", type=_pair(int, "x", "WIDTHxHEIGHT in pixels"), help="Picture size, such as 3840x2880 (default: the scene's, or 1920x1440).")
    parser.add_argument("--samples", type=int, help="Light paths traced per pixel (default: the scene's, or 400); fewer is quicker and noisier.")
    parser.add_argument("--view", type=_pair(float, ":", "AZIMUTH:ELEVATION in degrees"), help="Where the camera stands, as CAD Explorer's --view AZ:EL (default: the scene's, or 28:36).")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    try:
        scene = load_scene(args.scene)
        changes = {key: value for key, value in (("output", args.output), ("size", args.size), ("samples", args.samples), ("view", args.view)) if value is not None}
        if "output" in changes and changes["output"].suffix.lower() != ".png":
            raise SceneError("--output must be a .png path")
        for key, check in (("size", checked_size), ("samples", checked_samples), ("view", checked_view)):
            if key in changes:
                changes[key] = check(changes[key])
        scene = replace(scene, **changes)
        # A scene's own mistakes are reported before Blender is looked for.
        for spec in scene.parts:
            if not spec.file.is_file():
                raise SceneError(f"Part file not found: {spec.file}")
        blender = locate_blender()
        render(scene, blender)
    except (BlenderError, MeshError, SceneError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    for spec in scene.parts:
        direction = ", ".join(f"{v:.2f}" for v in print_direction(spec))
        print(f"  {spec.name}: {spec.colour}, layers stacked along ({direction}) in the picture")
    print(f"Photo: {scene.output}")
    return 0
