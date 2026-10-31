"""Clearance between a STEP's parts, as assembled and in the poses a generator declares.

``gen_poses()`` sits beside ``gen_step()`` and returns poses, each moving
named parts from where the STEP places them::

    def gen_poses():
        hinge = Pos(0, 40, 30)
        return {
            "min_gap": 0.3,                      # mm; optional
            "pairs": [["lid", "box"], ["latch", "box", 0.2]],  # optional; a third value is that pair's gap
            "poses": [
                {"name": f"lid {a} deg", "move": {"lid": hinge * Rot(a, 0, 0) * hinge.inverse()}}
                for a in range(0, 101, 5)
            ],
        }

A plain list of poses is also accepted. A move is a build123d ``Location``
applied in world coordinates, or an ``(x, y, z)`` offset in mm. Part names and
patterns are those ``inspect parts`` lists. Only pairs that move relative to
each other are measured again in a pose. Distances are exact B-rep minimum
distances; touching and overlapping parts have distance zero, told apart by
their shared volume. Pairs whose bounding boxes stay farther apart than the
report horizon are reported as clear by at least that distance, not measured.
This is a rigid check of the stated poses: it does not model flexing,
threads, gravity or motion between the poses.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

from common.step_parts import StepPart, StepParts, match_parts

OVERLAP_TOLERANCE_MM3 = 1e-3
DEFAULT_HORIZON = 5.0
AS_ASSEMBLED = "as assembled"


class PoseError(ValueError):
    """gen_poses() returned something this check cannot use."""


@dataclass(frozen=True)
class PoseSet:
    poses: tuple[tuple[str, dict[str, object]], ...]  # (name, {occurrence id: TopLoc_Location})
    pairs: tuple[tuple[StepPart, StepPart, float | None], ...]  # with each pair's required gap
    min_gap: float | None


@dataclass
class PairResult:
    a: StepPart
    b: StepPart
    min_gap: float | None = None
    distance: float | None = None  # smallest exact distance found, None if never measured
    at_least: float | None = None  # lower bound when every pose stayed beyond the horizon
    pose: str | None = None
    points: tuple[list[float], list[float]] | None = None
    overlap: float = 0.0
    overlap_pose: str | None = None
    touching_poses: list[str] = field(default_factory=list)
    overlap_poses: list[str] = field(default_factory=list)
    measured: int = 0


def _location(value: object, field_name: str):
    from OCP.TopLoc import TopLoc_Location
    from OCP.gp import gp_Trsf, gp_Vec

    wrapped = getattr(value, "wrapped", None)
    if isinstance(wrapped, TopLoc_Location):
        return wrapped
    try:
        offset = [float(item) for item in value]  # type: ignore[union-attr]
    except (TypeError, ValueError):
        offset = []
    if len(offset) != 3 or not all(math.isfinite(item) for item in offset):
        raise PoseError(f"{field_name} must be a build123d Location or an (x, y, z) offset")
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(*offset))
    return TopLoc_Location(trsf)


def _gap(value: object, field_name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise PoseError(f"{field_name} must be a distance of zero or more in mm")
    return float(value)


def _pairs_for(patterns: object, parts: tuple[StepPart, ...], default_gap: float | None) -> list[tuple[StepPart, StepPart, float | None]]:
    if not isinstance(patterns, list) or not all(
        isinstance(pair, (list, tuple)) and len(pair) in (2, 3) and all(isinstance(name, str) for name in pair[:2])
        for pair in patterns
    ):
        raise PoseError("pairs must be a list of [part, part] or [part, part, gap mm] entries")
    pairs: dict[tuple[str, str], tuple[StepPart, StepPart, float | None]] = {}
    for entry in patterns:
        left, right = entry[0], entry[1]
        gap = _gap(entry[2], f"pairs gap for {left!r} and {right!r}") if len(entry) == 3 else default_gap
        lefts, missing_left = match_parts([left], parts)
        rights, missing_right = match_parts([right], parts)
        if missing_left or missing_right:
            raise PoseError(f"pairs names unknown part(s): {', '.join(missing_left + missing_right)}")
        for a in lefts:
            for b in rights:
                if a.occurrence_id != b.occurrence_id:
                    key = tuple(sorted((a.occurrence_id, b.occurrence_id)))
                    pairs.setdefault(key, ((a, b) if key[0] == a.occurrence_id else (b, a)) + (gap,))
    return [pairs[key] for key in sorted(pairs, key=lambda key: _order(parts, key))]


def _order(parts: tuple[StepPart, ...], key: tuple[str, str]) -> tuple[int, int]:
    index = {part.occurrence_id: position for position, part in enumerate(parts)}
    return index[key[0]], index[key[1]]


def read_pose_set(raw: object, step_parts: StepParts, *, selected: list[StepPart] | None = None,
                  min_gap: float | None = None) -> PoseSet:
    """Validate gen_poses()'s result, or no poses, against the STEP's parts.

    ``selected`` limits the default pairs to those parts; ``min_gap`` from the
    command line overrides the generator's.
    """
    parts = step_parts.parts
    raw_poses: object = []
    raw_pairs: object = None
    declared_gap: object = None
    if isinstance(raw, dict):
        unknown = set(raw) - {"poses", "pairs", "min_gap"}
        if unknown:
            raise PoseError(f"gen_poses() has unsupported field(s): {', '.join(sorted(unknown))}")
        raw_poses, raw_pairs, declared_gap = raw.get("poses", []), raw.get("pairs"), raw.get("min_gap")
    elif raw is not None:
        raw_poses = raw
    if not isinstance(raw_poses, (list, tuple)):
        raise PoseError("gen_poses() must return a list of poses or {'poses': [...]}")
    poses: list[tuple[str, dict[str, object]]] = []
    names: set[str] = {AS_ASSEMBLED}
    for index, pose in enumerate(raw_poses, start=1):
        if not isinstance(pose, dict) or set(pose) - {"name", "move"}:
            raise PoseError(f"pose {index} must be {{'name': ..., 'move': {{part: Location}}}}")
        name = str(pose.get("name") or f"pose {index}").strip()
        if name in names:
            raise PoseError(f"pose {index} repeats the name {name!r}")
        names.add(name)
        move = pose.get("move") or {}
        if not isinstance(move, dict):
            raise PoseError(f"pose {name!r} move must map part names to Locations")
        moved: dict[str, object] = {}
        for pattern, value in move.items():
            hits, missing = match_parts([str(pattern)], parts)
            if missing:
                raise PoseError(f"pose {name!r} moves unknown part {pattern!r}")
            location = _location(value, f"pose {name!r} move for {pattern!r}")
            for part in hits:
                if part.occurrence_id in moved:
                    raise PoseError(f"pose {name!r} moves {part.path!r} twice")
                moved[part.occurrence_id] = location
        poses.append((name, moved))
    gap = _gap(min_gap, "--min-gap") if min_gap is not None else _gap(declared_gap, "min_gap")
    if raw_pairs is not None:
        pairs = _pairs_for(raw_pairs, parts, gap)
        if min_gap is not None:  # the command line overrides every declared gap
            pairs = [(a, b, gap) for a, b, _ in pairs]
    else:
        pool = selected if selected is not None else list(parts)
        pairs = [(a, b, gap) for a, b in itertools.combinations(pool, 2)]
    return PoseSet(poses=tuple(poses), pairs=tuple(pairs), min_gap=gap)


def _box(shape):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    return box


def _same(left, right) -> bool:
    if left is None or right is None:
        return left is right
    a, b = left.Transformation(), right.Transformation()
    return all(abs(a.Value(r, c) - b.Value(r, c)) < 1e-9 for r in (1, 2, 3) for c in (1, 2, 3, 4))


def _solids(shape) -> list:
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    solids = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, TopAbs_SOLID, solids)
    return [solids.FindKey(i) for i in range(1, solids.Extent() + 1)]


def _overlap(a, b) -> float:
    from build123d import Solid

    from common.geometry import overlap_volume

    return sum(overlap_volume(Solid(left), Solid(right)) for left in _solids(a) for right in _solids(b))


def check_clearance(pose_set: PoseSet, *, horizon: float = DEFAULT_HORIZON) -> list[PairResult]:
    boxes = {part.occurrence_id: _box(part.placed) for a, b, _ in pose_set.pairs for part in (a, b)}
    results = [PairResult(a, b, gap) for a, b, gap in pose_set.pairs]
    states = [(AS_ASSEMBLED, {})] + list(pose_set.poses)
    for result in results:
        a, b = result.a, result.b
        for pose_name, moved in states:
            move_a, move_b = moved.get(a.occurrence_id), moved.get(b.occurrence_id)
            if pose_name != AS_ASSEMBLED and _same(move_a, move_b):
                continue  # no relative motion: the as-assembled result stands
            shape_a = a.placed if move_a is None else a.placed.Moved(move_a)
            shape_b = b.placed if move_b is None else b.placed.Moved(move_b)
            box_a = boxes[a.occurrence_id] if move_a is None else boxes[a.occurrence_id].Transformed(move_a.Transformation())
            box_b = boxes[b.occurrence_id] if move_b is None else boxes[b.occurrence_id].Transformed(move_b.Transformation())
            gap = box_a.Distance(box_b)
            if gap > max(horizon, result.min_gap or 0.0):
                result.at_least = gap if result.at_least is None else min(result.at_least, gap)
                continue
            from build123d import Shape  # imported only once a pair is close enough to measure

            from common.geometry import closest_points

            closest = closest_points(Shape.cast(shape_a), Shape.cast(shape_b))
            result.measured += 1
            if result.distance is None or closest.distance < result.distance:
                result.distance = closest.distance
                result.pose = pose_name
                result.points = ([round(v, 3) for v in closest.point_a], [round(v, 3) for v in closest.point_b])
            if closest.distance <= 1e-9:
                volume = _overlap(shape_a, shape_b)
                if volume > OVERLAP_TOLERANCE_MM3:
                    result.overlap_poses.append(pose_name)
                    if volume > result.overlap:
                        result.overlap, result.overlap_pose = volume, pose_name
                else:
                    result.touching_poses.append(pose_name)
        if result.distance is not None and result.at_least is not None and result.at_least < result.distance:
            # A skipped pose may be closer than every measured one; all of them lie beyond the horizon.
            result.at_least, result.distance, result.pose, result.points = result.at_least, None, None, None
    return results


def pair_status(result: PairResult) -> str:
    """overlap, tight (closer than the pair's required gap, touching included), touching, or clear."""
    if result.overlap_poses:
        return "overlap"
    if result.distance is not None and result.distance <= 1e-9:
        return "tight" if result.min_gap else "touching"
    if result.min_gap is not None and result.distance is not None and result.distance < result.min_gap:
        return "tight"
    return "clear"
