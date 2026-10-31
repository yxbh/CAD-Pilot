"""Fit-coupon ladders: a bar of round holes stepping through diametral clearances, each marked with
as many dimples as its place in the ladder, to find a fit by trying the real mating part."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from build123d import Box, Cylinder, Pos, Sphere, export_step


WALL_MM = 4.0
DIMPLE_RADIUS_MM = 0.6
DIMPLE_PITCH_MM = 1.8
DIMPLE_BAND_MM = 3.0
MAX_STEPS = 9


@dataclass(frozen=True)
class Rung:
    marks: int
    clearance_mm: float
    hole_mm: float


def ladder(diameter: float, clearances: list[float], depth: float) -> tuple[object, list[Rung]]:
    """The ladder solid, holes vertical as printed flat (the most accurate way to print a round
    hole), and its rungs in order: rung n has n dimples in front of its hole."""
    if diameter <= 0 or depth <= 0:
        raise ValueError("diameter and depth must be positive")
    if not 1 <= len(clearances) <= MAX_STEPS:
        raise ValueError(f"give between 1 and {MAX_STEPS} clearances")
    rungs = [Rung(index + 1, clearance, diameter + clearance) for index, clearance in enumerate(clearances)]
    if min(rung.hole_mm for rung in rungs) <= 0:
        raise ValueError("every hole must be larger than zero")
    largest = max(rung.hole_mm for rung in rungs)
    # Room between holes for a wall, and in front of each for its row of dimples.
    pitch = max(largest + WALL_MM, (len(rungs) - 1) * DIMPLE_PITCH_MM + 2 * DIMPLE_RADIUS_MM + WALL_MM / 2)
    length = pitch * len(rungs) + WALL_MM
    width = largest + 2 * WALL_MM + DIMPLE_BAND_MM
    bar = Pos(length / 2, width / 2, depth / 2) * Box(length, width, depth)
    hole_y = DIMPLE_BAND_MM + WALL_MM + largest / 2
    for index, rung in enumerate(rungs):
        x = WALL_MM / 2 + pitch * (index + 0.5)
        bar -= Pos(x, hole_y, depth / 2) * Cylinder(rung.hole_mm / 2, depth * 2)
        for mark in range(rung.marks):
            offset = (mark - (rung.marks - 1) / 2) * DIMPLE_PITCH_MM
            bar -= Pos(x + offset, DIMPLE_BAND_MM / 2 + WALL_MM / 2, depth) * Sphere(DIMPLE_RADIUS_MM)
    return bar, rungs


def peg(diameter: float, depth: float) -> object:
    """A plain peg at the nominal diameter, standing up as printed, a little longer than the ladder is deep."""
    return Pos(0, 0, (depth + 5) / 2) * Cylinder(diameter / 2, depth + 5)


def write_ladder(path: Path, diameter: float, clearances: list[float], depth: float, with_peg: bool) -> tuple[list[Rung], Path | None]:
    shape, rungs = ladder(diameter, clearances, depth)
    path.parent.mkdir(parents=True, exist_ok=True)
    shape.label = f"fit ladder {diameter:g} mm"
    export_step(shape, str(path))
    peg_path = None
    if with_peg:
        peg_path = path.with_name(f"{path.stem}-peg{path.suffix}")
        pin = peg(diameter, depth)
        pin.label = f"peg {diameter:g} mm"
        export_step(pin, str(peg_path))
    return rungs, peg_path
