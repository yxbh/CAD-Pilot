from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from common.assembly_spec import REPO_ROOT, find_step_path, resolve_cad_source_path
from common.cad_ref_syntax import ParsedToken, normalize_cad_path, parse_cad_tokens
from common.paths import path_anchor
from common.cache import cache_path, prune, sha256_file, touch
from common.glb_topology import (
    STEP_TOPOLOGY_SCHEMA_VERSION,
    read_step_topology_bundle_from_glb,
    read_step_topology_manifest_from_glb,
)
from common.render import existing_part_glb_path
from common.selector_types import SelectorBundle, SelectorProfile


STEP_SUFFIXES = (".step", ".stp")


class CadRefError(RuntimeError):
    pass


@dataclass(frozen=True)
class EntryTarget:
    cad_path: str
    selectors: tuple[str, ...] = ()

    @property
    def token(self) -> str:
        from common.cad_ref_syntax import build_cad_token

        if not self.selectors:
            return build_cad_token(self.cad_path)
        return build_cad_token(self.cad_path, ",".join(self.selectors))


@dataclass(frozen=True)
class ResolvedStepTarget:
    cad_path: str
    kind: str
    source_path: Path
    step_path: Path


@dataclass(frozen=True)
class StepTopologyArtifact:
    cad_path: str
    kind: str
    source_path: Path
    step_path: Path
    glb_path: Path
    manifest: dict[str, object]
    selector_bundle: SelectorBundle | None = None


def cad_ref_error_payload(exc: CadRefError) -> dict[str, object]:
    return {"message": str(exc)}


def cad_path_from_target(target: str) -> str:
    return entry_target_from_target(target).cad_path


def canonical_cad_path(cad_path: str) -> str:
    """The path a ref is reported with: from the design root for a STEP inside it, as given for one elsewhere.

    ``/parts/foo`` naming the root's ``parts/foo.step``, or an absolute path
    into the root, becomes ``parts/foo``, so refs never carry machine paths
    for the project's own files.
    """
    if not (cad_path.startswith("..") or path_anchor(cad_path)):
        return cad_path
    step_path = _direct_step_path(cad_path)
    if step_path is None:
        return cad_path
    try:
        return step_path.relative_to(REPO_ROOT).with_suffix("").as_posix()
    except ValueError:
        return cad_path


def cad_tokens(text: str) -> list[ParsedToken]:
    """The ``@cad`` tokens in text, with canonical paths."""
    return [replace(token, cad_path=canonical_cad_path(token.cad_path)) for token in parse_cad_tokens(text)]


def entry_target_from_target(target: str) -> EntryTarget:
    parsed_tokens = cad_tokens(target)
    if parsed_tokens:
        if len(parsed_tokens) != 1:
            raise CadRefError("Expected exactly one @cad[...] token.")
        parsed = parsed_tokens[0]
        return EntryTarget(parsed.cad_path, parsed.selectors)
    normalized = normalize_cad_path(target)
    if normalized is None:
        raise CadRefError(f"Invalid CAD entry target: {target}")
    return EntryTarget(canonical_cad_path(normalized))


def resolve_step_target(target: str) -> ResolvedStepTarget:
    entry_target = entry_target_from_target(target)
    cad_path = entry_target.cad_path
    raw_step_path = _raw_step_path(str(target or "").strip())
    if raw_step_path is not None:
        lookup_cad_path = _lookup_cad_path(cad_path)
        resolved = resolve_cad_source_path(lookup_cad_path)
        resolved_step_path = find_step_path(lookup_cad_path) if resolved is not None else None
        if resolved is not None and resolved_step_path is not None and resolved_step_path.resolve() == raw_step_path.resolve():
            kind, source_path = resolved
            return ResolvedStepTarget(
                cad_path=cad_path,
                kind=kind,
                source_path=source_path,
                step_path=raw_step_path,
            )
        return ResolvedStepTarget(
            cad_path=cad_path,
            kind="part",
            source_path=raw_step_path,
            step_path=raw_step_path,
        )

    direct_step_path = _direct_step_path(cad_path)
    if direct_step_path is not None:
        return ResolvedStepTarget(
            cad_path=cad_path,
            kind="part",
            source_path=direct_step_path,
            step_path=direct_step_path,
        )

    lookup_cad_path = _lookup_cad_path(cad_path)
    resolved = resolve_cad_source_path(lookup_cad_path)
    if resolved is None:
        raise CadRefError(f"CAD STEP ref not found for '{cad_path}'.")
    kind, source_path = resolved
    if kind in {"part", "assembly"}:
        step_path = find_step_path(lookup_cad_path)
        if step_path is None:
            raise CadRefError(f"STEP file not found for ref '{cad_path}'.")
        return ResolvedStepTarget(
            cad_path=cad_path,
            kind=kind,
            source_path=source_path,
            step_path=step_path,
        )

    raise CadRefError(f"CAD ref '{cad_path}' is not STEP-backed.")


TOPOLOGY_CACHE = "topology"


def step_topology(target: ResolvedStepTarget, *, require_selector: bool = False) -> StepTopologyArtifact:
    """The STEP's face and edge topology, for any STEP file.

    A current sidecar from ``scripts/step`` is used as it is. Any other STEP,
    or one whose sidecar is missing or stale, is read and indexed into the
    user cache under its content hash, so the next call is a file read.
    Nothing is written beside the STEP.
    """
    stamp = _file_stamp(target.step_path)
    step_hash = sha256_file(target.step_path)
    sidecar = existing_part_glb_path(target.step_path)
    cached = cache_path(TOPOLOGY_CACHE, f"{step_hash}.v{STEP_TOPOLOGY_SCHEMA_VERSION}.glb")
    for glb_path in (sidecar, cached):
        artifact = _current_topology(target, glb_path, step_hash, require_selector=require_selector)
        if artifact is not None:
            if glb_path == cached:
                touch(cached)
            return artifact
    try:
        _build_topology(target, cached, step_hash=step_hash, stamp=stamp)
    except CadRefError:
        raise
    except Exception as exc:
        raise CadRefError(f"Could not read the STEP file {_relative_to_repo(target.step_path)}: {exc}") from exc
    prune(TOPOLOGY_CACHE, keep=cached)
    artifact = _current_topology(target, cached, step_hash, require_selector=require_selector)
    if artifact is None:
        raise CadRefError(f"Could not index the STEP file {_relative_to_repo(target.step_path)}.")
    return artifact


def _current_topology(
    target: ResolvedStepTarget,
    glb_path: Path | None,
    step_hash: str,
    *,
    require_selector: bool,
) -> StepTopologyArtifact | None:
    if glb_path is None or not glb_path.is_file():
        return None
    manifest = read_step_topology_manifest_from_glb(glb_path)
    if manifest is None or manifest.get("schemaVersion") != STEP_TOPOLOGY_SCHEMA_VERSION or manifest.get("stepHash") != step_hash:
        return None
    selector_bundle = read_step_topology_bundle_from_glb(glb_path) if require_selector else None
    if require_selector and selector_bundle is None:
        return None
    return StepTopologyArtifact(
        cad_path=target.cad_path,
        kind=target.kind,
        source_path=target.source_path,
        step_path=target.step_path,
        glb_path=glb_path,
        manifest=manifest,
        selector_bundle=selector_bundle,
    )


def _file_stamp(path: Path) -> tuple[int, int, int] | None:
    """What changes when a file is rewritten, in place or by a rename onto it; None when it cannot be read."""
    try:
        info = path.stat()
    except OSError:
        return None
    return info.st_size, info.st_mtime_ns, info.st_ino


def _build_topology(target: ResolvedStepTarget, glb_path: Path, *, step_hash: str, stamp: tuple[int, int, int] | None) -> None:
    """Index the STEP into ``glb_path``, the cache entry named by ``step_hash``.

    The index is filed under the hash taken before reading, and its manifest records that same hash, so the file
    must not have changed in between: a STEP rewritten while it was read is not cached.
    """
    from common.atomic_replace import replacing
    from common.glb import write_scene_glb
    from common.step_scene import extract_selectors_from_scene, load_step_scene

    scene = load_step_scene(target.step_path)
    if _file_stamp(target.step_path) != stamp:
        raise CadRefError(f"The STEP file {_relative_to_repo(target.step_path)} changed while it was read; run the command again.")
    scene.step_hash = step_hash
    bundle = extract_selectors_from_scene(scene, cad_ref=target.cad_path, profile=SelectorProfile.ARTIFACT)
    with replacing(glb_path) as temp_path:
        write_scene_glb(scene, temp_path, selector_bundle=bundle, entry_kind=target.kind)


def _direct_step_path(cad_path: str) -> Path | None:
    # A leading "/" names an absolute path, or, when nothing is there, a path from the design root.
    spellings = (cad_path, cad_path.lstrip("/")) if cad_path.startswith("/") else (cad_path,)
    for spelling in spellings:
        for suffix in STEP_SUFFIXES:
            candidate = (REPO_ROOT / f"{spelling}{suffix}").resolve()
            if candidate.is_file():
                return candidate
    return None


def _raw_step_path(target: str) -> Path | None:
    if not target:
        return None
    path = Path(target).expanduser()
    if path.suffix.lower() not in STEP_SUFFIXES:
        return None
    resolved = path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()
    return resolved if resolved.is_file() else None


def _cad_path_lookup_candidates(cad_path: str) -> tuple[str, ...]:
    return (cad_path,) if cad_path else ()


def _lookup_cad_path(cad_path: str) -> str:
    for candidate in _cad_path_lookup_candidates(cad_path):
        if resolve_cad_source_path(candidate) is not None:
            return candidate
    return cad_path


def _relative_to_repo(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()
