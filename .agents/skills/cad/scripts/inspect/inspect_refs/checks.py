"""Design checks on a saved STEP: geometry hygiene per part, and clearance between parts."""

from __future__ import annotations

from pathlib import Path

from common.step_targets import CadRefError, cad_path_from_target, resolve_step_target

CLEARANCE_LIMITS = (
    "Rigid exact B-rep distances in the stated poses only: no flexing, threads, gravity or motion between poses. "
    "Pairs whose bounding boxes stay beyond the horizon are reported as at least that far apart."
)


def _step_parts(target: str):
    from common.step_parts import load_step_parts

    cad_path = cad_path_from_target(target)
    resolved = resolve_step_target(cad_path)
    try:
        return load_step_parts(resolved.step_path, cad_path)
    except Exception as exc:
        raise CadRefError(f"Could not read the STEP file for {cad_path}: {exc}") from exc


def _select(step_parts, patterns: list[str] | None):
    from common.step_parts import match_parts

    if not patterns:
        return list(step_parts.parts)
    selected, missing = match_parts(patterns, step_parts.parts)
    if missing:
        raise CadRefError(f"No part is named {', '.join(missing)}; see `inspect parts`.")
    return selected


def hygiene_report(
    target: str,
    *,
    round_radius: float | None = None,
    sliver: float | None = None,
    part_patterns: list[str] | None = None,
) -> dict[str, object]:
    from common.hygiene import DEFAULT_SLIVER, check_part
    from common.step_parts import transform_point

    sliver = DEFAULT_SLIVER if sliver is None else sliver
    if round_radius is not None and round_radius <= 0:
        raise CadRefError("--round must be a positive radius in mm.")
    if sliver <= 0:
        raise CadRefError("--sliver must be a positive width in mm.")
    step_parts = _step_parts(target)
    selected = _select(step_parts, part_patterns)
    by_shape: dict[int, list] = {}
    for part in selected:
        by_shape.setdefault(part.prototype_key, []).append(part)
    reports: list[dict[str, object]] = []
    total = 0
    for parts in by_shape.values():
        first = parts[0]
        try:
            hygiene = check_part(first.prototype, round_radius=round_radius, sliver=sliver)
        except Exception as exc:  # a kernel failure on one part must not hide the others
            reports.append({"name": first.name, "path": first.path, "ref": step_parts.ref(first), "error": f"could not check: {exc}"})
            continue
        findings = []
        for finding in hygiene.findings:
            refs = [step_parts.ref(first, f"e{n}") for n in finding.edges] + [step_parts.ref(first, f"f{n}") for n in finding.faces]
            entry: dict[str, object] = {"check": finding.check, "message": finding.message, "refs": refs}
            if finding.at is not None:
                entry["at"] = transform_point(first.transform, finding.at)
            if finding.value is not None:
                entry["value"] = finding.value
            findings.append(entry)
        total += len(findings)
        reports.append({
            "name": first.name,
            "path": first.path,
            "ref": step_parts.ref(first),
            "sameShape": [part.path for part in parts[1:]],
            "summary": {
                "solids": hygiene.solids,
                "faces": hygiene.faces,
                "edges": hygiene.edges,
                "convexEdges": hygiene.convex_edges,
                "sharpEdges": hygiene.sharp_edges,
                "rounds": hygiene.rounds,
                "smallestRound": None if hygiene.smallest_round is None else round(hygiene.smallest_round, 4),
            },
            "findings": findings,
        })
    errors = [{"message": f"{report['path']}: {report['error']}", "ref": report["ref"]} for report in reports if "error" in report]
    return {
        "ok": True,
        "cadPath": step_parts.cad_path,
        "clean": total == 0 and not errors,  # a part that could not be checked is not clean
        "errors": errors,
        "roundRadius": round_radius,
        "sliver": sliver,
        "findingCount": total,
        "parts": reports,
    }


def clearance_report(
    target: str,
    *,
    poses_source: Path | None = None,
    part_patterns: list[str] | None = None,
    min_gap: float | None = None,
    horizon: float | None = None,
) -> dict[str, object]:
    from common.clearance import DEFAULT_HORIZON, PoseError, check_clearance, pair_status, read_pose_set

    horizon = DEFAULT_HORIZON if horizon is None else horizon
    if horizon <= 0:
        raise CadRefError("--horizon must be a positive distance in mm.")
    step_parts = _step_parts(target)
    if len(step_parts.parts) < 2:
        raise CadRefError(f"{step_parts.cad_path} has one part; clearance needs two or more.")
    selected = _select(step_parts, part_patterns) if part_patterns else None
    raw_poses = _generator_poses(poses_source) if poses_source is not None else None
    try:
        pose_set = read_pose_set(raw_poses, step_parts, selected=selected, min_gap=min_gap)
    except PoseError as exc:
        raise CadRefError(str(exc)) from exc
    if not pose_set.pairs:
        raise CadRefError("No pairs of parts to check.")
    try:
        results = check_clearance(pose_set, horizon=horizon)
    except Exception as exc:  # kernel failures surface as many exception types; none is a clear result
        raise CadRefError(f"Could not measure clearance in {step_parts.cad_path}: {type(exc).__name__}: {exc}") from exc
    rank = {"overlap": 0, "tight": 1, "touching": 2, "clear": 3}
    pairs = []
    for result in results:
        status = pair_status(result)
        entry: dict[str, object] = {
            "a": result.a.path,
            "b": result.b.path,
            "refs": [step_parts.ref(result.a), step_parts.ref(result.b)],
            "status": status,
            "minGap": result.min_gap,
            "minDistance": None if result.distance is None else round(result.distance, 4),
            "pose": result.pose,
        }
        if result.distance is None:
            entry["atLeast"] = round(result.at_least or horizon, 3)
        if result.points is not None and result.distance and result.distance > 1e-9:
            entry["points"] = result.points
        if result.overlap_poses:
            entry["overlapMm3"] = round(result.overlap, 4)
            entry["overlapPose"] = result.overlap_pose
            entry["overlapPoses"] = result.overlap_poses
        if result.touching_poses:
            entry["touchingPoses"] = result.touching_poses
        entry["measuredPoses"] = result.measured
        pairs.append(entry)
    pairs.sort(key=lambda pair: (rank[str(pair["status"])], pair["minDistance"] if pair["minDistance"] is not None else float("inf")))
    failing = {"overlap", "tight"}
    return {
        "ok": True,
        "cadPath": step_parts.cad_path,
        "clean": not any(pair["status"] in failing for pair in pairs),
        "minGap": pose_set.min_gap,
        "horizon": horizon,
        "poses": ["as assembled", *(name for name, _ in pose_set.poses)],
        "pairs": pairs,
        "limits": CLEARANCE_LIMITS,
    }


def _generator_poses(source: Path) -> object:
    from common.generator_module import GeneratorImportError, MissingGeneratorError, call_generator, load_generator

    if source.suffix != ".py" or not source.is_file():
        raise CadRefError(f"Pose generator not found: {source}")
    try:
        return call_generator(load_generator(source), "gen_poses", script_path=source)
    except (GeneratorImportError, MissingGeneratorError) as exc:
        raise CadRefError(str(exc)) from exc
    except Exception as exc:
        raise CadRefError(f"{source} gen_poses() failed: {type(exc).__name__}: {exc}") from exc


def format_hygiene_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    limit = None if verbose else 8
    radius = result.get("roundRadius")
    lines = [
        f"{result.get('cadPath')}: {result.get('findingCount')} finding(s)"
        + (f", comfort radius {radius:g} mm" if isinstance(radius, (int, float)) else ", sharp edges counted only (pass --round MM to report them)")
    ]
    for part in result.get("parts", []):
        if not isinstance(part, dict):
            continue
        same = part.get("sameShape") or []
        title = f"{part.get('path')}" + (f" (and {len(same)} more of the same shape)" if same else "")
        if "error" in part:
            lines.append(f"  {title}: {part['error']}")
            continue
        summary = part.get("summary", {})
        findings = part.get("findings", [])
        lines.append(
            f"  {title}: {len(findings)} finding(s); {summary.get('sharpEdges')} sharp of {summary.get('convexEdges')} convex edges, "
            f"{summary.get('rounds')} rounds" + (f" (smallest {summary['smallestRound']:g} mm)" if summary.get("smallestRound") else "")
        )
        if quiet:
            continue
        by_check: dict[str, list[dict[str, object]]] = {}
        for finding in findings:
            by_check.setdefault(str(finding["check"]), []).append(finding)
        for check, items in by_check.items():
            shown = items if limit is None else items[:limit]
            for finding in shown:
                refs = " ".join(str(ref) for ref in finding.get("refs", [])[:4])
                at = f" at {tuple(finding['at'])}" if finding.get("at") else ""
                lines.append(f"    {check}: {part.get('name')} {finding['message']}{at}  {refs}".rstrip())
            if len(items) > len(shown):
                lines.append(f"    ... {len(items) - len(shown)} more {check} finding(s); --verbose lists all")
    return "\n".join(lines)


def format_clearance_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    gap = result.get("minGap")
    poses = result.get("poses") or []
    lines = [
        f"{result.get('cadPath')}: {len(result.get('pairs', []))} pair(s) over {len(poses)} pose(s)"
        + (f", minimum gap {gap:g} mm" if isinstance(gap, (int, float)) else "")
    ]
    for pair in result.get("pairs", []):
        if not isinstance(pair, dict):
            continue
        status = pair["status"]
        if quiet and status in {"clear", "touching"}:
            continue
        name = f"{pair['a']} / {pair['b']}"
        if status == "overlap":
            extra = len(pair.get("overlapPoses", [])) - 1
            detail = f"overlap {pair['overlapMm3']:g} mm3 in {pair['overlapPose']!r}" + (f" and {extra} more pose(s)" if extra > 0 else "")
        elif pair.get("minDistance") is None:
            detail = f"clear by at least {pair['atLeast']:g} mm"
        elif pair["minDistance"] <= 1e-9:
            detail = f"touching in {len(pair.get('touchingPoses', []))} pose(s), first {pair.get('touchingPoses', ['?'])[0]!r}"
            if status == "tight":
                detail += f", needs {pair['minGap']:g} mm"
        else:
            detail = f"{pair['minDistance']:g} mm at {pair['pose']!r}"
            if status == "tight":
                detail += f", needs {pair['minGap']:g} mm"
            if verbose and pair.get("points"):
                detail += f" between {tuple(pair['points'][0])} and {tuple(pair['points'][1])}"
        lines.append(f"  {status:8} {name}: {detail}")
    if not quiet:
        lines.append(f"  limits: {result.get('limits')}")
    return "\n".join(lines)
