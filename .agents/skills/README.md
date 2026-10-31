# Workbench Skills

This README is the provenance registry for the skills in this folder: one entry per skill, kept here rather than inside a skill's own files, whose upstream READMEs and licenses stay untouched. Claude Code finds the skills through `.claude/skills` links; the [root README](../../README.md#use-the-skills-in-other-projects) covers using them from other projects.

Each entry records the origin; for imported material, the source repository URL and path, an immutable revision, the import date, the license and where its notice is kept, the scope, and what was changed locally; and how changes are checked. A fork is an imported skill that CAD-Pilot has taken over: its entry adds the fork date and reason, keeps the license file with the forked files, and records what was removed or changed from the import and any later upstream material copied in. First-party work on a fork is recorded in Git history like the rest of the workbench. Imported instructions, prompts and agent definitions use the README of their own collection folder the same way.

Do not import unlicensed content, strip notices, copy an entire unrelated skill collection, or silently refresh from a moving branch. Record original authorship rather than a third-party source for material written here.

## cad

- Origin: first-party fork of an imported skill, maintained in CAD-Pilot; not originally authored here.
- Entry point: [cad/SKILL.md](./cad/SKILL.md).
- Source repository: https://github.com/cedrickchee/text-to-cad
- Source revision: `2dd54cf8e27dc71c92244dc47271dcf10d302e16`
- Source directory: `.agents/skills/cad/`
- Imported: 2026-09-14.
- Forked: 2026-10-22. The pinned revision was the source fork's latest commit, and `earthtojake/text-to-cad` had diverged into separate 0.7.x releases, so there was no upstream line to keep in sync with.
- License: MIT; original notice retained in [cad/LICENSE](./cad/LICENSE). Keep it with the forked files.
- Upstream attribution: Thompson Labs. The source repository README identifies `earthtojake/text-to-cad` and `earthtojake/cad-skill` as upstream projects; this fork starts from the cedrickchee revision above.
- Scope: the CAD skill, supporting CLI packages, reference material and agent metadata. Other top-level skills were not imported.
- Local changes: removed the bundled browser viewer (`cad/explorer/`, with its npm lock and registry-metadata patches), its workbench check and `scripts/render` (CAD Explorer's `capture` and `render` replace them); dropped `playwright`, `pillow` and `vtk` from `requirements.txt`, the unused `assets/design-brief-template.md` and `scripts/dxf/render_payload.py`; declared Python dependencies in CAD-Pilot's `pyproject.toml`, resolved per machine. `SKILL.md`, `agents/openai.yaml` and `references/` were rewritten: viewing routes to CAD Explorer through the visual-review skill, no default wall, fillet or clearance dimensions are given, and version-specific build123d behaviour was checked on build123d 0.13 before it was written down (upstream notes about 0.10/0.11 failures that did not reproduce were left out). Later first-party work, such as the solid check, the per-user inspect cache, `inspect parts`, `hygiene` and `clearance`, the generator loader, part naming and `scripts/print`, is in Git history. No Bambu Studio code or presets are copied into `scripts/print`: it reads the installed app's system presets and runs its command line when used.
- Python API patch (2026-09-22): first-party changes to `scripts/common/step_scene.py`, `glb_mesh_payload.py`, `threemf.py` and their tests adapt native collection imports, topology casts and gap-preserving bounding-box corners to the OCP 8 API used by build123d 0.13.
- Adopted upstream guidance: ideas from https://github.com/earthtojake/text-to-cad release 0.7.26, revision `2f793659fb7bab537e2f00836e06448fc4087cb2`, files `skills/cad/SKILL.md` and `skills/cad/references/` `cad-brief.md`, `build123d-modeling.md`, `positioning.md`, `inspection-and-validation.md`, `repair-loop.md` and `snapshot-review.md`, reviewed 2026-10-22. License: MIT, Copyright (c) 2026 Thompson Labs LLC. The ideas were rewritten for this fork's `scripts/inspect` CLI, build123d scripts and CAD Explorer; upstream's `cadgen` commands, decorators and snapshot renderer were not adopted. Individual sentences stay close to upstream wording in `SKILL.md` Required workflow and Non-negotiables; `references/natural-language-specs.md` opening paragraph, Goal, Reference images and Technical drawings; `references/build123d-modeling.md` Fillet and chamfer edges, Lofts and sampled profiles, Booleans and Validity, volume and seams; `references/positioning.md` Joints or explicit transforms; `references/inspection-and-validation.md` Python checks on the saved STEP and Reporting checks; and `references/self-review.md`.
- Upstream imports (2026-10-22): code copied from https://github.com/earthtojake/text-to-cad at `2f793659fb7bab537e2f00836e06448fc4087cb2` (v0.7.26) under its MIT License, "Copyright (c) 2026 Thompson Labs LLC" (the same terms as `cad/LICENSE`, whose notice reads "Thompson Labs"). That release's `cadgen` package caps build123d below 0.12 and OCP below 8, so it is not a dependency. Source paths are relative to `packages/cadgen/src/cadgen/` unless they start with `tests/` or `packages/`.
  - `step_export.py` lines 110-341, the definition-tree writer in `_create_bin_xcaf_doc` (commits `557db3b16`, `0837ee163`, `ff226ac53`, `3cdedc508`), into `scripts/common/step_export.py`, and `557db3b16`'s leaf-definition naming into `scripts/common/assembly_export.py`. Local changes: build123d's colour semantics instead of cadgen's colour contract; no per-face colours; simpler location helpers; colours on leaf definitions and occurrences only; a separate definition per label as well as per colour. Tests: `common/tests/test_step_export.py` (placed-root case adapted from `tests/python/packages/cadgen/test_step_export_placement.py`) and the leaf-product test in `test_assembly_export.py`.
  - `_internal/step_scene.py` `_label_name` guard (`a38c383a3`), into `scripts/common/step_scene.py`.
  - Selector-manifest `entryKind` and the inspect reader's fallback to the index manifest (`a5da51d5b`; `packages/cadpy/src/cadpy/glb.py` and `skills/cad/scripts/inspect/inspect_refs/inspect.py`), into `scripts/common/glb.py` and `scripts/inspect/inspect_refs/inspect.py`, with tests adapted from `tests/python/skills/cad/cadpy/test_glb_topology.py` and `test_refs_inspect.py`.
  - Absent face/edge counts left out of the entry summary and refs headline (`30f5f7d91`; `reporting.py`, `cli/step_inspect/cli.py`), into `scripts/common/reporting.py` and `scripts/inspect/inspect_refs/cli.py`.
  - Only a leading `#` stripped from a selector (`b26061cac`; `cad_ref_syntax.py`), into `scripts/common/cad_ref_syntax.py`.
  - sRGB encoding of 3MF display colours (`_srgb_byte_from_linear`, `_byte_from_unit_channel`; `packages/cadpy/src/cadpy/threemf.py` at `9c5084b94`), into `scripts/common/threemf.py`. Local changes: `DEFAULT_MATERIAL` is written in linear RGB, and `URDF_MATERIALS` colours are converted from sRGB in `scripts/common/generation.py`. Expected colours in `test_threemf.py` follow upstream's.
  - Name spelling from `step_export.py` (`unicode_directives`, `ascii_name`, `_has_respelled_name`, `_respell_literals`, `_record_end`, `_respell_names_in_file`) into `scripts/common/step_export.py`, and `_decode_step_unicode_escapes` from `_internal/step_scene_loader.py` into `_normalize_label_name` in `scripts/common/step_scene.py`. Local change: every single quote in product and occurrence records is written `\X\27`, not only upstream's quote-before-`,`-or-`)` pattern.
  - `_internal/atomic_replace.py` `replace_atomic`, its bounded Windows retry and `temp_suffix`, into `scripts/common/atomic_replace.py`, with a local `replacing()` context manager used by the STEP, STL and 3MF writers; the read ladders, store moves, directory and staging helpers were not copied. Tests adapted from `tests/python/packages/cadgen/test_atomic_replace.py`.
  - `geometry.py` (`closest_points`, `overlap_volume`, `is_sound`, `topology_errors`, `boundary_edges`, `self_intersections`, `mass_properties`), into `scripts/common/geometry.py`, on OCP 8's `IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher`. Local changes: `topology_errors` is rewritten because OCP 8 cannot convert `BRepCheck_Result.Status()` lists; `is_sound` and `self_intersections` run the kernel's check once on its worker threads, and `is_sound` checks a native shape through `_argument_faults`. Tests adapted from `tests/python/packages/cadgen/test_geometry_measurements.py`, `test_interference.py` and `test_validity.py`.
  - Watertight STL/3MF checks and the plate-with-hole and curved-wall models from `tests/python/packages/cadgen/test_mesh_export_manifold.py`, into `scripts/common/tests/test_mesh_export_manifold.py`, run through `scripts/step`, with a fine mesh case in place of upstream's coarse one. Its teacup models are original.

### Update Procedure

Change this skill directly; there is no upstream refresh. Keep `cad/LICENSE` and the attribution above with the files. From the workbench root, run `node tools/check.mjs`, which covers sample geometry, direct `scripts/step`/`scripts/inspect` generation and inspection, and every test under `cad/scripts` (the `scripts/print` tests that need Bambu Studio skip when it is not installed); for dependency or API changes, also resolve afresh through the configured feeds. Guidance changes keep viewing with the visual-review skill and `@cad[...]` references with `scripts/inspect`, which the workbench's rule-home tests check. To adopt a later upstream change, review its license and diff, copy only what is needed and record its source revision here.

## visual-review

- Origin: authored for CAD-Pilot, not imported.
- Entry point: [visual-review/SKILL.md](./visual-review/SKILL.md).
- Repository: https://github.com/yxbh/CAD-Pilot
- Created: 2026-09-14.
- Basis: the owner's difficulty describing CAD shapes and communicating by pointing, plus the documented CAD Explorer reference workflow.
- Reference: https://github.com/cedrickchee/text-to-cad at `2dd54cf8e27dc71c92244dc47271dcf10d302e16`.
- License: no additional license granted here; follows the repository's policy.
- Local changes: none to third-party material; no third-party text or code is copied into this skill.

### Update Procedure

Validate changes with a real model, a selected reference or marked screenshot, and an ambiguous follow-up request, in both the Copilot canvas and a host using the design-project viewer, keeping the two reference formats distinct. Distinguish documented viewer capabilities from interactions actually tested with the chosen agent host.

## fdm-design

- Origin: authored for CAD-Pilot, not imported.
- Entry point: [fdm-design/SKILL.md](./fdm-design/SKILL.md).
- Repository: https://github.com/yxbh/CAD-Pilot
- Created: 2026-09-14.
- Basis: engine-independent FDM/FFF design review and calibration discipline, informed by manufacturer guidance (linked, not vendored, in the skill's Sources and Boundaries, reviewed 2026-09-14) and an evaluation of existing community skills.
- Existing skills reviewed, not imported: [swh/openscad-skill](https://github.com/swh/openscad-skill/blob/8c6313f44ffcad340c818a50347ab464eb2f59d7/openscad-bosl2/SKILL.md), revision `8c6313f44ffcad340c818a50347ab464eb2f59d7`, path `openscad-bosl2/SKILL.md`; [andreahaku/openscad_claude_skill](https://github.com/andreahaku/openscad_claude_skill/blob/c47ef2359a3329da45c3c2e6caa3c286133c2844/SKILL.md), revision `c47ef2359a3329da45c3c2e6caa3c286133c2844`, path `SKILL.md`. Reviewed 2026-09-14; rejected as whole imports because of engine/platform coupling and fixed workflow/numeric defaults. Their licenses were not relied upon to redistribute anything; verify licensing before any future copy.
- License: no additional license granted here; follows the repository's policy. Linked sources retain their own terms.
- Local changes: none to third-party material; an original synthesis with links, adding no CAD engine, slicer or printer-control integration of its own.

### Update Procedure

Check source applicability and dates before revising guidance. Preserve unknown versus provisional versus measured values, and never promote rules of thumb to universal limits. Use actual design and print feedback to find guidance worth improving or removing; static checks do not prove agent compliance or manufacturing results.
