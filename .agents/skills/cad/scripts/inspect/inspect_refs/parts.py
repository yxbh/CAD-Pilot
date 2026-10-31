"""List a STEP's parts: names, sizes and positions, from its indexed topology."""

from __future__ import annotations

from common import cad_ref_syntax as syntax
from common.part_names import tree_names
from common.selector_types import SelectorProfile
from common.step_parts import root_name

from . import lookup
from .inspect import EntryContextProvider, load_entry_context_for_target


def _rounded(values: object, digits: int = 3) -> list[float] | None:
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        return None
    return [round(float(value), digits) for value in values]


def occurrence_names(index: lookup.SelectorIndex, *, root_name: str) -> tuple[dict[str, str], dict[str, str]]:
    """Each occurrence's name and path, by occurrence id.

    Unlabelled occurrences get fallback names; a path runs through the groups
    someone labelled, as part matching does, so an unlabelled top node named
    after the file never prefixes or matches its parts.
    """
    rows = index.occurrences
    children: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        children.setdefault(str(row.get("parentId") or ""), []).append(row)
    by_node, _ = tree_names(
        {"id": "", "name": None},
        root_name=root_name,
        children=lambda row: children.get(str(row.get("id") or ""), []),
        label=lambda row: row.get("name") or row.get("sourceName"),
    )
    names = {str(row["id"]): by_node[id(row)] for row in rows}
    paths: dict[str, str] = {}
    labelled_prefix: dict[str, str] = {}
    for row in rows:  # parents precede their children in the table
        occurrence_id = str(row["id"])
        prefix = labelled_prefix.get(str(row.get("parentId") or ""), "")
        paths[occurrence_id] = f"{prefix}/{names[occurrence_id]}" if prefix else names[occurrence_id]
        labelled_prefix[occurrence_id] = paths[occurrence_id] if (row.get("name") or row.get("sourceName")) else prefix
    return names, paths


def list_parts(target: str, *, context_provider: EntryContextProvider | None = None) -> dict[str, object]:
    context = load_entry_context_for_target(target, profile=SelectorProfile.REFS, context_provider=context_provider)
    index = context.selector_index
    assert index is not None
    names, paths = occurrence_names(index, root_name=root_name(context.cad_path))
    shapes_by_occurrence: dict[str, list[dict[str, object]]] = {}
    for shape in index.shapes:
        shapes_by_occurrence.setdefault(str(shape.get("occurrenceId") or ""), []).append(shape)
    parts: list[dict[str, object]] = []
    for row in index.occurrences:
        occurrence_id = str(row["id"])
        if occurrence_id not in index.leaf_occurrence_ids:
            continue
        bbox = row.get("bbox") if isinstance(row.get("bbox"), dict) else {}
        low, high = _rounded(bbox.get("min")), _rounded(bbox.get("max"))
        shapes = shapes_by_occurrence.get(occurrence_id, [])
        volumes = [float(shape["volume"]) for shape in shapes if isinstance(shape.get("volume"), (int, float))]
        transform = row.get("transform")
        origin = (
            [round(float(transform[i]), 3) for i in (3, 7, 11)]
            if isinstance(transform, (list, tuple)) and len(transform) == 16
            else None
        )
        parts.append({
            "name": names[occurrence_id],
            "labelled": bool(row.get("name") or row.get("sourceName")),
            "path": paths[occurrence_id],
            "ref": syntax.build_cad_token(context.cad_path, occurrence_id),
            "size": [round(high[i] - low[i], 3) for i in range(3)] if low and high else None,
            "center": [round((high[i] + low[i]) / 2, 3) for i in range(3)] if low and high else None,
            "min": low,
            "max": high,
            "origin": origin,
            "solids": sum(1 for shape in shapes if shape.get("kind") == "solid"),
            "volume": round(sum(volumes), 3) if volumes else None,
            "faces": row.get("faceCount"),
        })
    return {"ok": True, "cadPath": context.cad_path, "partCount": len(parts), "parts": parts}


def format_parts_text(result: dict[str, object], *, quiet: bool, verbose: bool) -> str:
    lines = [f"{result.get('cadPath')}: {result.get('partCount')} part(s), sizes and centres in mm"]
    for part in result.get("parts", []):
        if not isinstance(part, dict):
            continue
        size = "x".join(f"{value:g}" for value in part["size"]) if part.get("size") else "?"
        center = ", ".join(f"{value:g}" for value in part["center"]) if part.get("center") else "?"
        solids = part.get("solids")
        extra = "" if solids == 1 else f"  {solids} solids"
        unlabelled = "" if part.get("labelled") else "  (unlabelled)"
        lines.append(f"  {part['ref']}  {part['path']}  size {size}  centre ({center}){extra}{unlabelled}")
        if verbose and not quiet:
            lines.append(f"    min {part.get('min')} max {part.get('max')} origin {part.get('origin')} volume {part.get('volume')}")
    return "\n".join(lines)
