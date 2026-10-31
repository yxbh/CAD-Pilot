"""Relative paths that people, generators and sidecar files write.

Either separator is accepted on every platform, so a design written on Windows still works on macOS, and the
result has POSIX parts, the form that references and reports use.
"""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath


def relative_path(value: str) -> PurePosixPath | None:
    """``value`` as POSIX parts, or None unless it is a plain relative path.

    A root (``/x``), a drive (``D:/x``, or the drive-relative ``D:x``) or a UNC share anchors a path, so none of
    them is relative on any platform.
    """
    written = PureWindowsPath(value)
    if written.anchor or not written.parts:
        return None
    return PurePosixPath(*written.parts)
