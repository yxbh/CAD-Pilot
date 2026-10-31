"""Names for the parts of an assembly tree, including the ones nobody labelled.

A part keeps its own label. An unlabelled only child takes its group's name,
and other unlabelled parts are numbered after their group by position, so
``kit`` with two unlabelled solids exports as ``kit 1`` and ``kit 2`` rather
than the STEP writer's ``SOLID``. A name a CAD kernel or STEP writer made up,
such as ``COMPOUND`` or ``=>[0:1:1:3]``, counts as no label; kernels spell type
names in capitals, so a part labelled ``shell`` or ``Solid`` keeps its name. A
label of digits alone, such as ``608``, also counts as none, since other
writers put numeric ids where a name belongs. The STEP writer, the part
listings and CAD Explorer's STEP converter use these same rules, so a fallback
name read back from a STEP file matches the one it was written with and the
one the viewer shows. An unlabelled root is named after its STEP file, as
``root_name`` gives it.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import TypeVar

Node = TypeVar("Node")

# What shapes are called when nobody named them: their type, spelled as build123d, OCCT and other STEP writers put it.
# Matched exactly, since people label parts "shell" or "Solid".
_GENERIC_NAMES = {"ASSEMBLY", "SOLID", "COMPOUND", "COMPSOLID", "SHELL", "FACE", "WIRE", "EDGE", "VERTEX", "SHAPE"}
# The STEP writer names an unnamed label after its document entry.
_ENTRY_NAME = re.compile(r"=>\[[0-9:]*\]")


def own_label(name: object) -> str | None:
    """The label someone chose, with its spacing tidied, or None for a missing or made-up name."""
    if name is None:
        return None
    text = " ".join(str(name).split())
    if (not text or text.isdigit() or text in _GENERIC_NAMES or _ENTRY_NAME.fullmatch(text)
            or text.lower().replace("_", " ").startswith("open cascade step translator")):  # build123d's import_step spells it with _
        return None
    return text


def root_name(path: str) -> str:
    """What a STEP's unlabelled root is called: its file name without ``.step`` or ``.stp``.

    ``path`` is a STEP file's name or path, or a cad path (a STEP's path without its suffix), with ``/`` separators.
    """
    name = path.rsplit("/", 1)[-1]
    stem, dot, suffix = name.rpartition(".")
    return stem if dot and stem and suffix.lower() in {"step", "stp"} else name


def child_name(label: object, *, group: str, index: int, siblings: int) -> str:
    """A child's name: its own label, else its group's name when it is the only child, else ``<group> <index>``."""
    return own_label(label) or (group if siblings == 1 else f"{group} {index}")


def tree_names(
    root: Node,
    *,
    root_name: str,
    children: Callable[[Node], Sequence[Node]],
    label: Callable[[Node], object],
) -> tuple[dict[int, str], list[str]]:
    """Every node's name by ``id(node)``, and the names given to unlabelled leaves."""
    names: dict[int, str] = {}
    unlabelled: list[str] = []

    def visit(node: Node, name: str) -> None:
        names[id(node)] = name
        kids = list(children(node))
        for index, child in enumerate(kids, start=1):
            name_of_child = child_name(label(child), group=name, index=index, siblings=len(kids))
            if own_label(label(child)) is None and not children(child):
                unlabelled.append(name_of_child)
            visit(child, name_of_child)

    visit(root, own_label(label(root)) or root_name)
    return names, unlabelled
