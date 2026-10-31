"""Print jobs: which part files go on which named plates, turned how, in which filament."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from common.paths import relative_path

from .meshes import MESH_SUFFIXES, STEP_SUFFIXES
from .profile import COLOUR, KEYS as PROFILE_KEYS


JOB_KEYS = {"name", "output", "profile", "plates", "parts"}
PLATE_KEYS = {"name", "parts"}
PART_KEYS = {"file", "name", "rotate", "copies", "filament", "colour", "support", "turn"}
JOB_SUFFIX = ".print.json"


class JobError(ValueError):
    pass


@dataclass(frozen=True)
class PartSpec:
    file: Path
    name: str
    rotate: tuple[float, float, float] = (0.0, 0.0, 0.0)
    copies: int = 1
    filament: str | None = None
    colour: str | None = None
    support: bool = True
    turn: bool = True


@dataclass(frozen=True)
class PlateSpec:
    name: str
    parts: tuple[PartSpec, ...]


@dataclass(frozen=True)
class Job:
    """Named plates, or with ``auto_plates`` parts packed onto as few plates as they need."""

    name: str
    plates: tuple[PlateSpec, ...]
    auto_plates: bool
    output: Path
    profile: Mapping

    @property
    def parts(self) -> list[PartSpec]:
        return [part for plate in self.plates for part in plate.parts]


def _part(data: object, base: Path, where: str) -> PartSpec:
    if not isinstance(data, Mapping):
        raise JobError(f"{where} must be an object with at least a file")
    extra = sorted(set(data) - PART_KEYS)
    if extra:
        raise JobError(f"{where}: unknown key(s) {', '.join(extra)}; expected {', '.join(sorted(PART_KEYS))}")
    file = data.get("file")
    relative = relative_path(file) if isinstance(file, str) else None
    if relative is None:
        raise JobError(f"{where} needs a file: a STEP, STP or STL path relative to the job file, with either separator")
    rotate = data.get("rotate", [0, 0, 0])
    if not isinstance(rotate, list) or len(rotate) != 3 or not all(isinstance(v, (int, float)) for v in rotate):
        raise JobError(f"{where} rotate must be [x, y, z] degrees about the fixed axes, applied X then Y then Z")
    copies = data.get("copies", 1)
    if not isinstance(copies, int) or isinstance(copies, bool) or copies < 1:
        raise JobError(f"{where} copies must be a whole number of at least 1")
    colour = data.get("colour")
    if colour is not None and (not isinstance(colour, str) or not COLOUR.fullmatch(colour)):
        raise JobError(f"{where} colour must be #RRGGBB, not {colour!r}")
    for flag in ("support", "turn"):
        if not isinstance(data.get(flag, True), bool):
            raise JobError(f"{where} {flag} must be true or false")
    filament = data.get("filament")
    if filament is not None and not isinstance(filament, str):
        raise JobError(f"{where} filament must name a filament of the print profile")
    path = (base / Path(*relative.parts)).resolve()
    if path.suffix.lower() not in STEP_SUFFIXES | MESH_SUFFIXES:
        raise JobError(f"{where} file must be STEP, STP or STL, not {file}")
    name = data.get("name", path.stem)
    if not isinstance(name, str) or not name.strip():
        raise JobError(f"{where} name must be a non-empty string")
    return PartSpec(
        file=path,
        name=" ".join(name.split()),
        rotate=tuple(float(v) for v in rotate),
        copies=copies,
        filament=filament,
        colour=colour.upper() if colour else None,
        support=data.get("support", True),
        turn=data.get("turn", True),
    )


def _parts(data: object, base: Path, where: str) -> tuple[PartSpec, ...]:
    if not isinstance(data, list) or not data:
        raise JobError(f"{where} must be a non-empty list of parts")
    return tuple(_part(item, base, f"{where}[{index}]") for index, item in enumerate(data))


def parse_job(data: Mapping, *, base: Path, default_output: Path) -> Job:
    extra = sorted(set(data) - JOB_KEYS)
    if extra:
        raise JobError(f"print job: unknown key(s) {', '.join(extra)}; expected {', '.join(sorted(JOB_KEYS))}")
    if ("plates" in data) == ("parts" in data):
        raise JobError("print job needs either plates (named plates of parts) or parts (packed onto as few plates as they need)")
    name = data.get("name", default_output.stem)
    if not isinstance(name, str) or not name.strip():
        raise JobError("print job name must be a non-empty string")
    profile = data.get("profile", {})
    if not isinstance(profile, Mapping):
        raise JobError(f"print job profile must be an object overriding {', '.join(sorted(PROFILE_KEYS))}")
    output = data.get("output")
    relative_output = relative_path(output) if isinstance(output, str) else None
    if output is not None and (relative_output is None or relative_output.suffix.lower() != ".3mf"):
        raise JobError("print job output must be a .3mf path relative to the job file, with either separator")
    if "parts" in data:
        plates = (PlateSpec(name, _parts(data["parts"], base, "parts")),)
    else:
        raw = data["plates"]
        if not isinstance(raw, list) or not raw:
            raise JobError("print job plates must be a non-empty list")
        plates = []
        for index, plate in enumerate(raw):
            where = f"plates[{index}]"
            if not isinstance(plate, Mapping):
                raise JobError(f"{where} must be an object with a name and parts")
            extra = sorted(set(plate) - PLATE_KEYS)
            if extra:
                raise JobError(f"{where}: unknown key(s) {', '.join(extra)}; expected name, parts")
            plate_name = plate.get("name", f"Plate {index + 1}")
            if not isinstance(plate_name, str) or not plate_name.strip():
                raise JobError(f"{where} name must be a non-empty string")
            plates.append(PlateSpec(" ".join(plate_name.split()), _parts(plate.get("parts"), base, f"{where}.parts")))
        plates = tuple(plates)
    return Job(
        name=" ".join(name.split()),
        plates=plates,
        auto_plates="parts" in data,
        output=(base / Path(*relative_output.parts)).resolve() if relative_output else default_output,
        profile=profile,
    )


def load_job(path: Path, part: Mapping | None = None) -> Job:
    """A job file, or a single STEP/STL part (with ``part`` options such as rotate) on one plate."""
    path = path.resolve()
    if path.suffix.lower() in STEP_SUFFIXES | MESH_SUFFIXES:
        entry = {"file": path.name, **(part or {})}
        return parse_job({"parts": [entry]}, base=path.parent, default_output=path.with_suffix(".3mf"))
    if part:
        raise JobError(f"Part options apply to a single STEP or STL target; set them in the job file {path.name} instead")
    if not path.is_file():
        raise JobError(f"Print job not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise JobError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(data, Mapping):
        raise JobError(f"{path} must hold a JSON object")
    stem = path.name[: -len(JOB_SUFFIX)] if path.name.lower().endswith(JOB_SUFFIX) else path.stem
    return parse_job(data, base=path.parent, default_output=path.with_name(f"{stem}.3mf"))
