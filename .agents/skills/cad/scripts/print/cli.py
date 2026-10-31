"""Print handoff CLI: Bambu Studio projects, slice checks and print-orientation checks."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from .bambu import BambuStudio, BambuStudioError
from .bambu3mf import write_project
from .job import JobError, load_job
from .meshes import MeshError, load_mesh
from .orientation import CheckSettings, check_orientation
from .plan import PlanError, ProjectPlan, plan_project
from .profile import PROFILE_PATH, ProfileError, load_profile
from .report import check_lines, plan_dict, plan_lines, slice_lines
from .slicing import SliceReport, slice_project


def _emit(args: argparse.Namespace, lines: list[str], data: dict) -> None:
    if args.format == "json":
        print(json.dumps(data, indent=2, default=str))
    else:
        print("\n".join(lines))


def _cross_check(report: SliceReport, plan: ProjectPlan) -> None:
    """Warn when a plate whose parts need support sliced without any."""
    for plate in report.plates:
        if plate.error or plate.support_seconds:
            continue
        expected = [
            plan.instance_name(i) for i in plan.plates[plate.plate - 1].instances
            if plan.parts[i.part].spec.support and plan.parts[i.part].check.needs_support
        ]
        if expected:
            plate.warnings.append(f"no support was generated although {', '.join(expected)} need(s) it")


def _project(args: argparse.Namespace) -> int:
    part = {}
    if args.rotate is not None:
        part["rotate"] = args.rotate
    for key in ("copies", "filament", "colour"):
        if getattr(args, key) is not None:
            part[key] = getattr(args, key)
    if args.no_support:
        part["support"] = False
    job = load_job(Path(args.target), part or None)
    profile = load_profile(job.profile)
    studio = BambuStudio.locate(profile.bambu_studio)
    output = Path(args.output).resolve() if args.output else job.output
    if output.suffix.lower() != ".3mf":
        raise JobError(f"The project must be a .3mf file, not {output.name}")
    plan = plan_project(job, profile, studio)
    write_project(plan, output)
    lines = plan_lines(plan)
    data = plan_dict(plan, output)
    status = 0
    if args.slice:
        report = slice_project(studio, output)
        _cross_check(report, plan)
        lines += slice_lines(report)
        data["slice"] = report.as_dict()
        status = 0 if report.ok else 1
    if args.open:
        studio.open(output)
        lines.append("Opened in Bambu Studio.")
    lines.append(f"3MF: {output}")
    _emit(args, lines, data)
    return status


def _slice(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    if not project.is_file():
        raise BambuStudioError(f"Project not found: {project}")
    studio = BambuStudio.locate(_configured_studio())
    report = slice_project(studio, project)
    lines = slice_lines(report)
    if args.open:
        studio.open(project)
        lines.append("Opened in Bambu Studio.")
    lines.append(f"3MF: {project}")
    _emit(args, lines, report.as_dict())
    return 0 if report.ok else 1


def _configured_studio() -> str | None:
    """The profile's Bambu Studio path when there is a profile; slicing a project needs no other setting."""
    try:
        return load_profile().bambu_studio
    except ProfileError:
        return None


def _check(args: argparse.Namespace) -> int:
    profile = load_profile()
    presets = BambuStudio.locate(profile.bambu_studio).presets()
    settings = {**presets.flat("machine", profile.printer), **presets.flat("process", profile.process), **profile.process_settings}
    checks = CheckSettings.from_settings(settings, bridge_review_mm=args.bridge_limit)
    path = Path(args.file).resolve()
    mesh = load_mesh(path).oriented(tuple(args.rotate or (0.0, 0.0, 0.0)))
    report = check_orientation(mesh, checks)
    rotate = " ".join(f"{v:g}" for v in (args.rotate or (0, 0, 0)))
    lines = check_lines(f"{path.name} (rotate {rotate})", report)
    lines.append(f"  measured with {profile.process}: {checks.layer_height:g} mm layers, {checks.line_width:g} mm lines")
    _emit(args, lines, {"file": str(path), "rotate": list(args.rotate or (0, 0, 0)), **report.as_dict()})
    return 0


def _coupon(args: argparse.Namespace) -> int:
    from .coupon import write_ladder

    output = Path(args.output).resolve()
    try:
        rungs, peg = write_ladder(output, args.diameter, args.clearances, args.depth, args.peg)
    except ValueError as error:
        raise JobError(str(error)) from error
    lines = [f"Wrote a fit ladder for a {args.diameter:g} mm part, holes printed upright through {args.depth:g} mm:"]
    lines += [
        f"  {rung.marks} dimple{'s' if rung.marks > 1 else ''}: hole {rung.hole_mm:g} mm ({rung.clearance_mm:+g} mm diametral clearance)"
        for rung in rungs
    ]
    lines.append(f"STEP: {output}")
    if peg is not None:
        lines.append(f"Peg STEP: {peg}")
    data = {"step": str(output), "peg": str(peg) if peg else None, "rungs": [vars(rung) for rung in rungs]}
    _emit(args, lines, data)
    return 0


def _profile(args: argparse.Namespace) -> int:
    profile = load_profile()
    studio = BambuStudio.locate(profile.bambu_studio)
    presets = studio.presets()
    presets.require("machine", profile.printer)
    presets.require("process", profile.process)
    for filament in profile.filaments.values():
        presets.require("filament", filament.preset)
    lines = [f"Print profile {PROFILE_PATH}", json.dumps(profile.as_dict(), indent=2), f"Bambu Studio: {studio.executable}", "Every preset name exists in this installation."]
    _emit(args, lines, {"path": str(PROFILE_PATH), "bambu_studio": str(studio.executable), **profile.as_dict()})
    return 0


def _presets(args: argparse.Namespace) -> int:
    presets = BambuStudio.locate(_configured_studio()).presets()
    words = [word.lower() for word in args.query]
    kinds = [args.kind] if args.kind else ["machine", "process", "filament"]
    found = {
        kind: [name for name in presets.names(kind) if all(word in name.lower() for word in words) and not name.startswith("fdm_")]
        for kind in kinds
    }
    lines = [f"{kind}: {name}" for kind, names in found.items() for name in names] or ["No presets match."]
    _emit(args, lines, found)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="scripts/print", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    def add(name: str, help_text: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help_text, description=help_text)
        sub.add_argument("--format", choices=("text", "json"), default="text")
        return sub

    project = add("project", "Write a Bambu Studio project 3MF from a print job file or a single STEP/STL part.")
    project.add_argument("target", help="A *.print.json job file, or one STEP/STP/STL part for a single plate.")
    project.add_argument("-o", "--output", help="The .3mf to write (default: the job's output, else beside the target).")
    project.add_argument("--rotate", nargs=3, type=float, metavar=("X", "Y", "Z"), help="Single part: degrees about X, then Y, then Z.")
    project.add_argument("--copies", type=int, help="Single part: how many to print.")
    project.add_argument("--filament", help="Single part: a filament named in the print profile.")
    project.add_argument("--colour", help="Single part: filament colour as #RRGGBB.")
    project.add_argument("--no-support", action="store_true", help="Single part: print without support.")
    project.add_argument("--slice", action="store_true", help="Slice every plate with Bambu Studio's command line and report it.")
    project.add_argument("--open", action="store_true", help="Open the project in the Bambu Studio app.")
    project.set_defaults(run=_project)

    check = add("check", "Measure one part in a print orientation: bed contact, support, bridges and thin walls.")
    check.add_argument("file", help="A STEP, STP or STL part.")
    check.add_argument("--rotate", nargs=3, type=float, metavar=("X", "Y", "Z"), help="Degrees about X, then Y, then Z.")
    check.add_argument("--bridge-limit", type=float, default=5.0, help="Flag bridges spanning at least this many mm (default 5).")
    check.set_defaults(run=_check)

    sliced = add("slice", "Slice a Bambu Studio project and report each plate's time, filament and warnings.")
    sliced.add_argument("project", help="A Bambu Studio project .3mf.")
    sliced.add_argument("--open", action="store_true", help="Open the project in the Bambu Studio app.")
    sliced.set_defaults(run=_slice)

    coupon = add("coupon", "Write a fit-coupon ladder STEP: round holes stepping through clearances, marked with dimple counts.")
    coupon.add_argument("-o", "--output", required=True, help="The STEP to write, such as coupons/pin-ladder.step.")
    coupon.add_argument("--diameter", type=float, required=True, help="Nominal diameter of the mating part (mm).")
    coupon.add_argument("--clearances", type=float, nargs="+", required=True, help="Diametral clearances to try (mm), such as 0.1 0.2 0.3 0.4.")
    coupon.add_argument("--depth", type=float, default=6.0, help="Hole depth: how far the part engages (mm, default 6).")
    coupon.add_argument("--peg", action="store_true", help="Also write a peg at the nominal diameter as <name>-peg.step.")
    coupon.set_defaults(run=_coupon)

    profile = add("profile", f"Show the personal print profile ({PROFILE_PATH}) and check its presets exist.")
    profile.set_defaults(run=_profile)

    presets = add("presets", "List the installed Bambu Studio system presets whose names contain every word given.")
    presets.add_argument("query", nargs="*", help="Words to match, such as: H2D 0.4 PETG")
    presets.add_argument("--kind", choices=("machine", "process", "filament"))
    presets.set_defaults(run=_presets)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    try:
        return args.run(args)
    except (BambuStudioError, JobError, MeshError, PlanError, ProfileError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
