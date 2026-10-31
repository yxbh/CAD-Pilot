"""A STEP file's parts as native shapes, with the names checks and refs use.

Names follow ``part_names``: a part's label, or a fallback after its group.
Patterns match like CAD Explorer's assembly steps: ``*`` and ``?`` are the only
wildcards, and the name of a group someone labelled covers every part in it.
This module is the matcher's home; CAD Explorer's assembly sequences are to
import it rather than keep their own copy.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from common.part_names import tree_names


@dataclass(frozen=True)
class StepPart:
    occurrence_id: str
    name: str
    groups: tuple[str, ...]  # enclosing groups someone labelled, outermost first
    prototype_key: int
    prototype: object  # the part's shape in its own frame
    placed: object  # the part's shape where the STEP places it
    transform: tuple[float, ...]

    @property
    def path(self) -> str:
        return "/".join((*self.groups, self.name))


@dataclass(frozen=True)
class StepParts:
    cad_path: str
    parts: tuple[StepPart, ...]

    def selector(self, part: StepPart, entity: str = "") -> str:
        """An ``@cad`` selector, shortened as ``inspect refs`` shortens it when the STEP has one part."""
        if not entity:
            return part.occurrence_id
        return entity if len(self.parts) == 1 else f"{part.occurrence_id}.{entity}"

    def ref(self, part: StepPart, entity: str = "") -> str:
        from common.cad_ref_syntax import build_cad_token

        return build_cad_token(self.cad_path, self.selector(part, entity))


def load_step_parts(step_path: Path, cad_path: str) -> StepParts:
    from common.step_scene import load_step_scene, occurrence_selector_id, scene_occurrence_shape

    scene = load_step_scene(step_path)
    root = _Root(scene.roots)
    names, _ = tree_names(
        root,
        root_name=Path(cad_path).name,
        children=lambda node: node.children,
        label=lambda node: node.name or node.source_name,
    )
    parts: list[StepPart] = []

    def visit(node, groups: tuple[str, ...]) -> None:
        name = names[id(node)]
        if node.prototype_key is not None and node.prototype_key in scene.prototype_shapes:
            parts.append(StepPart(
                occurrence_id=occurrence_selector_id(node),
                name=name,
                groups=groups,
                prototype_key=node.prototype_key,
                prototype=scene.prototype_shapes[node.prototype_key],
                placed=scene_occurrence_shape(scene, node),
                transform=tuple(node.transform),
            ))
        inner = (*groups, name) if (node.name or node.source_name) else groups
        for child in node.children:
            visit(child, inner)

    for top in scene.roots:
        visit(top, ())
    return StepParts(cad_path=cad_path, parts=tuple(parts))


class _Root:
    """The STEP file itself, as the group holding its top-level shapes."""

    name = None
    source_name = None

    def __init__(self, children) -> None:
        self.children = list(children)


def label_pattern(glob: str) -> re.Pattern[str]:
    return re.compile("".join(".*" if char == "*" else "." if char == "?" else re.escape(char) for char in glob), re.DOTALL)


def match_parts(patterns: list[str], parts: tuple[StepPart, ...]) -> tuple[list[StepPart], list[str]]:
    """The parts that patterns name, in STEP order, and the patterns that name nothing."""
    matched: set[str] = set()
    missing: list[str] = []
    for pattern in patterns:
        matcher = label_pattern(pattern)
        hits = [part for part in parts if any(matcher.fullmatch(name) for name in (*part.groups, part.name))]
        if not hits:
            missing.append(pattern)
        matched.update(part.occurrence_id for part in hits)
    return [part for part in parts if part.occurrence_id in matched], missing


def transform_point(transform: tuple[float, ...], point) -> list[float]:
    x, y, z = point
    return [
        round(transform[0] * x + transform[1] * y + transform[2] * z + transform[3], 3),
        round(transform[4] * x + transform[5] * y + transform[6] * z + transform[7], 3),
        round(transform[8] * x + transform[9] * y + transform[10] * z + transform[11], 3),
    ]
