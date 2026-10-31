from __future__ import annotations

import argparse
import contextlib
import io
import json
import shlex
import sys
from pathlib import Path
from typing import Sequence

if __package__ in {None, ""}:
    package_dir = Path(__file__).resolve().parent
    inspect_dir = package_dir.parent
    scripts_dir = inspect_dir.parent
    sys.path = [
        entry
        for entry in sys.path
        if not entry or Path(entry).resolve() != package_dir
    ]
    sys.path.insert(0, str(scripts_dir))
    sys.path.insert(0, str(inspect_dir))
    from inspect_refs.inspect import (
        CadRefError,
        cad_ref_error_payload,
        diff_entry_targets,
        entry_target_from_target,
        inspect_target_frame,
        inspect_cad_refs,
        mate_targets,
        measure_targets,
    )
else:
    from .inspect import (
        CadRefError,
        cad_ref_error_payload,
        diff_entry_targets,
        entry_target_from_target,
        inspect_target_frame,
        inspect_cad_refs,
        mate_targets,
        measure_targets,
    )

from common.cli_logging import CliLogger
from common.issued_refs import note_refs_issued

REF_COMMANDS = {"refs", "hygiene"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="inspect",
        description="Inspect CAD refs, geometry facts, and measurements.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  inspect refs '@cad[STEP/foo#f9]' --detail --facts\n"
            "  inspect measure --from '@cad[STEP/foo#f1]' --to '@cad[STEP/foo#f2]' --axis z\n"
            "  inspect parts outputs/foo.step --format text\n"
            "  inspect hygiene outputs/foo.step --round 0.8 --format text\n"
            "  inspect clearance outputs/foo.step --poses source/foo.py --format text\n"
        ),
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Show detailed progress and timing information.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    refs_parser = subparsers.add_parser(
        "refs",
        help="Resolve whole-entry or selector refs from generated GLB topology.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  inspect refs '@cad[STEP/foo#f9]' --detail --facts\n"
            "  inspect refs '@cad[STEP/foo#f1]' '@cad[STEP/foo#e2]' --positioning\n"
            "  inspect refs --input-file /tmp/prompt.txt --planes\n"
        ),
    )
    refs_parser.add_argument(
        "inputs",
        nargs="*",
        help="One or more @cad[...] refs, CAD paths, STEP paths, or prompt text containing refs.",
    )
    refs_parser.add_argument(
        "--input-file",
        type=Path,
        help="Read token text from a file instead of CLI input or stdin.",
    )
    refs_parser.add_argument(
        "--detail",
        action="store_true",
        help="Include detailed geometry facts for selected face/edge refs.",
    )
    refs_parser.add_argument(
        "--facts",
        action="store_true",
        help="Include compact geometry facts for whole-entry refs and resolved selectors.",
    )
    refs_parser.add_argument(
        "--positioning",
        action="store_true",
        help="Include placement-ready frame, point, plane, axis, and coordinate facts.",
    )
    refs_parser.add_argument(
        "--planes",
        action="store_true",
        help="Include grouped major planar faces for each whole entry.",
    )
    _add_plane_report_arguments(refs_parser)
    refs_parser.add_argument(
        "--topology",
        action="store_true",
        help="Include full face/edge selector lists for whole-entry refs. Expensive on large topology GLBs.",
    )
    _add_output_arguments(refs_parser)
    refs_parser.set_defaults(handler=run_command, compute=_refs, format_text=_format_refs_text)

    diff_parser = subparsers.add_parser(
        "diff",
        help="Compare two CAD STEP refs and summarize selector-level changes.",
    )
    diff_parser.add_argument("left", help="Left CAD STEP path or @cad[...] token.")
    diff_parser.add_argument("right", help="Right CAD STEP path or @cad[...] token.")
    diff_parser.add_argument(
        "--planes",
        action="store_true",
        help="Include major planar face groups for both sides.",
    )
    _add_plane_report_arguments(diff_parser)
    _add_output_arguments(diff_parser)
    diff_parser.set_defaults(handler=run_command, compute=_diff, format_text=_format_diff_text)

    frame_parser = subparsers.add_parser(
        "frame",
        help="Return the world frame for an occurrence or selector's owning occurrence.",
    )
    frame_parser.add_argument("target", help="Single @cad[...] target. Selector optional only for single-root entries.")
    _add_output_arguments(frame_parser)
    frame_parser.set_defaults(handler=run_command, compute=_frame, format_text=_format_frame_text)

    measure_parser = subparsers.add_parser(
        "measure",
        help="Measure signed coordinate distance between two @cad[...] selectors.",
    )
    measure_parser.add_argument("--from", dest="from_target", required=True, help="Moving/source @cad[...] selector.")
    measure_parser.add_argument("--to", dest="to_target", required=True, help="Target @cad[...] selector.")
    measure_parser.add_argument("--axis", choices=("x", "y", "z"), help="Axis to measure along. Inferred when possible.")
    _add_output_arguments(measure_parser)
    measure_parser.set_defaults(handler=run_command, compute=_measure, format_text=_format_measure_text)

    mate_parser = subparsers.add_parser(
        "mate",
        help="Calculate a read-only translation delta for simple selector mating.",
    )
    mate_parser.add_argument("--moving", required=True, help="Moving/source @cad[...] selector.")
    mate_parser.add_argument("--target", required=True, help="Target @cad[...] selector.")
    mate_parser.add_argument("--mode", choices=("flush", "center"), default="flush", help="Mate mode. Default: flush.")
    mate_parser.add_argument("--offset", type=float, default=0.0, help="Offset in mm. For flush, applies along target normal when axis-aligned.")
    mate_parser.add_argument("--axis", choices=("x", "y", "z"), help="Axis to use for flush or one-axis center mating.")
    _add_output_arguments(mate_parser)
    mate_parser.set_defaults(handler=run_command, compute=_mate, format_text=_format_mate_text)

    parts_parser = subparsers.add_parser(
        "parts",
        help="List a STEP's parts with names, sizes, positions and occurrence refs.",
    )
    parts_parser.add_argument("target", help="STEP path or @cad[...] entry.")
    _add_output_arguments(parts_parser)
    parts_parser.set_defaults(handler=run_command, compute=_parts, format_text=_format_parts)

    hygiene_parser = subparsers.add_parser(
        "hygiene",
        help="Check each part for split faces, slivers, extra solids, open or invalid geometry and sharp edges.",
        description=(
            "Per-part geometry hygiene with @cad refs for each finding. Exit status 1 when anything is found. "
            "Sharp convex edges are reported against --round, the project's comfort radius; without it they are only counted."
        ),
    )
    hygiene_parser.add_argument("target", help="STEP path or @cad[...] entry.")
    hygiene_parser.add_argument("--round", type=float, metavar="MM", help="Comfort radius: report convex edges sharper than this.")
    hygiene_parser.add_argument("--sliver", type=float, metavar="MM", help="Report faces thinner and edges shorter than this. Default: 0.05")
    hygiene_parser.add_argument("--parts", nargs="+", metavar="NAME", help="Only these parts (names or * ? patterns; a group covers its parts).")
    _add_output_arguments(hygiene_parser)
    hygiene_parser.set_defaults(handler=run_command, compute=_hygiene, format_text=_format_hygiene)

    clearance_parser = subparsers.add_parser(
        "clearance",
        help="Minimum distance and overlap between parts, as assembled and in the generator's gen_poses().",
        description=(
            "Exact minimum distance and overlap volume between pairs of parts, as assembled and in every pose the "
            "generator's gen_poses() declares. Exit status 1 when parts overlap or come closer than the minimum gap."
        ),
    )
    clearance_parser.add_argument("target", help="STEP path or @cad[...] entry.")
    clearance_parser.add_argument("--poses", type=Path, metavar="GENERATOR", help="Python source whose gen_poses() declares poses.")
    clearance_parser.add_argument("--parts", nargs="+", metavar="NAME", help="Check pairs among these parts only (when gen_poses() names no pairs).")
    clearance_parser.add_argument("--min-gap", type=float, metavar="MM", help="Required clearance; overrides gen_poses()'s min_gap.")
    clearance_parser.add_argument("--horizon", type=float, metavar="MM", help="Measure pairs whose boxes come within this distance. Default: 5")
    _add_output_arguments(clearance_parser)
    clearance_parser.set_defaults(handler=run_command, compute=_clearance, format_text=_format_clearance)

    worker_parser = subparsers.add_parser(
        "worker",
        help="Run a persistent JSONL inspect worker.",
        description=(
            "Read JSONL requests from stdin and write one JSONL response per request. "
            "Each request is an object with argv: [<inspect-subcommand>, ...] and optional id."
        ),
    )
    worker_parser.set_defaults(handler=run_worker)

    batch_parser = subparsers.add_parser(
        "batch",
        help="Run JSONL inspect requests from stdin in one process.",
        description=worker_parser.description,
    )
    batch_parser.set_defaults(handler=run_worker)

    return parser


def _add_output_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--format", choices=("json", "text"), default="json", help="Output format. Default: json.")
    parser.add_argument("--quiet", action="store_true", help="Reduce nonessential output.")
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Include extra human-readable detail where available.",
    )


def _add_plane_report_arguments(
    parser: argparse.ArgumentParser,
    *,
    prefix: str = "plane-",
) -> None:
    coordinate_flags = [f"--{prefix}coordinate-tolerance"]
    area_flags = [f"--{prefix}min-area-ratio"]
    limit_flags = [f"--{prefix}limit"]
    parser.add_argument(
        *coordinate_flags,
        dest="plane_coordinate_tolerance",
        type=float,
        default=1e-3,
        help="Merge planar face groups whose axis coordinate differs by at most this value. Default: 0.001",
    )
    parser.add_argument(
        *area_flags,
        dest="plane_min_area_ratio",
        type=float,
        default=0.05,
        help="Drop planar groups smaller than this fraction of total planar area. Default: 0.05",
    )
    parser.add_argument(
        *limit_flags,
        dest="plane_limit",
        type=int,
        default=12,
        help="Maximum number of plane groups to emit. Default: 12",
    )


def _refs(args: argparse.Namespace) -> dict[str, object]:
    return inspect_cad_refs(
        _read_input_text(args),
        detail=bool(args.detail),
        include_topology=bool(args.topology),
        facts=bool(args.facts),
        positioning=bool(args.positioning),
        planes=bool(args.planes),
        plane_coordinate_tolerance=float(args.plane_coordinate_tolerance),
        plane_min_area_ratio=float(args.plane_min_area_ratio),
        plane_limit=int(args.plane_limit),
    )


def _diff(args: argparse.Namespace) -> dict[str, object]:
    return diff_entry_targets(
        args.left,
        args.right,
        planes=bool(args.planes),
        plane_coordinate_tolerance=float(args.plane_coordinate_tolerance),
        plane_min_area_ratio=float(args.plane_min_area_ratio),
        plane_limit=int(args.plane_limit),
    )


def _frame(args: argparse.Namespace) -> dict[str, object]:
    return inspect_target_frame(args.target)


def _measure(args: argparse.Namespace) -> dict[str, object]:
    return measure_targets(args.from_target, args.to_target, axis=args.axis)


def _mate(args: argparse.Namespace) -> dict[str, object]:
    return mate_targets(args.moving, args.target, mode=args.mode, offset=float(args.offset), axis=args.axis)


def _parts(args: argparse.Namespace) -> dict[str, object]:
    from inspect_refs.parts import list_parts

    return list_parts(args.target)


def _hygiene(args: argparse.Namespace) -> dict[str, object]:
    from inspect_refs.checks import hygiene_report

    return hygiene_report(args.target, round_radius=args.round, sliver=args.sliver, part_patterns=args.parts)


def _clearance(args: argparse.Namespace) -> dict[str, object]:
    from inspect_refs.checks import clearance_report

    return clearance_report(
        args.target,
        poses_source=args.poses,
        part_patterns=args.parts,
        min_gap=args.min_gap,
        horizon=args.horizon,
    )


def _format_parts(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    from inspect_refs.parts import format_parts_text

    return format_parts_text(result, quiet=quiet, verbose=verbose) if result.get("ok") else _format_errors(result)


def _format_hygiene(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    from inspect_refs.checks import format_hygiene_text

    return format_hygiene_text(result, quiet=quiet, verbose=verbose) if result.get("ok") else _format_errors(result)


def _format_clearance(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    from inspect_refs.checks import format_clearance_text

    return format_clearance_text(result, quiet=quiet, verbose=verbose) if result.get("ok") else _format_errors(result)


def _exit_code(result: dict[str, object]) -> int:
    """0 when the command worked and found nothing, 1 when a check found something, 2 on any error.

    A check that could not run on part of the model is an error, not a finding.
    """
    if not bool(result.get("ok")) or result.get("errors"):
        return 2
    return 1 if result.get("clean") is False else 0


def _computed(args: argparse.Namespace) -> dict[str, object]:
    try:
        return args.compute(args)
    except Exception as exc:  # every failure is reported as data with exit status 2, never as a traceback
        return {"ok": False, "errors": [_exception_error_payload(exc)]}


def run_command(args: argparse.Namespace) -> int:
    result = _computed(args)
    _emit_result(args, result, args.format_text)
    if args.command in REF_COMMANDS:
        note_refs_issued(result)
    return _exit_code(result)


def run_worker(args: argparse.Namespace) -> int:
    _ = args
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        response = _worker_response(line)
        print(json.dumps(response, separators=(",", ":")), flush=True)
    return 0


def _worker_response(line: str) -> dict[str, object]:
    request_id: object = None
    try:
        request = json.loads(line)
        argv = _worker_request_argv(request)
        if isinstance(request, dict):
            request_id = request.get("id")
        exit_code, result = inspect_command_result(argv)
    except Exception as exc:
        exit_code = 2
        result = {
            "ok": False,
            "errors": [_exception_error_payload(exc)],
        }
    response: dict[str, object] = {
        "ok": exit_code == 0,
        "exitCode": exit_code,
        "result": result,
    }
    if request_id is not None:
        response["id"] = request_id
    return response


def _worker_request_argv(request: object) -> list[str]:
    if isinstance(request, dict):
        raw_argv = request.get("argv")
    else:
        raw_argv = request
    if isinstance(raw_argv, str):
        return shlex.split(raw_argv)
    if isinstance(raw_argv, list) and all(isinstance(item, (str, int, float)) for item in raw_argv):
        return [str(item) for item in raw_argv]
    raise ValueError("Worker request must be a JSON object with argv, a JSON argv array, or a shell-style argv string.")


def inspect_command_result(argv: Sequence[str]) -> tuple[int, dict[str, object]]:
    command_argv = [str(item) for item in argv]
    if not command_argv:
        return 2, {"ok": False, "errors": [{"message": "empty inspect command"}]}
    if command_argv[0] in {"worker", "batch"}:
        return 2, {"ok": False, "errors": [{"message": f"Unsupported worker command: {command_argv[0]}"}]}
    stderr = io.StringIO()
    try:
        parser = build_parser()
        with contextlib.redirect_stderr(stderr):
            args = parser.parse_args(command_argv)
    except SystemExit as exc:
        return _system_exit_result(exc, stderr=stderr.getvalue())
    if args.command == "refs" and not args.inputs and not args.input_file:
        return 2, {"ok": False, "errors": [{"message": "No input text provided."}]}
    result = _computed(args)
    if args.command in REF_COMMANDS:
        note_refs_issued(result)
    return _exit_code(result), result


def _system_exit_result(exc: SystemExit, *, stderr: str = "") -> tuple[int, dict[str, object]]:
    try:
        exit_code = int(exc.code or 0)
    except (TypeError, ValueError):
        exit_code = 2
    ok = exit_code == 0
    message = stderr.strip() or str(exc)
    return exit_code, {"ok": ok, "errors": [] if ok else [{"message": message}]}


def _exception_error_payload(exc: Exception) -> dict[str, object]:
    if isinstance(exc, CadRefError):
        return cad_ref_error_payload(exc)
    return {
        "type": type(exc).__name__,
        "message": str(exc),
    }


def _emit_result(args: argparse.Namespace, result: dict[str, object], text_formatter) -> None:
    if getattr(args, "format", "json") == "text":
        text = text_formatter(
            result,
            quiet=bool(getattr(args, "quiet", False)),
            verbose=bool(getattr(args, "verbose", False)),
        )
        if text:
            print(text)
        return
    indent = None if bool(getattr(args, "quiet", False)) else 2
    print(json.dumps(result, indent=indent, sort_keys=False))


def _format_refs_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    if not result.get("ok"):
        return _format_errors(result)
    lines: list[str] = []
    for token in result.get("tokens", []):
        if not isinstance(token, dict):
            continue
        summary = token.get("summary") if isinstance(token.get("summary"), dict) else {}
        counted = [
            f"{name}={summary[key]}"
            for name, key in (("faces", "faceCount"), ("edges", "edgeCount"))
            if summary.get(key) is not None
        ]
        lines.append(" ".join([str(token.get("cadPath")), *counted]))
        if quiet:
            continue
        for selection in token.get("selections", []):
            if isinstance(selection, dict):
                lines.append(f"  {selection.get('displaySelector')}: {selection.get('summary')}")
                if verbose and selection.get("copyText"):
                    lines.append(f"    {selection.get('copyText')}")
    return "\n".join(lines)


def _format_diff_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    if not result.get("ok"):
        return _format_errors(result)
    diff = result.get("diff") if isinstance(result.get("diff"), dict) else {}
    fields = ("topologyChanged", "geometryChanged", "bboxChanged", "kindChanged")
    lines = [", ".join(f"{field}={diff.get(field)}" for field in fields)]
    if not quiet:
        lines.append(f"faceDelta={diff.get('faceCountDelta')} edgeDelta={diff.get('edgeCountDelta')}")
    if verbose:
        lines.append(f"sizeDelta={diff.get('sizeDelta')} centerDelta={diff.get('centerDelta')}")
    return "\n".join(lines)


def _format_frame_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    if not result.get("ok"):
        return _format_errors(result)
    frame = result.get("frame") if isinstance(result.get("frame"), dict) else {}
    lines = [f"{result.get('copyText', result.get('cadPath'))} translation={frame.get('translation')}"]
    if verbose and not quiet:
        lines.append(f"localAxes={frame.get('localAxes')}")
    return "\n".join(lines)


def _format_measure_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    if not result.get("ok"):
        return _format_errors(result)
    measurement = result.get("measurement") if isinstance(result.get("measurement"), dict) else {}
    lines = [
        f"axis={result.get('axis')} signed={measurement.get('signedDistance')} absolute={measurement.get('absoluteDistance')}"
    ]
    if verbose and not quiet:
        lines.append(f"euclidean={measurement.get('euclideanDistance')} vector={measurement.get('vectorRelationship')}")
    return "\n".join(lines)


def _format_mate_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    if not result.get("ok"):
        return _format_errors(result)
    mate = result.get("mate") if isinstance(result.get("mate"), dict) else {}
    lines = [f"mode={result.get('mode')} axis={result.get('axis')} translation={mate.get('translationVector')}"]
    if verbose and not quiet:
        lines.append(f"transformTranslationDelta={mate.get('transformTranslationDelta')}")
    return "\n".join(lines)


def _format_errors(result: dict[str, object]) -> str:
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    messages = [str(error.get("message")) for error in errors if isinstance(error, dict) and error.get("message")]
    return "\n".join(messages) if messages else "error"


def _read_input_text(args: argparse.Namespace) -> str:
    raw_inputs = [str(value) for value in getattr(args, "inputs", ()) if str(value).strip()]
    input_sources = sum(1 for source in (args.input_file, raw_inputs) if source)
    if input_sources > 1:
        raise CadRefError("Pass either positional refs/targets or --input-file, not both.")

    if raw_inputs:
        lines: list[str] = []
        for raw_input in raw_inputs:
            parsed = entry_target_from_target(raw_input)
            lines.append(parsed.token)
        text = "\n".join(lines)
    elif args.input_file:
        try:
            text = args.input_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise CadRefError(f"Failed to read input file: {args.input_file}") from exc
    else:
        text = sys.stdin.read()

    if not str(text).strip():
        raise CadRefError("No input text provided.")
    return text


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    command_label = str(getattr(args, "command", "inspect") or "inspect")
    logger = CliLogger("scripts/inspect", verbose=bool(getattr(args, "verbose", False)))
    with logger.timed(command_label):
        return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
