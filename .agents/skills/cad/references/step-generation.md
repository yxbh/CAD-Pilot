# STEP generation

Read this when generating or regenerating STEP/STP from build123d source or from a direct STEP/STP target.

## Generators

```bash
python <cad>/scripts/step [--kind {part|assembly}] targets... [-o out.step] [flags]
```

A generator defines `gen_step()` returning a solid, compound or labelled assembly; output paths belong on the command line, never inside it. Pass the `.py` source directly; its kind comes from the source. Passing a generated assembly `.step` instead treats it as imported native STEP and loses the source-level composition.

```bash
python <cad>/scripts/step models/enclosure.py -o models/enclosure.step
python <cad>/scripts/inspect refs models/enclosure.step --facts --planes --positioning
```

### Project imports and dependencies

A generator imports modules beside it, at the design root and in the root's `src/` packages, with no `sys.path` code of its own; lazy imports inside `gen_step()` work too. Each load drops the project modules earlier loads imported and compiles the generator and its modules from source, so same-named sibling modules in different generators stay separate and an edit is seen even within the same second; a project module may share a name with a tools module such as `common`. Third-party packages come from the interpreter running the tool (see the skill's Running the tools); a module it cannot import is reported in one line naming the module and the interpreter.

### Part names

Label every part you export. An unlabelled placed part is named after its group (`kit 1`, `kit 2`, or the group's name when it is the only child), and `scripts/step` prints one warning listing them; identical unlabelled copies still share one shape. A group nobody labelled has no name in the STEP and never matches a part pattern; label a group to name its parts together. `.solids()`, a `Solid`'s `.fillet()`, `Part(...)` and `import_step` (whose `COMPOUND` counts as no label) return unlabelled shapes, so set labels after the last operation. `scripts/inspect parts` lists the names the STEP ended up with.

## Direct STEP/STP targets

Use one only when there is no generator or the user names the file:

```bash
python <cad>/scripts/step --kind part path/to/imported.step --stl imported.stl
```

This is for writing sidecar meshes. To inspect a STEP, run `scripts/inspect` on it directly; it indexes any STEP itself.

## Outputs

Besides the STEP and any requested sidecars (`supported-exports.md`, `dxf.md`), `scripts/step` writes a hidden `.<name>.step.glb` topology index beside the STEP. `scripts/inspect` reads `@cad` selectors from it while it matches the STEP and otherwise indexes the STEP into its per-user cache, so a missing or stale GLB is never an error for inspect; never edit it. An assembly that places generated or imported STEP files needs each one's GLB to be current: when any is missing or was written by older tools, `scripts/step` stops and names them all, to be generated again before the assembly. When a rebuild renumbers faces and edges, or changes a STEP whose previous index it cannot read, `scripts/step` warns once if face or edge refs were handed out for the previous build.

## Solid check

`scripts/step` checks each generated part's unique solids and warns, naming the part and its source, about faces that do not enclose a volume, an open shell, an inside-out solid, or a solid the kernel's argument check rejects (`common.geometry.is_sound`), with its self-intersection count. Outputs are still written; the warning is not a gate, but a self-intersecting solid's meshes cannot be guaranteed closed and later Booleans or slicers can fail on it, so repair it (`repair-loop.md`) before printing.

The check runs in a worker process while meshes export. If the kernel cannot finish on the modelled solid, it retries on the solid read back from the STEP and says when a fault appears only there. Each solid gets 10 s and each part 30 s; `CAD_SOLID_CHECK_TIME_SCALE` above 1 stretches both on a busy machine. A `notice: could not check` line means the part is unverified, not sound. `--no-solid-check` skips it. Assemblies that only place other STEP files and direct STEP targets are not checked.

## After generating

- Confirm the command succeeded and the STEP exists; do not mistake an older artifact for a new build.
- Read every warning and notice: a solid warning is a defect to repair, a `could not check` notice an unverified part.
- Inspect the saved STEP (`inspection-and-validation.md`): `refs --facts --planes --positioning` for normal generation, adding `--topology` only when you need to enumerate selectors.
- Show it with the visual-review skill, and review it yourself after a visible change (`self-review.md`).
