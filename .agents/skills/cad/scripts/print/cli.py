"""Print handoff CLI: Bambu Studio projects, slice checks and print-orientation checks."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from common.paths import command_line_path

from .bambu import BambuStudio, BambuStudioError
from .bambu3mf import write_project
from .compensation import conditions
from .job import JobError, load_job, parse_job
from .meshes import MeshError, load_mesh
from .orientation import check_orientation
from .plan import PlanError, ProjectPlan, check_settings, plan_project
from .profile import COMPENSATION_SETTINGS, PROFILE_PATH, Measurement, ProfileError, load_profile, record_compensation
from .report import check_lines, plan_dict, plan_lines, slice_lines
from .slicing import SliceReport, project_contents, slice_project


def _path(value: str) -> Path:
    """A command-line path, read as the other cad tools read them."""
    try:
        return command_line_path(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


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
    job = load_job(args.target, part or None)
    profile = load_profile(job.profile)
    studio = BambuStudio.locate(profile.bambu_studio)
    output = args.output or job.output
    if output.suffix.lower() != ".3mf":
        raise JobError(f"The project must be a .3mf file, not {output.name}")
    return _hand_off(args, studio, plan_project(job, profile, studio), output)


def _hand_off(args: argparse.Namespace, studio: BambuStudio, plan: ProjectPlan, output: Path, lines: Sequence[str] = (), data: dict | None = None) -> int:
    """Write the project, slice and open it as asked, and report it with its path last."""
    write_project(plan, output)
    lines = [*lines, *plan_lines(plan)]
    data = {**(data or {}), **plan_dict(plan, output)}
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
    project = args.project
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
    checks = check_settings(BambuStudio.locate(profile.bambu_studio).presets, profile, bridge_review_mm=args.bridge_limit)
    path = args.file
    mesh = load_mesh(path).oriented(tuple(args.rotate or (0.0, 0.0, 0.0)))
    report = check_orientation(mesh, checks)
    rotate = " ".join(f"{v:g}" for v in (args.rotate or (0, 0, 0)))
    lines = check_lines(f"{path.name} (rotate {rotate})", report)
    lines.append(f"  measured with {profile.process}: {checks.layer_height:g} mm layers, {checks.line_width:g} mm lines")
    _emit(args, lines, {"file": str(path), "rotate": list(args.rotate or (0, 0, 0)), **report.as_dict()})
    return 0


def _coupon(args: argparse.Namespace) -> int:
    from .coupon import write_ladder

    if args.calibrate:
        return _calibration_coupon(args)
    if args.clearances is None:
        raise JobError("a fit ladder needs --clearances; a calibration ladder needs --calibrate holes or pegs")
    if args.values or args.filament or args.slice or args.open:
        raise JobError("--values, --filament, --slice and --open apply to a calibration ladder (--calibrate)")
    output = args.output
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


def _calibration_coupon(args: argparse.Namespace) -> int:
    from .coupon import DEFAULT_VALUES, MEASURES, write_calibration_ladder

    if args.clearances is not None or args.peg:
        raise JobError("--clearances and --peg make a fit ladder; leave them out with --calibrate")
    if args.output.suffix.lower() not in {".step", ".stp"}:
        raise JobError(f"the ladder is written as a STEP file, not {args.output.name}")
    profile = load_profile()
    filament = _filament(profile, args.filament)
    studio = BambuStudio.locate(profile.bambu_studio)
    kind, measures = args.calibrate, MEASURES[args.calibrate]
    values = args.values or list(DEFAULT_VALUES[kind])
    try:
        rungs = write_calibration_ladder(args.output, kind, args.diameter, values, args.depth)
    except ValueError as error:
        raise JobError(str(error)) from error
    job = parse_job(
        {"name": f"{filament} {measures} compensation coupon", "parts": [{"file": args.output.name, "filament": filament}]},
        base=args.output.parent,
        default_output=args.output.with_suffix(".3mf"),
    )
    plan = plan_project(job, profile, studio, calibrating=True)
    now = conditions(plan.settings)
    shape = "hole" if kind == "holes" else "peg"
    lines = [
        f"Wrote a {measures} compensation ladder for a real part {args.diameter:g} mm across, in {filament} on the "
        f"{profile.printer}, sliced with hole and contour compensation forced to 0:"
    ]
    lines += [
        f"  {rung.marks} dimple{'s' if rung.marks > 1 else ''}: {shape} {rung.size_mm:g} mm, {measures} compensation {rung.value_mm:g} mm"
        for rung in rungs
    ]
    trial = "try the real part in each hole and pick the one it fits" if kind == "holes" else "try each peg in the real part and pick the one that fits"
    lines.append(
        f"Print it, {trial} snugly without wobble, and save that rung's value with save-compensation {job.output.name} "
        f"--filament {filament} --{measures} <value>. It holds at the resolution ({now['resolution']:g}) and closing radius "
        f"({now['slice_closing_radius']:g}) this coupon slices at."
    )
    lines.append(f"STEP: {args.output}")
    data = {"step": str(args.output), "measures": measures, "rungs": [vars(rung) for rung in rungs]}
    return _hand_off(args, studio, plan, job.output, lines, data)


def _filament(profile, key: str | None) -> str:
    """A filament key of the profile, by default its default filament."""
    filament = key or profile.filament
    if filament not in profile.filaments:
        raise JobError(f"filament {filament!r} is not in the print profile; it has {', '.join(profile.filaments)}")
    return filament


def _save_compensation(args: argparse.Namespace) -> int:
    values = {kind: getattr(args, kind) for kind in COMPENSATION_SETTINGS if getattr(args, kind) is not None}
    if not values:
        raise JobError("give the value to save with --hole, --contour or both")
    profile = load_profile()
    filament = _filament(profile, args.filament)
    # The coupon's project holds the conditions it was sliced at, which the measurement holds at.
    if not args.coupon.is_file():
        raise JobError(f"Coupon project not found: {args.coupon}")
    settings, _ = project_contents(args.coupon)
    printer, presets = settings.get("printer_settings_id"), settings.get("filament_settings_id") or []
    preset = profile.filaments[filament].preset
    if printer != profile.printer or preset not in presets:
        raise JobError(
            f"{args.coupon.name} was made for {printer} with {', '.join(presets)}, not {filament} ({preset}) on the profile's "
            f"{profile.printer}"
        )
    now = conditions(settings)
    today = date.today().isoformat()
    measurements = {kind: Measurement(mm, today, **now) for kind, mm in values.items()}
    before = profile.measured(filament)
    lines = [f"{filament} on the {profile.printer}, measured {today} at resolution {now['resolution']:g} and closing radius {now['slice_closing_radius']:g}:"]
    for kind, measurement in measurements.items():
        was = f"{before[kind].mm:g} mm (measured {before[kind].measured})" if kind in before else "0 mm (unmeasured)"
        lines.append(f"  {kind} compensation: {was} -> {measurement.mm:g} mm")
    record_compensation(filament, profile.printer, measurements, write=args.write)
    if args.write:
        lines.append(f"Saved to {PROFILE_PATH}.")
    else:
        lines.append(f"Nothing written. After the user agrees, run again with --write to save it to {PROFILE_PATH}.")
    data = {"filament": filament, "printer": profile.printer, "written": args.write, **{kind: m.as_dict() for kind, m in measurements.items()}}
    _emit(args, lines, data)
    return 0


def _profile(args: argparse.Namespace) -> int:
    profile = load_profile()
    studio = BambuStudio.locate(profile.bambu_studio)
    presets = studio.presets
    presets.require("machine", profile.printer)
    presets.require("process", profile.process)
    for filament in profile.filaments.values():
        presets.require("filament", filament.preset)
    lines = [f"Print profile {PROFILE_PATH}", json.dumps(profile.as_dict(), indent=2), f"Bambu Studio: {studio.executable}", "Every preset name exists in this installation."]
    _emit(args, lines, {"path": str(PROFILE_PATH), "bambu_studio": str(studio.executable), **profile.as_dict()})
    return 0


def _presets(args: argparse.Namespace) -> int:
    presets = BambuStudio.locate(_configured_studio()).presets
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
    project.add_argument("target", type=_path, help="A *.print.json job file, or one STEP/STP/STL part for a single plate.")
    project.add_argument("-o", "--output", type=_path, help="The .3mf to write (default: the job's output, else beside the target).")
    project.add_argument("--rotate", nargs=3, type=float, metavar=("X", "Y", "Z"), help="Single part: degrees about X, then Y, then Z.")
    project.add_argument("--copies", type=int, help="Single part: how many to print.")
    project.add_argument("--filament", help="Single part: a filament named in the print profile.")
    project.add_argument("--colour", help="Single part: filament colour as #RRGGBB.")
    project.add_argument("--no-support", action="store_true", help="Single part: print without support.")
    project.add_argument("--slice", action="store_true", help="Slice every plate with Bambu Studio's command line and report it.")
    project.add_argument("--open", action="store_true", help="Open the project in the Bambu Studio app.")
    project.set_defaults(run=_project)

    check = add("check", "Measure one part in a print orientation: bed contact, support, bridges and thin walls.")
    check.add_argument("file", type=_path, help="A STEP, STP or STL part.")
    check.add_argument("--rotate", nargs=3, type=float, metavar=("X", "Y", "Z"), help="Degrees about X, then Y, then Z.")
    check.add_argument("--bridge-limit", type=float, default=5.0, help="Flag bridges spanning at least this many mm (default 5).")
    check.set_defaults(run=_check)

    sliced = add("slice", "Slice a Bambu Studio project and report each plate's time, filament and warnings.")
    sliced.add_argument("project", type=_path, help="A Bambu Studio project .3mf.")
    sliced.add_argument("--open", action="store_true", help="Open the project in the Bambu Studio app.")
    sliced.set_defaults(run=_slice)

    coupon = add(
        "coupon",
        "Write a coupon ladder STEP marked with dimple counts: a fit ladder of holes stepping through clearances, or with "
        "--calibrate a hole or peg ladder that measures X-Y compensation, as a project sliced with compensation at 0.",
    )
    coupon.add_argument("-o", "--output", type=_path, required=True, help="The STEP to write, such as coupons/pin-ladder.step.")
    coupon.add_argument("--diameter", type=float, required=True, help="Diameter of the real part it is tried with (mm).")
    coupon.add_argument("--clearances", type=float, nargs="+", help="Fit ladder: diametral clearances to try (mm), such as 0.1 0.2 0.3 0.4.")
    coupon.add_argument("--depth", type=float, default=6.0, help="How far the part engages: hole depth or peg height (mm, default 6).")
    coupon.add_argument("--peg", action="store_true", help="Fit ladder: also write a peg at the nominal diameter as <name>-peg.step.")
    coupon.add_argument("--calibrate", choices=("holes", "pegs"), help="Calibration ladder: holes measure hole compensation, pegs contour compensation.")
    coupon.add_argument("--values", type=float, nargs="+", help="Calibration: compensations to try (mm per side; default holes 0..0.25, pegs -0.15..0.1).")
    coupon.add_argument("--filament", help="Calibration: a filament named in the print profile (default: its default filament).")
    coupon.add_argument("--slice", action="store_true", help="Calibration: slice the project with Bambu Studio's command line and report it.")
    coupon.add_argument("--open", action="store_true", help="Calibration: open the project in the Bambu Studio app.")
    coupon.set_defaults(run=_coupon)

    save = add("save-compensation", "Show, and with --write save, a calibration coupon's result for a filament on the profile's printer.")
    save.add_argument("coupon", type=_path, help="The calibration coupon's project .3mf, which holds the settings it sliced at.")
    save.add_argument("--filament", help="A filament named in the print profile (default: its default filament).")
    save.add_argument("--hole", type=float, help="Hole compensation (mm per side): the value of the hole the real part fits snugly.")
    save.add_argument("--contour", type=float, help="Contour compensation (mm per side): the value of the peg that fits snugly.")
    save.add_argument("--write", action="store_true", help="Write it to the personal print profile; ask the user first.")
    save.set_defaults(run=_save_compensation)

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
