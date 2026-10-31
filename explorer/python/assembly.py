"""Write a CAD Explorer assembly-sequence file beside a generated STEP.

Run from the design root with the workbench interpreter, after generating the STEP:

    python <workbench>/explorer/python/assembly.py source/model.py --step outputs/model.step [--check]

The source defines ``gen_step()`` (the labelled assembly) and ``gen_assembly()``, which returns
``{"steps": [...]}``. Each step names parts by label (``*`` and ``?`` wildcards, matching CAD
Explorer, so other characters such as brackets are literal; a group label covers its parts) and gives the offset in millimetres they arrive from, relative to where they
sit when assembled. A step may also name a part from an earlier step to carry it along, and may
supply ``check_shapes`` that stand in for listed parts during the check only, such as a
deflected-finger illustration of a snap part.

The file is presentation data written as ``<step stem>.assembly.json``; it never changes the
STEP. ``--check`` sweeps each step's parts in a straight line from their installed placement
towards their start offset and measures exact B-rep overlap with the parts already placed. It
is a rigid, sampled geometric check: it does not model flexing, threads, gravity, tool access
or friction, and features thinner than the sample spacing can be stepped over.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps

FORMAT = "cad-explorer-assembly"
VERSION = 1
MAX_STEPS = 200
OVERLAP_TOLERANCE_MM3 = 1e-3
LIMITS = ("Rigid straight-line sweep with exact B-rep overlap at sampled positions. It does not model flexing parts, "
          "threads, gravity, tool access or friction, and can step over features thinner than the sample spacing.")


class SequenceError(ValueError):
    """The generator, its sequence or the STEP path cannot produce a sequence file."""


def _load_source(path: Path):
    if path.suffix != ".py" or not path.is_file():
        raise SequenceError(f"Generator source not found: {path}")
    sys.path.insert(0, str(path.parent.resolve()))
    spec = importlib.util.spec_from_file_location(f"cad_explorer_sequence_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    # Compile the source itself: a cached .pyc is checked only against the source's whole-second mtime and its
    # size, so an edit of the same length within a second would otherwise run the old code.
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    for name in ("gen_step", "gen_assembly"):
        if not callable(getattr(module, name, None)):
            raise SequenceError(f"{path} must define {name}()")
    return module


def labelled_parts(shape) -> tuple[dict[str, list], dict[str, list[str]]]:
    """World-placed leaf shapes by label, and every label (leaf or group) mapped to its leaf labels."""
    leaves: dict[str, list] = {}
    groups: dict[str, list[str]] = {}

    def visit(node, ancestors):
        children = list(getattr(node, "children", None) or ())
        label = getattr(node, "label", "") or ""
        if children:
            for child in children:
                visit(child, ancestors + ([label] if label else []))
            return
        if not label:
            raise SequenceError("Every assembly part needs a label so sequence steps can name it")
        leaves.setdefault(label, []).append(node.located(node.global_location))
        for name in ancestors + [label]:
            members = groups.setdefault(name, [])
            if label not in members:
                members.append(label)

    visit(shape, [])
    return leaves, groups


def label_pattern(glob: str) -> re.Pattern:
    """Only ``*`` and ``?`` are wildcards, exactly as CAD Explorer resolves the same file."""
    return re.compile("".join(".*" if char == "*" else "." if char == "?" else re.escape(char) for char in glob), re.DOTALL)


def match_parts(patterns: list[str], groups: dict[str, list[str]]) -> tuple[list[str], list[str]]:
    matched: list[str] = []
    missing: list[str] = []
    for pattern in patterns:
        matcher = label_pattern(pattern)
        names = [name for name in groups if matcher.fullmatch(name)]
        if not names:
            missing.append(pattern)
        for name in names:
            matched.extend(leaf for leaf in groups[name] if leaf not in matched)
    return matched, missing


def _vector(value, field: str) -> list[float]:
    try:
        vector = [float(item) for item in value]
    except (TypeError, ValueError) as error:
        raise SequenceError(f"{field} must be three numbers") from error
    if len(vector) != 3 or not all(math.isfinite(item) and abs(item) <= 1e5 for item in vector):
        raise SequenceError(f"{field} must be three finite numbers within 100 m")
    return vector


def normalize_steps(raw, groups: dict[str, list[str]]) -> list[dict]:
    from build123d import Shape

    steps = raw.get("steps") if isinstance(raw, dict) else None
    if not isinstance(steps, list) or not 0 < len(steps) <= MAX_STEPS:
        raise SequenceError(f"gen_assembly() must return {{'steps': [...]}} with 1 to {MAX_STEPS} steps")
    result = []
    for index, step in enumerate(steps, 1):
        if not isinstance(step, dict) or not isinstance(step.get("title"), str) or not step["title"].strip():
            raise SequenceError(f"Step {index} needs a title")
        unknown = set(step) - {"title", "note", "parts", "from", "check_shapes"}
        if unknown:
            raise SequenceError(f"Step {index} has unsupported field(s): {', '.join(sorted(unknown))}")
        parts = step.get("parts")
        if not isinstance(parts, list) or not parts or not all(isinstance(part, str) and part for part in parts):
            raise SequenceError(f"Step {index} needs a list of part labels")
        leaves, missing = match_parts(parts, groups)
        if missing:
            raise SequenceError(f"Step {index} names unknown part(s): {', '.join(missing)}")
        note = step.get("note", "")
        if not isinstance(note, str):
            raise SequenceError(f"Step {index} note must be text")
        check_shapes = step.get("check_shapes") or {}
        if not isinstance(check_shapes, dict) or any(name not in leaves for name in check_shapes):
            raise SequenceError(f"Step {index} check_shapes must replace parts named in that step")
        if not all(isinstance(shape, Shape) and shape.wrapped is not None for shape in check_shapes.values()):
            raise SequenceError(f"Step {index} check_shapes values must be build123d shapes")
        result.append({
            "title": step["title"].strip(), "note": note.strip(), "parts": parts, "leaves": leaves,
            "from": _vector(step.get("from"), f"Step {index} from"), "check_shapes": check_shapes,
        })
    return result


def _box(shape):
    box = shape.bounding_box()
    return [box.min.X, box.min.Y, box.min.Z], [box.max.X, box.max.Y, box.max.Z]


def _meeting_interval(moving, placed, direction, length, gap=0.01):
    """Distances along the path where the moving box overlaps the placed box, or None if they never meet.

    Along a straight path the overlap is a single interval, which can begin after a gap, so the whole
    path is examined rather than stopping where the boxes first stand apart.
    """
    low, high = 0.0, length
    for axis in range(3):
        a_min, a_max = moving[0][axis] - gap, moving[1][axis] + gap
        b_min, b_max = placed[0][axis], placed[1][axis]
        step = direction[axis]
        if abs(step) < 1e-12:
            if not (a_min < b_max and b_min < a_max):
                return None
            continue
        bounds = ((b_max - a_min) / step, (b_min - a_max) / step)
        low, high = max(low, min(bounds)), min(high, max(bounds))
        if low > high:
            return None
    return low, high


def _samples(intervals, sample_mm: float) -> list[float]:
    """Every grid distance inside an interval, plus its midpoint so intervals shorter than the spacing are sampled."""
    distances = set()
    for low, high in intervals:
        distances.add(round((low + high) / 2, 9))
        if low <= 0:
            distances.add(0.0)
        for count in range(math.ceil(low / sample_mm), math.floor(high / sample_mm) + 1):
            distances.add(round(count * sample_mm, 9))
    return sorted(distances)


def _overlap(a, b) -> float:
    """Exact shared volume. A failed boolean is an error, never an empty and therefore clear result."""
    common = BRepAlgoAPI_Common(a.wrapped, b.wrapped)
    # OCCT marks a boolean done only when it finished without errors.
    failed = not common.IsDone()
    volume = 0.0
    if not failed:
        properties = GProp_GProps()
        BRepGProp.VolumeProperties_s(common.Shape(), properties)
        volume = properties.Mass()
        failed = volume < -OVERLAP_TOLERANCE_MM3  # an inside-out result is not a measurement
    if failed:
        raise RuntimeError(f"the B-rep intersection of {a.label or 'a part'} and {b.label or 'a part'} failed")
    return max(volume, 0.0)


def check_steps(steps: list[dict], leaves: dict[str, list], sample_mm: float) -> list[dict]:
    from build123d import Location

    first_step = {}
    for index, step in enumerate(steps):
        for name in step["leaves"]:
            first_step.setdefault(name, index)
    results = []
    for index, step in enumerate(steps):
        moving = set(step["leaves"])
        placed = [(name, shape, _box(shape)) for name, shapes in leaves.items() if name not in moving and first_step.get(name, -1) < index
                  for shape in shapes]
        movers = []
        substitutes = []
        for name in step["leaves"]:
            replacement = step["check_shapes"].get(name)
            if replacement is not None:
                substitutes.append(f"{name} checked as {getattr(replacement, 'label', '') or 'a supplied stand-in'}")
            for shape in [replacement] if replacement is not None else leaves[name]:
                movers.append((name, shape, _box(shape)))
        length = math.hypot(*step["from"])
        direction = [value / length for value in step["from"]] if length else [0.0, 0.0, 0.0]
        result = {"status": "clear", "clearsAt": None, "contacts": []}
        if substitutes:
            result["substitutes"] = substitutes
        pairs = []
        for mover in movers:
            for other in placed:
                interval = _meeting_interval(mover[2], other[2], direction, length)
                if interval is not None:
                    pairs.append((mover, other, interval))
        # Bounding boxes that still overlap at the start offset have no clearance distance to report.
        if pairs and length and all(interval[1] < length for _, _, interval in pairs):
            result["clearsAt"] = round(max(interval[1] for _, _, interval in pairs), 3)
        blocked = set()
        try:
            for distance in _samples([interval for _, _, interval in pairs], sample_mm):
                if len(blocked) == len({name for name, _, _ in movers}):
                    break
                shift = [axis * distance for axis in direction]
                near = [(m, p) for m, p, (low, high) in pairs if low <= distance <= high]
                for (name, shape, _), (blocker, other, _) in near:
                    if name in blocked:
                        continue
                    volume = _overlap(shape.moved(Location(tuple(shift))), other)
                    if volume > OVERLAP_TOLERANCE_MM3:
                        blocked.add(name)
                        result["contacts"].append({"part": name, "blocker": blocker, "atMm": round(distance, 3), "overlapMm3": round(volume, 4)})
                        if distance == 0:
                            result["status"] = "interferes"
                        elif result["status"] == "clear":
                            result["status"] = "blocked"
        except Exception as error:  # OCCT boolean failures surface as many exception types.
            result = {"status": "error", "detail": f"Overlap check failed: {error}"}
        result["detail"] = result.get("detail") or _describe(result, length)
        results.append(result)
    return results


def _describe(result: dict, length: float) -> str:
    if result["status"] == "clear":
        if result["clearsAt"] is not None:
            return f"No overlap; clear of the placed parts' bounding boxes after {result['clearsAt']:g} mm."
        return f"No overlap along the {length:g} mm path." if length else "No overlap when installed."
    first = result["contacts"][0]
    where = "when installed" if first["atMm"] == 0 else f"after {first['atMm']:g} mm"
    return f"{first['part']} overlaps {first['blocker']} {where} ({first['overlapMm3']:g} mm3)."


def build_document(source: Path, step_path: Path, check: bool, sample_mm: float) -> dict:
    if step_path.suffix.lower() not in {".step", ".stp"} or not step_path.is_file():
        raise SequenceError(f"Generate the STEP first; not found: {step_path}")
    if not math.isfinite(sample_mm) or not 0.05 <= sample_mm <= 10:
        raise SequenceError("Sample spacing must be 0.05 to 10 mm")
    module = _load_source(source)
    leaves, groups = labelled_parts(module.gen_step())
    steps = normalize_steps(module.gen_assembly(), groups)
    results = check_steps(steps, leaves, sample_mm) if check else [None] * len(steps)
    document = {
        "format": FORMAT, "version": VERSION, "units": "mm",
        "source": _relative_source(source, step_path),
        "step": {"file": step_path.name, "sha256": hashlib.sha256(step_path.read_bytes()).hexdigest()},
        "steps": [
            {"title": step["title"], **({"note": step["note"]} if step["note"] else {}), "parts": step["parts"], "from": step["from"],
             **({"check": result} if result else {})}
            for step, result in zip(steps, results)
        ],
    }
    if check:
        document["check"] = {"sampleMm": sample_mm, "overlapToleranceMm3": OVERLAP_TOLERANCE_MM3, "limits": LIMITS}
    return document


def _relative_source(source: Path, step_path: Path) -> str:
    """The generator relative to the sequence file, so the file carries no machine-specific folder."""
    try:
        return Path(os.path.relpath(source.resolve(), step_path.resolve().parent)).as_posix()
    except ValueError:  # Windows paths on different drives have no relative form.
        return source.name


def sequence_path(step_path: Path) -> Path:
    return step_path.with_name(f"{step_path.stem}.assembly.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a CAD Explorer assembly-sequence file beside a generated STEP.")
    parser.add_argument("source", type=Path, help="Generator defining gen_step() and gen_assembly()")
    parser.add_argument("--step", type=Path, required=True, help="The STEP generated from that source")
    parser.add_argument("--check", action="store_true", help="Run the rigid interference sweep for every step")
    parser.add_argument("--sample-mm", type=float, default=0.5, help="Sweep sample spacing (default 0.5 mm)")
    args = parser.parse_args(argv)
    try:
        document = build_document(args.source, args.step, args.check, args.sample_mm)
    except SequenceError as error:
        print(str(error), file=sys.stderr)
        return 2
    output = sequence_path(args.step)
    output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    summary = {"file": output.as_posix(), "steps": len(document["steps"])}
    if args.check:
        summary["check"] = [{"step": index, "title": step["title"], "status": step["check"]["status"], "detail": step["check"]["detail"]}
                            for index, step in enumerate(document["steps"], 1)]
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
