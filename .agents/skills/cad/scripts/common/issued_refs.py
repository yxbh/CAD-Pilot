"""Which STEP builds have had face and edge refs handed out.

``scripts/inspect`` notes a build when it reports ``@cad`` face, edge or
corner refs for it. When ``scripts/step`` rebuilds that STEP with different
topology, or as different bytes whose previous topology it cannot read, it
warns once that those refs may no longer name the same geometry; a rebuild
nobody took refs from says nothing.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from common.cache import cache_path, prune

KIND = "issued-refs"


def _marker(step_path: Path) -> Path:
    key = hashlib.sha256(str(step_path.resolve()).encode("utf-8")).hexdigest()[:32]
    return cache_path(KIND, f"{key}.json")


def issued_step_hash(step_path: Path) -> str | None:
    """The hash of the STEP build refs were last handed out for, or None when nobody took any."""
    try:
        return str(json.loads(_marker(step_path).read_text(encoding="utf-8")).get("stepHash") or "") or None
    except (OSError, ValueError, AttributeError):
        return None


def mark(step_path: Path, step_hash: str) -> None:
    marker = _marker(step_path)
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"step": str(step_path.resolve()), "stepHash": step_hash}), encoding="utf-8")
    except OSError:
        return
    prune(KIND, keep=marker)


def forget(step_path: Path) -> None:
    try:
        _marker(step_path).unlink(missing_ok=True)
    except OSError:
        pass


def note_refs_issued(result: dict[str, object]) -> None:
    """Record the STEP builds an inspect result handed face, edge or corner refs out for."""
    from common.cache import sha256_file
    from common.step_targets import CadRefError, resolve_step_target

    hashes: dict[str, str | None] = {}
    for token in result.get("tokens", []) or []:
        if isinstance(token, dict) and (token.get("selections") or "topology" in token or "planes" in token):
            hashes[str(token.get("cadPath") or "")] = str(token.get("stepHash") or "") or None
    if result.get("findingCount"):
        hashes.setdefault(str(result.get("cadPath") or ""), None)
    for cad_path, step_hash in hashes.items():
        if not cad_path:
            continue
        try:
            step_path = resolve_step_target(cad_path).step_path
            mark(step_path, step_hash or sha256_file(step_path))
        except (CadRefError, OSError):
            continue
