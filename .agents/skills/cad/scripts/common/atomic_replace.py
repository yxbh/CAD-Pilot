"""Write artifacts through a sibling temp file and one atomic rename.

A reader (the Explorer, a slicer, a sync client) never sees a half-written STEP, STL or 3MF,
and a failed export leaves the previous file in place.

On Windows the rename can lose to a handle that was let go a moment ago: ``WinError 32``
(sharing violation; SMB shares, scanners and indexers hold a just-closed file briefly) or
``WinError 5`` onto an existing file another process has open. Only those are retried, over a
bounded 750 ms ladder; then the temp file is copied to a name nobody holds and the ladder runs
once more. Every other error, such as a read-only folder or a missing directory, surfaces at
once. Off Windows ``winerror`` does not exist, so this is exactly ``os.replace``.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import time
from collections.abc import Iterator
from pathlib import Path

# ERROR_SHARING_VIOLATION: the file is open in another process, or was a moment ago.
WINDOWS_SHARING_VIOLATION = 32
# ERROR_ACCESS_DENIED: what a rename answers when another process holds the DESTINATION open.
# Retried only when a file is there.
WINDOWS_ACCESS_DENIED = 5
RETRY_DELAYS_SECONDS = (0.05, 0.1, 0.2, 0.4)


def temp_suffix() -> str:
    """A collision-free suffix for a sibling temp file, ending in ``.tmp``."""
    return f".{os.getpid()}.{os.urandom(4).hex()}.tmp"


def _held(error: OSError, target_path: Path | str) -> bool:
    """Whether a refused rename is a handle someone will let go of.

    A sharing violation always is. A denial is only when a FILE is at the target; with nothing
    there, or a directory in the way, a denial is a real one.
    """
    code = getattr(error, "winerror", None)
    if code == WINDOWS_SHARING_VIOLATION:
        return True
    return code == WINDOWS_ACCESS_DENIED and os.path.isfile(target_path)


def _run_ladder(temp_path: Path | str, target_path: Path | str) -> OSError | None:
    """Run the bounded retry, returning the held-handle refusal it could not beat."""
    for delay in (*RETRY_DELAYS_SECONDS, None):
        try:
            os.replace(temp_path, target_path)
            return None
        except OSError as error:
            if not _held(error, target_path):
                raise
            if delay is None:
                return error
            time.sleep(delay)
    return None


def replace_atomic(temp_path: Path | str, target_path: Path | str) -> None:
    """``os.replace`` with a bounded retry, then one retry from a copy nobody holds."""
    blocked = _run_ladder(temp_path, target_path)
    if blocked is None:
        return

    source = Path(temp_path)
    fresh = source.with_name(f"{source.name}{temp_suffix()}")
    try:
        shutil.copyfile(source, fresh)
    except OSError:
        # The source is pinned for reading too; report the rename failure the caller waited on.
        raise blocked from None

    # Best effort: the handle that blocked the rename usually blocks this as well.
    with contextlib.suppress(OSError):
        source.unlink(missing_ok=True)

    try:
        if _run_ladder(fresh, target_path) is not None:
            raise blocked
    finally:
        with contextlib.suppress(OSError):
            fresh.unlink(missing_ok=True)


@contextlib.contextmanager
def replacing(target_path: Path | str) -> Iterator[Path]:
    """Yield a temp path beside ``target_path``, and rename it into place if the block succeeds.

    Same directory on purpose: a rename across filesystems is not atomic. The temp file is
    removed when the block or the rename fails; a cleanup error is suppressed so it cannot mask
    the failure the caller needs to see.
    """
    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target.with_name(f"{target.name}{temp_suffix()}")
    try:
        yield temp_path
        replace_atomic(temp_path, target)
    finally:
        with contextlib.suppress(OSError):
            temp_path.unlink(missing_ok=True)
