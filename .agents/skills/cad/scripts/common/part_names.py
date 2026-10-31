"""Names for the parts of an assembly tree, including the ones nobody labelled.

A part keeps its own label. An unlabelled only child takes its group's name,
and other unlabelled parts are numbered after their group by position, so
``kit`` with two unlabelled solids exports as ``kit 1`` and ``kit 2`` rather
than the STEP writer's ``SOLID``. The STEP writer and the part listings use
the same rule, so a fallback name read back from a STEP file matches the one
it was written with.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TypeVar

Node = TypeVar("Node")


def tree_names(
    root: Node,
    *,
    root_name: str,
    children: Callable[[Node], Sequence[Node]],
    label: Callable[[Node], str | None],
) -> tuple[dict[int, str], list[str]]:
    """Every node's name by ``id(node)``, and the names given to unlabelled leaves."""
    names: dict[int, str] = {}
    unlabelled: list[str] = []

    def visit(node: Node, name: str) -> None:
        names[id(node)] = name
        kids = list(children(node))
        for index, child in enumerate(kids, start=1):
            own = (label(child) or "").strip()
            child_name = own or (name if len(kids) == 1 else f"{name} {index}")
            if not own and not children(child):
                unlabelled.append(child_name)
            visit(child, child_name)

    visit(root, (label(root) or "").strip() or root_name)
    return names, unlabelled
