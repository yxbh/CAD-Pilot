"""The cad tools' per-user cache, for data derived from a file's exact contents.

Entries are named by content hash, so a cache never answers for a changed file
and any entry can be deleted at any time. ``CAD_PILOT_CACHE`` overrides the
platform's user cache folder.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

PRUNE_AFTER_SECONDS = 30 * 24 * 3600


def cache_root() -> Path:
    override = os.environ.get("CAD_PILOT_CACHE", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "cad-pilot" / "Cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "cad-pilot"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "cad-pilot"


def cache_path(kind: str, name: str) -> Path:
    return cache_root() / kind / name


def touch(path: Path) -> None:
    """Mark an entry as used, so pruning keeps it."""
    try:
        os.utime(path)
    except OSError:
        pass


def prune(kind: str, *, keep: Path | None = None) -> None:
    """Remove entries of one kind that have not been used for a month."""
    cutoff = time.time() - PRUNE_AFTER_SECONDS
    try:
        entries = list((cache_root() / kind).iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            if entry != keep and entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            pass
