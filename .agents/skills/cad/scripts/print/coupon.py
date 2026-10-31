"""Coupons, each rung marked with as many dimples as its place in the ladder.

A fit ladder is a bar of round holes stepping through diametral clearances, to find the clearance a
fit needs by trying the real mating part. Calibration ladders measure the printer's X-Y compensation
for a filament: a bar of holes or a row of pegs, each rung sized for one compensation value, printed
with compensation at 0. The rung the real part fits snugly is the compensation to save."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from build123d import Box, Cylinder, Pos, Sphere, export_step

from .meshes import STEP_SUFFIXES
from .profile import MAX_COMPENSATION_MM


WALL_MM = 4.0
DIMPLE_RADIUS_MM = 0.6
DIMPLE_PITCH_MM = 1.8
DIMPLE_BAND_MM = 3.0
MAX_STEPS = 9
# The pegs' base, and how far their test length reaches above it.
BASE_MM = 3.0
# Starting ranges of compensation to try, in mm per side; the user's rung decides.
DEFAULT_VALUES = {
    "holes": (0.0, 0.05, 0.1, 0.15, 0.2, 0.25),
    "pegs": (-0.15, -0.1, -0.05, 0.0, 0.05, 0.1),
}
# Which compensation each calibration ladder measures.
MEASURES = {"holes": "hole", "pegs": "contour"}


@dataclass(frozen=True)
class Rung:
    marks: int
    clearance_mm: float
    hole_mm: float


@dataclass(frozen=True)
class CalibrationRung:
    """A rung modelled ``size_mm`` across: the real part's diameter and ``value_mm`` more on each side.
    Printed with compensation at 0, the real part fits it snugly when the printer and filament need
    compensation ``value_mm``."""

    marks: int
    value_mm: float
    size_mm: float


def _marks(shape, x: float, count: int, z: float):
    """``count`` dimples in a row centred on x, in the band along the front edge."""
    for mark in range(count):
        offset = (mark - (count - 1) / 2) * DIMPLE_PITCH_MM
        shape -= Pos(x + offset, DIMPLE_BAND_MM / 2 + WALL_MM / 2, z) * Sphere(DIMPLE_RADIUS_MM)
    return shape


def _pitch(largest: float, rungs: int) -> float:
    """Room between rungs for a wall, and in front of each for its row of dimples."""
    return max(largest + WALL_MM, (rungs - 1) * DIMPLE_PITCH_MM + 2 * DIMPLE_RADIUS_MM + WALL_MM / 2)


def _hole_bar(holes: list[float], depth: float):
    """A bar of vertical round holes of these diameters, as printed flat (the most accurate way to print
    a round hole), with n dimples in front of the nth."""
    largest = max(holes)
    pitch = _pitch(largest, len(holes))
    length = pitch * len(holes) + WALL_MM
    width = largest + 2 * WALL_MM + DIMPLE_BAND_MM
    bar = Pos(length / 2, width / 2, depth / 2) * Box(length, width, depth)
    hole_y = DIMPLE_BAND_MM + WALL_MM + largest / 2
    for index, hole in enumerate(holes):
        x = WALL_MM / 2 + pitch * (index + 0.5)
        bar -= Pos(x, hole_y, depth / 2) * Cylinder(hole / 2, depth * 2)
        bar = _marks(bar, x, index + 1, depth)
    return bar


def _peg_row(pegs: list[float], depth: float):
    """Upright pegs of these diameters on a base, with n dimples in front of the nth. They stand a peg
    apart, so a mating part up to about three pegs wide reaches over one without meeting the next."""
    largest = max(pegs)
    pitch = max(2 * largest, _pitch(largest, len(pegs)))
    length = pitch * len(pegs)
    width = largest + 2 * WALL_MM + DIMPLE_BAND_MM
    row = Pos(length / 2, width / 2, BASE_MM / 2) * Box(length, width, BASE_MM)
    peg_y = DIMPLE_BAND_MM + WALL_MM + largest / 2
    for index, peg in enumerate(pegs):
        x = pitch * (index + 0.5)
        row += Pos(x, peg_y, BASE_MM + depth / 2) * Cylinder(peg / 2, depth)
        row = _marks(row, x, index + 1, BASE_MM)
    return row


def _check(diameter: float, depth: float, count: int) -> None:
    if diameter <= 0 or depth <= 0:
        raise ValueError("diameter and depth must be positive")
    if not 1 <= count <= MAX_STEPS:
        raise ValueError(f"give between 1 and {MAX_STEPS} rungs")


def ladder(diameter: float, clearances: list[float], depth: float) -> tuple[object, list[Rung]]:
    """The fit ladder and its rungs in order: rung n has n dimples in front of its hole."""
    _check(diameter, depth, len(clearances))
    rungs = [Rung(index + 1, clearance, diameter + clearance) for index, clearance in enumerate(clearances)]
    if min(rung.hole_mm for rung in rungs) <= 0:
        raise ValueError("every hole must be larger than zero")
    return _hole_bar([rung.hole_mm for rung in rungs], depth), rungs


def calibration_ladder(kind: str, diameter: float, values: list[float], depth: float) -> tuple[object, list[CalibrationRung]]:
    """A ladder of holes (hole compensation) or pegs (contour compensation) for a real part of
    ``diameter``: the rung for value v is modelled v per side larger, so with compensation at 0 the
    part fits it snugly when the printer needs compensation v."""
    _check(diameter, depth, len(values))
    if len(set(values)) != len(values):
        raise ValueError("give each compensation value once")
    if any(abs(value) >= MAX_COMPENSATION_MM for value in values):
        raise ValueError(f"compensation values are small corrections per side, under {MAX_COMPENSATION_MM:g} mm")
    rungs = [CalibrationRung(index + 1, value, round(diameter + 2 * value, 4)) for index, value in enumerate(values)]
    if min(rung.size_mm for rung in rungs) <= 0:
        raise ValueError("every rung must be larger than zero")
    build = {"holes": _hole_bar, "pegs": _peg_row}[kind]
    return build([rung.size_mm for rung in rungs], depth), rungs


def peg(diameter: float, depth: float) -> object:
    """A plain peg at the nominal diameter, standing up as printed, a little longer than the ladder is deep."""
    return Pos(0, 0, (depth + 5) / 2) * Cylinder(diameter / 2, depth + 5)


def _export(shape, label: str, path: Path) -> None:
    if path.suffix.lower() not in STEP_SUFFIXES:
        raise ValueError(f"the coupon is written as STEP: give a .step or .stp path, not {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    shape.label = label
    export_step(shape, str(path))


def write_ladder(path: Path, diameter: float, clearances: list[float], depth: float, with_peg: bool) -> tuple[list[Rung], Path | None]:
    shape, rungs = ladder(diameter, clearances, depth)
    _export(shape, f"fit ladder {diameter:g} mm", path)
    peg_path = None
    if with_peg:
        peg_path = path.with_name(f"{path.stem}-peg{path.suffix}")
        _export(peg(diameter, depth), f"peg {diameter:g} mm", peg_path)
    return rungs, peg_path


def write_calibration_ladder(path: Path, kind: str, diameter: float, values: list[float], depth: float) -> list[CalibrationRung]:
    shape, rungs = calibration_ladder(kind, diameter, values, depth)
    _export(shape, f"{MEASURES[kind]} compensation ladder {diameter:g} mm", path)
    return rungs
