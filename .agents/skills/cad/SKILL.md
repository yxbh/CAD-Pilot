---
name: cad
description: Model, generate, inspect and validate CAD parts and assemblies as build123d Python and STEP files with CAD-Pilot's tools, in any design project. Use for designing or changing a physical part, enclosure, bracket, fixture, mold or assembly from a description, photo or drawing; writing build123d source; generating STEP/STP, STL, 3MF or DXF; measuring, mating, clearance and hygiene checks on a STEP, including one from elsewhere; @cad references; and 3D-print handoff to Bambu Studio (project 3MFs, slicing checks, print orientation, fit coupons, hole and contour compensation).
---

# CAD generation, inspection, and validation

## Purpose

Turn natural-language requirements into parametric build123d source, generate STEP as the primary artifact (DXF, STL and 3MF are secondary outputs of the same run), check the saved geometry, and hand prints off as Bambu Studio projects. Showing models and images belongs to the visual-review skill, which drives CAD-Pilot's CAD Explorer; this skill does not start viewers. Use the fdm-design skill alongside this one before modeling or changing anything that will be 3D printed.

Do not use it for render-only concept art, CAM toolpaths, engineering certification, FEA conclusions, architectural BIM or freehand illustration unless the user also needs CAD geometry.

## Finding the workbench

This skill lives in a CAD-Pilot checkout at `<workbench>/.agents/skills/cad`. When it was loaded through a link, such as `~/.claude/skills/cad`, resolve the link first (`python -c "import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())" <skill dir>`): `<cad>` is the resolved skill directory and `<workbench>` is three levels above it. A design project's instructions may name the workbench instead. Never write design output inside the workbench or this skill.

## Running the tools

Run the launchers from the design project's root with an absolute interpreter path (a path containing `..` makes Python warn about `sys.prefix` on every run):

```bash
python <cad>/scripts/step ...
python <cad>/scripts/inspect ...
python <cad>/scripts/dxf ...
python <cad>/scripts/print ...
```

Use the design project's own Python environment when it has one with build123d (for a uv project, `uv run python <cad>/scripts/step ...`), so generators find the project's dependencies; otherwise use the workbench's `.venv` (`bin/python`, or `Scripts\python.exe` on Windows), created by `uv sync` in the workbench. Run `scripts/print` with the workbench's interpreter in any case: it needs mesh libraries that a design environment may lack. Relative targets resolve from the current folder. Choose the STEP location with `-o`, as a path relative to the design root; STL and 3MF sidecar paths are relative to the STEP's folder. Keep a STEP and its generator with the same basename, side by side unless the project's layout says otherwise. `--help` on each tool lists every flag; the references show workflows, not every option.

## Conventions and unknowns

Unless the user or project says otherwise: millimetres; origin at the centre of the main part or at a mating interface, rotation axis or fixed root part; XY base plane, +Z up; closed positive-volume solids; STEP as one solid, a compound of solids or a labelled assembly whose parts are placed in source from named datums, with explicit transforms or build123d joints.

These are coordinate and file conventions, not physical requirements. Critical dimensions, fit, clearances, wall thickness, loads, material, printer and nozzle are unknown until the user confirms them. Ask, one plain-language question at a time with rough alternatives when the user may not know, when a missing or conflicting value materially affects the result; otherwise put the inferred value in a named parameter, label it a provisional assumption and list it in the report. A published standard value, such as a clearance-hole table, is a starting proposal for the fit the user wants. Model the fit itself; the fdm-design skill keeps printer shrinkage out of the model.

Do not ask the user for JSON or a template. Convert their prose, photos or drawings into an internal CAD brief (`references/natural-language-specs.md`).

## Required workflow

1. **Classify the task**: new part or assembly, source change, inspection of a STEP, reference selection, measurement or mating check, visual review, secondary output or print.
2. **Load only the references whose trigger applies** (below).
3. **Write a CAD brief**: given dimensions and their sources, features, positioning datums, provisional assumptions, open questions, outputs and checks. A simple part may need one sentence.
4. **Plan before coding**: parameters, labels, paths, expected bounding boxes and mating datums.
5. **Edit source, not generated artifacts**: build123d Python with `gen_step()`.
6. **Generate explicit targets** with `scripts/step`; never directory-wide. Use `--kind part|assembly` only for a STEP/STP target.
7. **Check the saved geometry** with the checks the requirements call for (`references/inspection-and-validation.md`).
8. **Show the model** with the visual-review skill, also after each regeneration.
9. **Review it yourself** after creating or visibly changing geometry (`references/self-review.md`).
10. **Repair and rerun**: change the smallest responsible source section, regenerate, and rerun the failed and affected checks (`references/repair-loop.md`).

## Non-negotiables

- Never shrink, drop or approximate a specified feature or dimension to make a build or check succeed, by hand or by a retry ladder; report the limitation or ask for a design decision.
- Treat STEP/STP, STL, 3MF, DXF, the hidden topology GLB and Explorer sidecars such as `.assembly.json` as derived artifacts. Python source and named parameters own design intent; a STEP does not preserve parametric history.
- When a generator exists, run `scripts/step` on it; target a STEP/STP directly only when there is no generator or the user names that file.
- Author placement in source (datums, `Location` transforms or build123d joints); `inspect mate` only validates.
- Compare CAD revisions through source, `scripts/inspect` results or Explorer captures, never `git diff` or file-size churn of exported artifacts.
- Report each check that actually ran with the geometry measured, the value and units, and the threshold and where it came from. A failed or skipped computation is not a pass, and a requirement nobody checked has no verdict.
- Keep kinds of evidence apart: kernel validity, measured requirements, your visual review, the user's approval, slicer checks and physical tests each support only their own claims. Do not claim structural safety, process certification, tolerance compliance or manufacturability beyond geometric plausibility.
- Never send G-code to a printer, start a print or publish a model without the user's explicit approval.

## Progressive references

- `references/natural-language-specs.md`: turning prose, reference images and technical drawings into a CAD brief; when to ask.
- `references/step-generation.md`: generators, project imports, part names, direct STEP targets and the solid check.
- `references/inspection-and-validation.md`: choosing checks; `@cad[...]` refs, facts and planes, parts, hygiene, clearance across poses, measure, mate, frame, diff, Python checks on the saved STEP and reporting.
- `references/positioning.md`: part-local datums, transforms, build123d joints, and what `mate` and `measure` do and do not show.
- `references/build123d-modeling.md`: build123d patterns and the placement, fillet, loft, Boolean and validity pitfalls.
- `references/repair-loop.md`: diagnosing failed generation, solid-check warnings and failed checks.
- `references/self-review.md`: capturing and looking at a changed model, and reporting visual review.
- `references/supported-exports.md` and `references/dxf.md`: STL/3MF sidecars and DXF output.
- `references/print.md`: the print profile, print jobs, Bambu Studio projects, orientation and slice checks, fit and calibration coupons, hole and contour compensation.

Final responses list the generated files, the CAD Explorer URL when a model was shown, the checks that ran, provisional assumptions, open questions and untested requirements.
