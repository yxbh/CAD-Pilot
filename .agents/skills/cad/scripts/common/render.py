from __future__ import annotations

from pathlib import Path

from common.catalog import (
    cad_ref_from_step_path as fallback_cad_ref_from_step_path,
    explorer_directory_for_step_path,
    find_source_by_cad_ref,
    find_source_by_path,
    hidden_glb_path_for_step_path,
)


REPO_ROOT = Path.cwd().resolve()
CAD_ROOT = REPO_ROOT


def _source_for_step_path(step_path: Path):
    source = find_source_by_path(step_path)
    if source is not None:
        return source
    cad_ref = fallback_cad_ref_from_step_path(step_path)
    source = find_source_by_cad_ref(cad_ref)
    if source is None:
        raise ValueError(f"CAD STEP ref not found: {cad_ref}")
    return source


def part_stl_path(step_path: Path) -> Path:
    source = _source_for_step_path(step_path)
    if source.stl_path is None:
        raise ValueError(f"CAD STEP ref has no configured STL output: {source.cad_ref}")
    return source.stl_path


def part_3mf_path(step_path: Path) -> Path:
    source = _source_for_step_path(step_path)
    if source.three_mf_path is None:
        raise ValueError(f"CAD STEP ref has no configured 3MF output: {source.cad_ref}")
    return source.three_mf_path


def native_component_glb_dir(step_path: Path) -> Path:
    return explorer_directory_for_step_path(step_path) / "components"


def part_glb_path(step_path: Path) -> Path:
    return hidden_glb_path_for_step_path(step_path)


def relative_to_repo(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()
