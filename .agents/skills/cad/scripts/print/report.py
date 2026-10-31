"""Plain-text and JSON reports of print plans, orientation checks and slice checks."""

from __future__ import annotations

from pathlib import Path

from .orientation import OrientationReport
from .plan import ProjectPlan
from .slicing import SliceReport


def duration(seconds: float) -> str:
    minutes = round(seconds / 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min" if hours else f"{minutes} min"


def _short(preset: str) -> str:
    """'Bambu PETG Basic @BBL H2D 0.4 nozzle' -> 'Bambu PETG Basic'."""
    return preset.split(" @", 1)[0]


def check_lines(name: str, report: OrientationReport) -> list[str]:
    w, d, h = report.size_mm
    lines = [
        f"{name}: {w} x {d} x {h} mm as printed; bed contact {report.bed_contact_mm2} mm² in {report.bed_contact_islands} "
        f"island(s); overhang past {report.limits['review_tilt_deg']:g}° {report.overhang_review_mm2} mm²; "
        f"needs support (past {report.limits['support_beyond_tilt_deg']:g}° from vertical) {report.needs_support_mm2} mm²",
    ]
    for region in report.support_regions:
        lines.append(f"    support region {region.area_mm2} mm² at print height {region.print_z_mm[0]}–{region.print_z_mm[1]} mm near model {region.model_xyz_mm}")
    for underside in report.undersides:
        span = f"spans {underside.span_mm} mm" if underside.kind == "bridge" else (f"reaches {underside.span_mm} mm out" if underside.span_mm is not None else "held by nothing below")
        above = f", {underside.thickness_mm} mm thick above" if underside.thickness_mm is not None else ""
        lines.append(f"    flat underside ({underside.kind}) at print height {underside.print_z_mm} mm, {underside.area_mm2} mm², {span}{above}")
    walls = report.wall_check
    lines.append(
        f"    walls: {walls['thin_places']} place(s) under {walls['limit_mm']} mm in {walls['layers_sampled']} sampled layers "
        f"(pitch {walls['pitch_mm']} mm)"
    )
    lines += [f"    ! {flag}" for flag in report.flags]
    return lines


def plan_lines(plan: ProjectPlan) -> list[str]:
    profile = plan.profile
    lines = [
        f"Wrote {plan.job.name}: {len(plan.plates)} plate(s), {sum(len(p.instances) for p in plan.plates)} object(s)",
        f"  {profile.printer} · {profile.process} · {profile.bed_type} · Bambu Studio {plan.version}",
        f"  supports {profile.support_type} where needed"
        + (f", {plan.profile.support_interface} interface with no gap" if any(p.uses_interface for p in plan.parts) else ""),
    ]
    interface = plan.settings.get("support_interface_filament")
    for slot in plan.slots:
        roles = ["parts"] if any(p.slot is slot for p in plan.parts) else []
        roles += ["support interface"] if interface == str(slot.number) else []
        lines.append(f"  filament {slot.number}: {_short(slot.preset)} ({slot.material}) {slot.colour} for {' and '.join(roles)}")
    for number, plate in enumerate(plan.plates, start=1):
        names = ", ".join(plan.instance_name(i) + (" (turned 90°)" if i.turned else "") for i in plate.instances)
        tower = "; prime tower kept clear" if plate.tower else ""
        lines.append(f"  plate {number} \"{plate.name}\": {names}{tower}")
    lines.append("Parts as printed:")
    seen = set()
    for part in plan.parts:
        key = (part.spec.file, part.spec.rotate)
        if key in seen:
            continue
        seen.add(key)
        rotate = " ".join(f"{v:g}" for v in part.spec.rotate)
        lines += [f"  {line}" for line in check_lines(f"{part.spec.name} ({part.spec.file.name}, rotate {rotate})", part.check)]
        if not part.spec.support and part.check.needs_support:
            lines.append(f"    ! support is off for {part.spec.name} but {part.check.needs_support_mm2} mm² of it needs support")
    return lines


def slice_lines(report: SliceReport) -> list[str]:
    lines = [f"Slice check with Bambu Studio {report.version} ({report.printer} · {report.process} · {report.bed_type}): {report.elapsed_seconds:.1f} s"]
    total_seconds = 0.0
    total_grams = 0.0
    for plate in report.plates:
        title = f"  plate {plate.plate} \"{plate.name}\""
        if plate.error:
            lines.append(f"{title}: FAILED: {plate.error}")
            lines += [f"    ! FAILED: {conflict}" for conflict in plate.conflicts]
            continue
        total_seconds += plate.seconds or 0.0
        used = ", ".join(f"{_short(f.preset)} {f.colour} {f.grams:g} g" for f in plate.filaments)
        total_grams += sum(f.grams for f in plate.filaments)
        extras = []
        if plate.support_seconds:
            extras.append(f"support {duration(plate.support_seconds)}")
        if plate.prime_tower:
            extras.append("prime tower")
        lines.append(f"{title}: {duration(plate.seconds or 0.0)}; {used}" + (f"; {', '.join(extras)}" if extras else ""))
        lines += [f"    ! {warning}" for warning in plate.warnings]
        lines += [f"    ! FAILED: {conflict}" for conflict in plate.conflicts]
    lines.append(f"  total: {duration(total_seconds)}, {total_grams:.1f} g" + ("" if report.ok else "; some plates FAILED"))
    return lines


def plan_dict(plan: ProjectPlan, path: Path) -> dict:
    return {
        "project": str(path),
        "name": plan.job.name,
        "bambu_studio": plan.version,
        "profile": plan.profile.as_dict(),
        "filaments": [
            {"slot": s.number, "key": s.key, "preset": s.preset, "material": s.material, "colour": s.colour} for s in plan.slots
        ],
        "plates": [
            {
                "plate": number,
                "name": plate.name,
                "prime_tower": plate.tower is not None,
                "objects": [
                    {
                        "name": plan.instance_name(i),
                        "file": str(plan.parts[i.part].spec.file),
                        "filament_slot": plan.parts[i.part].slot.number,
                        "bed_xy_mm": [round(i.rect.x0, 2), round(i.rect.y0, 2)],
                        "turned": i.turned,
                        "settings": plan.parts[i.part].object_settings,
                    }
                    for i in plate.instances
                ],
            }
            for number, plate in enumerate(plan.plates, start=1)
        ],
        "parts": [
            {"name": p.spec.name, "file": str(p.spec.file), "rotate": list(p.spec.rotate), "support": p.spec.support, "check": p.check.as_dict()}
            for p in plan.parts
        ],
    }
