"""Photo scenes: which part files stand where in the picture, in which filament colour, printed which way up."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from common.paths import relative_path
from print.meshes import MESH_SUFFIXES, STEP_SUFFIXES, rotation

SCENE_SUFFIX = ".photo.json"
SCENE_KEYS = {"output", "parts", "view", "size", "samples", "backdrop", "layer_height", "fill"}
PART_KEYS = {"file", "name", "colour", "printed", "rotate", "at"}
COLOUR = re.compile(r"#[0-9a-fA-F]{6}")
DEFAULT_COLOUR = "#70757A"
DEFAULT_SIZE = (1920, 1440)


class SceneError(ValueError):
    pass


@dataclass(frozen=True)
class PartSpec:
    file: Path
    name: str
    colour: str
    # How the part was turned for printing, as its print job's rotate: the layers lie across the bed's Z.
    printed: tuple[float, float, float] = (0.0, 0.0, 0.0)
    # How the part is turned in the picture.
    rotate: tuple[float, float, float] = (0.0, 0.0, 0.0)
    # Where its model origin goes: [x, y] sets it on the floor there, [x, y, z] holds it at that height.
    at: tuple[float, ...] = (0.0, 0.0)


@dataclass(frozen=True)
class Scene:
    parts: tuple[PartSpec, ...]
    output: Path
    view: tuple[float, float] = (28.0, 36.0)
    size: tuple[int, int] = DEFAULT_SIZE
    samples: int = 400
    backdrop: str = "#9E9E9C"
    layer_height: float = 0.2
    fill: float = 0.8


def print_direction(spec: PartSpec) -> np.ndarray:
    """The way the part's layers stack, as a unit vector in the picture: the bed's Z, taken back into
    the model by undoing the print rotation, then turned with the part into its pose."""
    return rotation(spec.rotate) @ rotation(spec.printed).T @ np.array([0.0, 0.0, 1.0])


def posed(vertices: np.ndarray, spec: PartSpec) -> np.ndarray:
    """A part's vertices (mm, model frame) where the scene puts them."""
    turned = vertices @ rotation(spec.rotate).T
    if len(spec.at) == 3:
        return turned + np.array(spec.at)
    return turned + np.array([spec.at[0], spec.at[1], -turned[:, 2].min()])


def _numbers(value: object, counts: tuple[int, ...], where: str, what: str) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) not in counts or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        raise SceneError(f"{where} must be {what}")
    return tuple(float(v) for v in value)


def _colour(value: object, where: str) -> str:
    if not isinstance(value, str) or not COLOUR.fullmatch(value):
        raise SceneError(f"{where} must be #RRGGBB, not {value!r}")
    return value.upper()


def _part(data: object, base: Path, where: str) -> PartSpec:
    if not isinstance(data, Mapping):
        raise SceneError(f"{where} must be an object with at least a file")
    extra = sorted(set(data) - PART_KEYS)
    if extra:
        raise SceneError(f"{where}: unknown key(s) {', '.join(extra)}; expected {', '.join(sorted(PART_KEYS))}")
    file = data.get("file")
    relative = relative_path(file) if isinstance(file, str) else None
    if relative is None:
        raise SceneError(f"{where} needs a file: a STEP, STP or STL path relative to the scene file, with either separator")
    path = (base / Path(*relative.parts)).resolve()
    if path.suffix.lower() not in STEP_SUFFIXES | MESH_SUFFIXES:
        raise SceneError(f"{where} file must be STEP, STP or STL, not {file}")
    name = data.get("name", path.stem)
    if not isinstance(name, str) or not name.strip():
        raise SceneError(f"{where} name must be a non-empty string")
    degrees = "[x, y, z] degrees about the fixed axes, applied X then Y then Z"
    return PartSpec(
        file=path,
        name=" ".join(name.split()),
        colour=_colour(data.get("colour", DEFAULT_COLOUR), f"{where} colour"),
        printed=_numbers(data.get("printed", [0, 0, 0]), (3,), f"{where} printed", f"the print job's rotate, {degrees}"),
        rotate=_numbers(data.get("rotate", [0, 0, 0]), (3,), f"{where} rotate", degrees),
        at=_numbers(data.get("at", [0, 0]), (2, 3), f"{where} at", "[x, y] to stand the part on the floor there, or [x, y, z] to hold its origin there, in mm"),
    )


VIEW = "[azimuth, elevation] in degrees, the elevation from 0 (level) to 90 (straight down)"
MAX_SIDE = 16384


def checked_view(view: tuple[float, ...]) -> tuple[float, float]:
    if len(view) != 2 or not all(math.isfinite(v) for v in view) or not 0 <= view[1] <= 90:
        raise SceneError(f"photo scene view must be {VIEW}")
    return view[0], view[1]


def checked_size(size: object) -> tuple[int, int]:
    if not isinstance(size, tuple) or len(size) != 2 or not all(isinstance(v, int) and not isinstance(v, bool) and 16 <= v <= MAX_SIDE for v in size):
        raise SceneError(f"photo scene size must be [width, height] in pixels, each from 16 to {MAX_SIDE}")
    return size


def checked_samples(samples: object) -> int:
    if not isinstance(samples, int) or isinstance(samples, bool) or samples < 1:
        raise SceneError("photo scene samples must be a whole number of at least 1")
    return samples


def parse_scene(data: Mapping, *, base: Path, default_output: Path) -> Scene:
    extra = sorted(set(data) - SCENE_KEYS)
    if extra:
        raise SceneError(f"photo scene: unknown key(s) {', '.join(extra)}; expected {', '.join(sorted(SCENE_KEYS))}")
    raw = data.get("parts")
    if not isinstance(raw, list) or not raw:
        raise SceneError("photo scene parts must be a non-empty list of parts")
    output = data.get("output")
    relative = relative_path(output) if isinstance(output, str) else None
    if output is not None and (relative is None or relative.suffix.lower() != ".png"):
        raise SceneError("photo scene output must be a .png path relative to the scene file, with either separator")
    options: dict = {}
    if "view" in data:
        options["view"] = checked_view(_numbers(data["view"], (2,), "photo scene view", VIEW))
    if "size" in data:
        size = data["size"]
        options["size"] = checked_size(tuple(size) if isinstance(size, list) else size)
    if "samples" in data:
        options["samples"] = checked_samples(data["samples"])
    if "backdrop" in data:
        options["backdrop"] = _colour(data["backdrop"], "photo scene backdrop")
    for key, low, high, what in (("layer_height", 0.04, 1.0, "the print's layer height in mm"), ("fill", 0.1, 1.0, "how much of the picture's height the parts take")):
        if key in data:
            value = data[key]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not low <= value <= high:
                raise SceneError(f"photo scene {key} must be {what}, from {low:g} to {high:g}")
            options[key] = float(value)
    return Scene(
        parts=tuple(_part(item, base, f"parts[{index}]") for index, item in enumerate(raw)),
        output=(base / Path(*relative.parts)).resolve() if relative else default_output,
        **options,
    )


def load_scene(path: Path) -> Scene:
    path = path.resolve()
    if not path.is_file():
        raise SceneError(f"Photo scene not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise SceneError(f"{path} is not a photo scene: it is not JSON text ({error})") from None
    if not isinstance(data, Mapping):
        raise SceneError(f"{path} must hold a JSON object")
    stem = path.name[: -len(SCENE_SUFFIX)] if path.name.lower().endswith(SCENE_SUFFIX) else path.stem
    return parse_scene(data, base=path.parent, default_output=path.with_name(f"{stem}.png"))
