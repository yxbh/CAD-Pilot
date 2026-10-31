# STEP generation

Read this file when generating or regenerating STEP/STP artifacts from build123d Python source or from direct STEP/STP targets.

## Tool

The launcher lives in the CAD skill directory:

```bash
python scripts/step [--kind {part|assembly}] targets... [flags]
```

Use explicit target paths only. Target paths are resolved from the command cwd unless absolute. When running from a workspace root, prefix the launcher path with the CAD skill directory; when running from the skill directory, pass absolute or correctly relative workspace target paths. Do not rely on directory-wide generation.

## Generated Python source

Generated build123d sources should define:

```python
def gen_step():
    ...
    return shape_or_compound
```

Generated Python targets infer their kind from the source metadata and `gen_step()` envelope; pass the source path directly. When a generator exists, this is the preferred way to run `scripts/step`.

```bash
python scripts/step path/to/part.py
python scripts/inspect refs path/to/part.step --facts --planes --positioning
```

```bash
python scripts/step path/to/assembly.py
python scripts/inspect refs path/to/assembly.step --facts --planes --positioning
```

Passing a generated assembly `.step` directly treats it as imported native STEP. Pass the `.py` assembly source when source-level assembly composition must be preserved.

## Direct STEP/STP targets

Use direct STEP/STP targets only when the generator is unavailable or the user explicitly identifies a STEP/STP file as the target:

```bash
python scripts/step --kind part path/to/imported.step
python scripts/inspect refs path/to/imported.step --facts --planes --positioning
```

Direct targets can use sidecar mesh flags, but generator targets remain preferred when a generator exists. Read `supported-exports.md` for STL and 3MF sidecars.

## Adjacent inspection artifacts

`scripts/step` generates the explicit STEP target and an adjacent hidden GLB with topology data (`.<name>.step.glb`). `scripts/inspect` reads `@cad` selectors and topology from it, so regenerate it with the STEP rather than editing or deleting it. Do not require a separate validation subcommand for it. The maintained CAD Explorer reads the STEP itself and does not need this file.

Use `rendering-and-explorer.md` to show the generated STEP in the maintained CAD Explorer.

## Solid checks

`scripts/step` checks the solids of each generated part and prints a warning naming the part, and its source file, when it finds a problem: faces that do not enclose a volume, an open shell, an inside-out solid, or a solid the boolean kernel's argument check rejects (`common.geometry.is_sound`), with the number of self-intersections. The STEP, hidden GLB and requested STL/3MF are still written; the warnings are not a gate. A self-intersecting solid's STL and 3MF cannot be guaranteed closed, and later booleans or slicers can fail on it, so repair it as `repair-loop.md` describes before printing.

The kernel check runs in a separate process while the meshes are exported, once per unique solid, so placed copies share a check. When the kernel cannot finish on the solid as modelled, it retries the solid as read back from the written STEP, and a fault found only there is reported as such. Most parts add well under a second, but the kernel can take seconds on large spline-heavy parts and minutes on a few shapes, such as a swept coil whose turns overlap, so each solid gets 10 s and each generated part 30 s in all; on a busy machine, set `CAD_SOLID_CHECK_TIME_SCALE` to a number above 1 to stretch both. A solid that runs out of time, or that the kernel cannot finish even on the read-back, is reported in a `notice: could not check` line; treat it as unverified, not as sound. Pass `--no-solid-check` to skip the check.

Assemblies that only place other STEP files are not checked again: each generated part is checked when its own source is generated, and direct STEP/STP targets, such as vendor parts, are not checked.

## Post-generation inspection

Run lightweight inspection after generation with `scripts/inspect`.

Rules:

- Use facts and plane grouping for normal generation.
- Add positioning facts when the model has mating faces, assembly children, datums, or repeated features.
- Add topology only when selector enumeration is needed; it can be expensive on large models.

Recommended inspection:

```bash
python scripts/inspect refs path/to/model.step --facts --planes --positioning
```

For selector-heavy validation:

```bash
python scripts/inspect refs path/to/model.step --topology
```

## Generation checklist

Before running the command:

- Confirm the user request has been converted into a natural-language CAD brief.
- Confirm the source defines `gen_step()`.
- Prefer the Python generator over a generated STEP/STP file when both are available.
- Confirm labels are assigned for exported parts and assembly children.
- Confirm the target path is explicit.
- Confirm expected bbox, labels, and positioning checks are known.

After running the command:

- Confirm the process succeeded.
- Read any warnings and notices; treat a solid warning as a defect to repair, and a `could not check` notice as an unverified part.
- Confirm the STEP file exists and is non-empty.
- Run the relevant `scripts/inspect` command and parse its output.
- Show the STEP in CAD Explorer using `rendering-and-explorer.md`, or report why it is unavailable. After a visible geometry change, capture and look at it yourself as its Self-review section describes.
- Continue with targeted inspection if facts/planes are insufficient.
