"""Paths that people, generators and sidecar files write.

Either separator is accepted on every platform, so a design written on Windows still works on macOS, and the
result has POSIX parts, the form that references and reports use. ``normal_path`` is the one place a written path
is tidied: ``.`` segments and doubled separators are dropped and an inner ``..`` is collapsed, so
``./outputs/pin.step`` and ``outputs/../outputs/pin.step`` both name ``outputs/pin.step``.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath

# What anchors a path: a UNC share, a root, or a drive with its root.
_ANCHOR = re.compile(r"^(//[^/]+/[^/]+(?:/|$)|/|[A-Za-z]:/)")
_DRIVE_RELATIVE = re.compile(r"^[A-Za-z]:(?!/)")


def path_anchor(path: str) -> str:
    """The anchor a POSIX-separated path starts with (``/``, ``C:/`` or ``//server/share/``), or ``""``."""
    match = _ANCHOR.match(path)
    return match.group(1) if match else ""


def normal_path(value: str) -> str | None:
    """``value`` with POSIX separators, ``.`` segments and doubled separators dropped and inner ``..`` collapsed.

    A relative path keeps its leading ``..``; an anchored one keeps its anchor. None when nothing is left, when
    ``..`` would climb above an anchor, or for a drive-relative path such as ``D:x``, which names no single place.
    """
    text = str(value or "").strip().replace("\\", "/")
    if _DRIVE_RELATIVE.match(text):
        return None
    anchor = path_anchor(text)
    parts: list[str] = []
    for part in text[len(anchor):].split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts and parts[-1] != "..":
                parts.pop()
                continue
            if anchor:
                return None
        parts.append(part)
    if not parts or parts[-1] == "..":
        return None
    return anchor.rstrip("/") + "/" + "/".join(parts) if anchor else "/".join(parts)


def relative_path(value: str) -> PurePosixPath | None:
    """``value`` as tidy POSIX parts, or None unless it is a plain relative path.

    A root (``/x``), a drive (``D:/x``, or the drive-relative ``D:x``) or a UNC share anchors a path, so none of
    them is relative on any platform.
    """
    normal = normal_path(value)
    if normal is None or path_anchor(normal):
        return None
    return PurePosixPath(normal)


def command_line_path(value: str) -> Path:
    """A path someone typed, resolved: relative to the current folder with either separator, or absolute here.

    A drive or root that is not absolute on this system (``C:\\x`` on macOS, ``\\x`` on Windows) names no single
    place, so it raises ``ValueError``.
    """
    relative = relative_path(value)
    path = (Path(*relative.parts) if relative is not None else Path(value)).expanduser()
    if relative is None and not path.is_absolute():
        raise ValueError(f"{value!r} must be relative to the current folder or absolute on this system")
    return path.resolve()
