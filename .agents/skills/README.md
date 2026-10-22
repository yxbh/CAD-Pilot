# Workbench Skills

This workbench-owned README is the provenance registry for skills in this folder. Keep one entry per skill here, outside the imported skill's own files. Preserve upstream READMEs and licenses; do not replace or append provenance to them.

A fork is an imported skill that CAD-Pilot has taken over and maintains as first-party code. Its entry keeps the source repository, revision, import date, license and attribution, adds the fork date and reason, and replaces the update procedure with how first-party changes are checked. Keep the license file with the forked files.

For imported instructions, prompts, and agent definitions, use the README at the corresponding collection folder, following the same convention. Record:

- Source repository URL and source path.
- Immutable commit or release revision and import date.
- License and preserved attribution/license-file location.
- Imported scope and a list of local modifications.
- A review and validation procedure for future updates.

Do not import unlicensed content, strip notices, copy an entire unrelated skill collection, or silently refresh from a moving branch. Record original authorship instead of a third-party source for customizations written in this repository.

The workbench's skills are discoverable here. External design projects need an explicit installation of the selected skills or another supported discovery mechanism; merely mentioning a path does not register a skill with an agent host.

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
- Local changes: at the fork, removed the bundled browser viewer (`cad/explorer/`, with its npm lock and local registry-metadata patches), the workbench check that drove it, and `scripts/render`, whose headless renders loaded three.js from that viewer's packages (the maintained Explorer's `explorer.mjs capture` replaces them, with an open page), dropped `playwright` and `pillow` (both used only by `scripts/render`) and `vtk` (imported nowhere; OCP comes from the no-VTK build) from `requirements.txt`, and rewrote `SKILL.md`, `agents/openai.yaml` and `references/` to route viewing and images to the maintained CAD Explorer through the visual-review skill. Modeling, generation and CLI inspection guidance is retained. Checkouts that installed the old viewer keep its Git-ignored `node_modules` and build output under `cad/explorer/`; delete that folder once it holds only ignored files. `scripts/step` still writes the hidden `.<name>.step.glb` beside each STEP because `scripts/inspect` reads `@cad` topology from it. Python runtime dependencies are declared in CAD-Pilot's `pyproject.toml` and resolved separately in each machine's Git-ignored `uv.lock` using its configured feeds; exact Python dependency versions are not pinned across machines.
- Python API patch (2026-09-22): first-party compatibility changes to `cad/scripts/common/step_scene.py`, `glb_mesh_payload.py`, `threemf.py` and the corresponding `common/tests/test_glb.py`, `test_threemf.py` and `test_step_scene.py` adapt native collection imports, topology casts and gap-preserving bounding-box corner accessors to the OCP 8 API used by build123d 0.13. `common/tests/test_assembly_export.py` checks named occurrences, local placements and actual world bounds instead of assuming exporter-specific hierarchy depths. Assemblies regenerated with build123d 0.13 can have flatter hierarchies and different `@cad` occurrence paths; re-inspect the regenerated artifact and its sidecars rather than translating old IDs. Existing artifact files are not rewritten by this patch.
- Upstream imports (2026-10-22): selected fixes and helpers copied from https://github.com/earthtojake/text-to-cad at `2f793659fb7bab537e2f00836e06448fc4087cb2` (v0.7.26), under its MIT License, "Copyright (c) 2026 Thompson Labs LLC" (the same terms as `cad/LICENSE`, whose notice reads "Thompson Labs"). That release moved the shared code into the `cadgen` package, which caps build123d below 0.12 and OCP below 8, so it is not a dependency. Source paths are relative to `packages/cadgen/src/cadgen/` unless they start with `tests/`. Copied pieces and local changes:
  - `step_export.py` lines 110-341, the definition-tree writer in `_create_bin_xcaf_doc` (upstream commits `557db3b16`, `0837ee163`, `ff226ac53`, `3cdedc508`), into `scripts/common/step_export.py`: each placed copy of a shared solid keeps its own name, colour and placement, Part leaves no longer gain a `SOLID` level, a placed root does not add a STEP group, and bare Compound leaves are coloured. Kept build123d's colour semantics (`Color.wrapped`) instead of cadgen's colour contract, dropped per-face colours and non-ASCII respelling, and simplified the location helpers. build123d 0.13's `_create_xde` was compared and not delegated to: it names copies and colours them, but writes a placed root as an extra STEP group, so the file and the in-memory scene disagree. The one-line `557db3b16` fix also names leaf definitions in `scripts/common/assembly_export.py`. Tests: `common/tests/test_step_export.py` (the placed-root case adapted from `tests/python/packages/cadgen/test_step_export_placement.py`) and the leaf-product test in `test_assembly_export.py`, adapted from `557db3b16`.
  - `_internal/step_scene.py` `_label_name` guard (`a38c383a3`), into `scripts/common/step_scene.py`: checks `IsAttribute` before `FindAttribute`, which segfaults on an unnamed label on OCP 8 too. Its test runs in a child process.
  - Selector-manifest `entryKind` and the inspect reader's fallback to the index manifest (`a5da51d5b`; upstream `packages/cadpy/src/cadpy/glb.py` and `skills/cad/scripts/inspect/inspect_refs/inspect.py` at that commit), into `scripts/common/glb.py` and `scripts/inspect/inspect_refs/inspect.py`, with tests adapted from `tests/python/skills/cad/cadpy/test_glb_topology.py` and `test_refs_inspect.py`.
  - Absent face/edge counts left out of the entry summary and the refs headline (`30f5f7d91`; `reporting.py`, `cli/step_inspect/cli.py`), into `scripts/common/reporting.py` and `scripts/inspect/inspect_refs/cli.py`, whose headline names `cadPath`.
  - Only a leading `#` stripped from a selector (`b26061cac`; `cad_ref_syntax.py`), into `scripts/common/cad_ref_syntax.py`.
  - sRGB encoding of 3MF display colours (`_srgb_byte_from_linear` and `_byte_from_unit_channel`, present since `9c5084b94`; `threemf.py`), into `scripts/common/threemf.py`. Local change: `DEFAULT_MATERIAL` is written in linear RGB so the default still displays `#F4F4F5`; expected colours in `test_threemf.py` follow upstream's.
  - `gen_step()` refuses labels with non-ASCII characters (read back garbled) or a quote followed by `,` or `)` (cuts the name short and drops the part, or crashes the reader), in `scripts/common/generation.py`. Original code, using upstream's misread pattern from `step_export.py`.
  - `_internal/atomic_replace.py` `replace_atomic`, its bounded Windows retry and `temp_suffix`, into `scripts/common/atomic_replace.py`, with a local `replacing()` context manager that the STEP, STL and 3MF writers now use. The read ladders, store moves, directory and staging helpers were not copied. Tests adapted from `tests/python/packages/cadgen/test_atomic_replace.py`.
  - `geometry.py` (`closest_points`, `overlap_volume`, `is_sound`, `topology_errors`, `boundary_edges`, `self_intersections`, `mass_properties`), into `scripts/common/geometry.py`, using OCP 8's `IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher`. `topology_errors` is rewritten because OCP 8 cannot convert `BRepCheck_Result.Status()` lists to Python: it reports the smallest entities the analyzer finds invalid, with codes from the shell, face and wire checks that return a status directly, or `invalid`. Tests adapted from `tests/python/packages/cadgen/test_geometry_measurements.py`, `test_interference.py` and `test_validity.py` for the build123d 0.13 and OCP 8 APIs.
  - Watertight STL/3MF checks and the plate-with-hole and curved-wall models from `tests/python/packages/cadgen/test_mesh_export_manifold.py`, into `scripts/common/tests/test_mesh_export_manifold.py`, run through `scripts/step`. The teacup model is original (a revolved, filleted bowl with a handle swept from a rounded rectangle). `--mesh-tolerance` can only tighten the default, so a fine case replaces upstream's coarse one. The teacup cases are expected failures: the handle's sliver triangles collapse when vertices are rounded for the file.

### Update Procedure

CAD-Pilot changes this skill directly; there is no upstream refresh. Keep `cad/LICENSE` and the attribution above with the files, and record notable changes under Local changes. From the workbench root, run `node tools/check.mjs`, which covers sample geometry, direct `scripts/step`/`scripts/inspect` generation and inspection, and the common/export suite. Also run `uv run pytest .agents/skills/cad/scripts/inspect -q` and the other CLI test directories you touched (`scripts/step`, `scripts/dxf`) one directory per command: their `test_cli.py` basenames overlap under pytest's default import mode. For Python dependency/API changes, also resolve afresh through the configured feeds. For guidance changes, check that viewing still routes to the maintained Explorer through the visual-review skill and that `@cad[...]` references stay with `scripts/inspect`. To adopt a later change from either upstream, review its license and diff, copy only what is needed and record its source revision here. Default print values are not measured calibration or manufacturing certification.

## visual-review

- Origin: authored for CAD-Pilot, not imported.
- Entry point: [visual-review/SKILL.md](./visual-review/SKILL.md).
- Repository: https://github.com/yxbh/CAD-Pilot
- Created: 2026-09-14.
- Basis: the owner's difficulty describing CAD shapes and communicating by pointing, plus the documented CAD Explorer reference workflow.
- Reference: https://github.com/cedrickchee/text-to-cad at `2dd54cf8e27dc71c92244dc47271dcf10d302e16`.
- Third-party text/code copied into this skill: none.
- License: no additional license granted here; follows the repository's policy.
- Local changes: original visual-feedback workflow using existing project notes rather than a required review form; capability-aware routing to the maintained CAD Explorer (Copilot `cad-explorer` canvas or the design-project viewer), separate handling of `cadproto:v2` descriptors versus the cad inspector's `@cad` references, display-only section-view guidance that distinguishes cut surfaces from native topology and measured clearances, and assembly-step guidance (agreeing the order, writing `gen_assembly()`, reporting the rigid sequence check and capturing steps). No third-party source modifications; record future imported material explicitly.

### Update Procedure

Validate changes using a real model, a selected reference or marked screenshot, and an ambiguous follow-up request. Check viewer choice both in the Copilot canvas and in a host using the design-project viewer, and keep the two reference formats distinct. Distinguish documented viewer capabilities from interactions actually tested with the chosen agent host.

## fdm-design

- Origin: authored for CAD-Pilot, not imported.
- Entry point: [fdm-design/SKILL.md](./fdm-design/SKILL.md).
- Repository: https://github.com/yxbh/CAD-Pilot
- Created: 2026-09-14.
- Basis: engine-independent FDM/FFF design review and calibration discipline, informed by Prusa manufacturer guidance and evaluation of existing community skills.
- Sources: [Prusa modeling guidance](https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135), [Prusa first-layer compensation](https://help.prusa3d.com/article/elephant-foot-compensation_114487), [Prusa PETG guidance](https://help.prusa3d.com/article/petg_2059), [SPIROL inserts](https://www.spirol.com/product/threaded-inserts-for-plastics/), and [Formlabs snap-fits](https://formlabs.com/blog/designing-3d-printed-snap-fit-enclosures/), reviewed 2026-09-14. These mutable manufacturer pages are linked, not vendored. Applicability and limitations are recorded in the skill.
- Existing skills reviewed, not imported: [swh/openscad-skill](https://github.com/swh/openscad-skill/blob/8c6313f44ffcad340c818a50347ab464eb2f59d7/openscad-bosl2/SKILL.md), revision `8c6313f44ffcad340c818a50347ab464eb2f59d7`, path `openscad-bosl2/SKILL.md`; [andreahaku/openscad_claude_skill](https://github.com/andreahaku/openscad_claude_skill/blob/c47ef2359a3329da45c3c2e6caa3c286133c2844/SKILL.md), revision `c47ef2359a3329da45c3c2e6caa3c286133c2844`, path `SKILL.md`. Reviewed 2026-09-14; rejected as whole imports because of engine/platform coupling and fixed workflow/numeric defaults. Their licenses were not relied upon to redistribute anything; verify licensing before any future copy.
- Scope: original FDM guidance with source links. Uses existing equipment and project notes; no profile schema, calibration database, or agent-evaluation framework.
- Third-party text/code copied into this skill: none; original synthesis with links, not redistribution of vendor documents or community skill files.
- License: no additional license granted here; follows the repository's policy. Linked sources retain their own licenses/terms.
- Local changes: original synthesis with supplier references and lightweight print-result guidance. No third-party source modifications; no CAD engine, slicer, or printer-control integration added.

### Update Procedure

Check source applicability and dates before revising guidance. Preserve unknown versus provisional versus measured values, and never promote rules of thumb to universal limits. Run the skill metadata/provenance checks; use actual design and print feedback to identify guidance worth improving or removing. Static checks do not prove agent compliance or manufacturing results. Record any future imported text/code with an immutable revision and its license before copying it.