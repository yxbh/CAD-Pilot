---
name: cad
description: Create, modify, inspect, and validate STEP-first build123d/Python CAD parts and assemblies. Use for natural-language CAD specs, STEP/STP generation, build123d source, build123d source-level joints, @cad references, geometry facts, measurements, mating deltas, and secondary DXF/STL/3MF outputs. Viewing and images go through the visual-review skill and the maintained CAD Explorer.
---

# CAD generation, inspection, and validation

## Purpose

Create or modify parametric CAD models from natural-language requirements, generate validated STEP/STP artifacts, inspect geometry references, and return checked outputs ready to show in the maintained CAD Explorer. Treat STEP as the primary CAD artifact. Treat DXF, STL, and 3MF as secondary workflows that branch from, or accompany, a STEP-first process. For assemblies, place parts in source from named mating datums, with explicit transforms or build123d joints, whichever states the relationship more clearly.

## Use this skill when

Use this skill when the user asks for CAD files, STEP/STP files, build123d source, `@cad[...]` references, mechanical parts, assemblies, enclosures, brackets, fixtures, holes, counterbores, countersinks, slots, pockets, bosses, standoffs, ribs, fillets, chamfers, shells, source-level joints, mating, or measurements.

Also use it when the user asks for DXF, STL, or 3MF output from CAD geometry. Keep those workflows secondary and load `dxf.md` or `supported-exports.md` for details.

To open, show, compare or capture a model, use the workbench's visual-review skill, which drives the maintained CAD Explorer; this skill does not start viewers.

Do not use this skill for render-only concept art, CAM toolpaths, engineering certification, FEA conclusions, architectural BIM, or freehand illustration unless the user also needs CAD geometry.

## Conventions and unknowns

Use these modeling conventions unless the user or project specifies otherwise:

- Units: millimeters.
- Origin: center of the main part or assembly unless a mating interface, rotation axis or fixed root component suggests a better origin.
- Base plane: XY.
- Up/extrusion axis: positive Z.
- Output geometry: closed, positive-volume solids unless the user requests surfaces or construction geometry.
- STEP structure: one valid solid, a compound of solids, or a labeled assembly compound.
- Assembly structure: fixed root part, part-local frames, named mating datums, and placements defined in source with explicit transforms or build123d joints, whichever states the relationship more clearly.

These are coordinate and file conventions, not physical requirements. Critical dimensions, fit, clearances, wall thickness, material, printer and nozzle are unknown until the user confirms them. Ask when a missing or conflicting value materially affects the result, such as the overall size of a physical object, a mating interface, a required scale or fit, or a safety, load, food-contact or compliance requirement. Ask one plain-language question at a time, and offer rough alternatives when the user may not know the answer. Otherwise proceed: put each inferred value in a named parameter, label it as a provisional assumption, and list it in the report so the user can confirm or change it. A published standard value, such as a clearance-hole table, is a starting proposal, not measured printer calibration.

## Natural-language specs only

Do not ask the user to provide a JSON specification and do not make JSON the user-facing workflow. Convert the user's prose, reference photos or drawings into an internal CAD brief with given dimensions, features, provisional assumptions, open questions, output paths, and checks. Use `references/natural-language-specs.md` for brief-writing patterns, reference images and technical drawings.

## Root model

Keep these roots separate:

- **CAD skill directory**: this folder. Tool launchers live here as `scripts/step`, `scripts/inspect`, and `scripts/dxf`.
- **Tool process cwd**: relative CAD targets are resolved from the command's current working directory. Use absolute target paths when running from the skill directory, or run from the design project's root and invoke the launchers with a path to this skill directory.
- **Viewer root**: the maintained CAD Explorer lives in the workbench's `explorer/` folder, not in this skill. The visual-review skill opens it from the design project's root with the same project-relative STEP path used for generation and inspection.

Short command examples in this skill use launcher paths relative to the CAD skill directory. Adapt the launcher path or target path so project CAD files resolve from the intended workspace, not accidentally under the skill directory.

Prefer keeping a STEP output and its Python generator in the same directory so the source stays easy to discover. Unless the user explicitly requests otherwise, keep the STEP basename and generator basename the same even when they cannot live side by side.

## Available tools

From the CAD skill directory, the launcher shape is:

```bash
python scripts/step ...
python scripts/inspect ...
python scripts/dxf ...
```

Use the active project Python interpreter. If only the repo-local virtualenv is available, invoke that interpreter while keeping the root model above explicit.

Use `python scripts/<tool> --help` for the complete current command interface; reference docs show recommended workflows, not every flag.

## Required workflow

1. **Classify the task.** Identify whether this is a new part, new assembly, source modification, direct STEP/STP inspection, reference selection, measurement/mating check, visual review, or secondary output request.
2. **Load only the needed references.** Use the triggers below instead of reading the whole reference set.
3. **Create a natural-language CAD brief.** Extract given dimensions, units, coordinate convention, feature intent, output paths, provisional assumptions, open questions, and checks. A simple part may need only a sentence.
4. **Plan before coding.** Define parameters, labels, source paths, expected bounding boxes, and any mating/positioning datums before editing.
5. **Edit source, not generated artifacts.** Prefer build123d Python with `gen_step()` for STEP generation.
6. **Generate explicit targets.** Use `scripts/step` for STEP/STP generation and sidecars. Use `--kind part` or `--kind assembly` only for direct STEP/STP imports. Do not run directory-wide generation.
7. **Check the saved geometry.** Choose checks from the requested dimensions, fits and topology: `scripts/inspect refs --facts --planes --positioning`, then targeted `refs --detail` (which reports hole radii and circle centres), `measure`, `mate`, `frame` or `diff`, and a short Python check on the saved STEP for what those commands cannot measure, such as minimum clearance or overlap volume. See `references/inspection-and-validation.md`.
8. **Show the model.** Use the visual-review skill to open the generated STEP in the maintained CAD Explorer, or to reload it after regenerating. See `references/rendering-and-explorer.md`.
9. **Review it yourself.** After creating or visibly changing geometry, capture the model in a separate review setup of the Explorer, so the user's camera stays put, from the one or two views that expose the changed features. Look at the images and turn any concern into a measurement. Capture again only after a repair changes visible geometry. See `references/rendering-and-explorer.md`.
10. **Repair and rerun.** If a check fails, change the smallest responsible source section, regenerate, and rerun the failed and affected checks. Never shrink, drop or approximate a specified feature to make a build or check succeed; report the limitation or ask for a design decision.

## Non-negotiables

- Treat generated STEP/STP, STL, 3MF, GLB/topology, DXF outputs, and Explorer sidecars such as `.assembly.json` as derived artifacts.
- Keep STEP as the primary validated CAD artifact; DXF/STL/3MF are secondary unless the user explicitly says otherwise.
- When a Python generator exists, run `scripts/step` on the generator. Use a direct STEP/STP target only when the generator is unavailable or the user explicitly identifies that STEP/STP file as the target.
- Use named parameters, closed solids, explicit labels, and source-controlled geometry intent.
- Author assembly positioning in source with part-local datums, explicit `Location` transforms, or build123d joints. Treat CLI `inspect mate` as read-only validation, not as a source-editing API.
- Do not use `git status`, `git diff`, or file-size churn as CAD comparison for large exported STEP/STP, GLB/topology, STL, 3MF, or DXF artifacts. Compare source changes, `scripts/inspect` summaries, or CAD Explorer views and captures instead; use path-limited git status only for bookkeeping.
- Report each check that actually ran with the geometry measured, the value and units, and the threshold it was compared against. A failed or skipped computation is not a pass, and a requirement nobody checked has no verdict.
- Keep kinds of evidence apart: kernel validity, measured requirements, visual review, slicer checks and physical tests each support only their own claims.
- If Explorer fails, say so and rely on CLI inspection for validation.

## Progressive references

Load these files only when their trigger applies:

- `references/natural-language-specs.md` — converting prose, reference images and technical drawings into a CAD brief, and when to ask.
- `references/step-generation.md` — STEP generation, direct STEP/STP targets, part-vs-assembly behavior, and post-generation inspection.
- `references/inspection-and-validation.md` — choosing checks, `@cad[...]` refs, facts, planes, topology, measurements, Python checks on the saved STEP, mating, diff, frame, and reporting checks.
- `references/positioning.md` — part-local datums, assembly transforms, build123d joints, mirrored parts, what CLI `mate` and `measure` do and do not show, and positioning reports.
- `references/rendering-and-explorer.md` — showing models in the maintained CAD Explorer, self-review captures, images for the user, and reporting visual review.
- `references/dxf.md` — secondary DXF workflow.
- `references/supported-exports.md` — secondary STL/3MF sidecar workflows.
- `references/build123d-modeling.md` — build123d modeling patterns, topology, selectors, features, assemblies, and placement, fillet, loft, Boolean and validity pitfalls.
- `references/repair-loop.md` — diagnosis and repair procedures.

Final responses should include generated files, the CAD Explorer URL when a model was shown, the checks actually run, provisional assumptions, open questions and untested requirements. Use `references/inspection-and-validation.md` for what to report.
