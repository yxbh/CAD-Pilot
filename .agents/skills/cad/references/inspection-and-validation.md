# Inspection and validation

Read this file for every generated STEP artifact and whenever the user asks for geometry facts, references, dimensions, mating, diffing, or frame inspection.

## Principle

Use programmatic geometry checks as the validation source of truth. Use CAD Explorer views and captures for visual review, not as substitutes for measurements, facts, planes, labels, or positioning checks.

## Tool

The launcher lives in the CAD skill directory:

```bash
python scripts/inspect {refs|diff|frame|measure|mate|worker|batch} ...
```

Inspection targets are resolved from the command cwd unless absolute. Keep the root model in `SKILL.md` explicit when choosing whether to run from the workspace root or the skill directory.

Common data-output flags on most commands:

- `--format json|text`; default is machine-readable output.
- `--quiet`
- `--verbose`

Accepted target forms:

```text
@cad[path/to/entry#selector]
path/to/entry
path/to/entry.step
```

## Relationship to build123d joints

If the source uses build123d `Joint` objects, validate the generated STEP exactly as you would validate explicit `Location` placements. Source-level joints express and compute placement during generation; CLI `inspect mate` verifies the exported result by returning a translation delta between selected references. Do not confuse CLI `mate` with build123d `Joint.connect_to()`. Use `positioning.md` for authoritative source-authoring rules.

## Choosing checks

Choose checks from the requirements: the dimensions the user gave, the fits and clearances that matter, the topology the part needs, and what the edit could have disturbed. There is no fixed sequence or universal report. Typical tools:

- Generation completed and the STEP/STP file exists; a failed generation leaves nothing to check.
- `refs --facts --planes --positioning` gives scale, solid counts, labels, major planes and selectors to measure from. `refs --detail` on a selector gives its geometry, including a circle edge's or cylinder face's radius and true centre or axis under `params`.
- `measure` and `mate` give one-axis offsets and read-only alignment deltas between selections. Read `positioning.md` for what they do not show.
- `frame` gives the world frame of an occurrence or selected reference.
- `diff` compares before/after geometry for modifications.
- A short Python check on the saved STEP measures what the CLI cannot: minimum clearance, overlap volume and mass properties.
- Your own look at Explorer captures catches what nobody thought to measure (see `rendering-and-explorer.md`). Turn every visual concern into a measurement before claiming it is resolved.

Check the saved STEP rather than parameter constants or the in-memory shape: placement, export and labelling happen after `gen_step()` returns.

## Reference discovery

Compact facts and planes:

```bash
python scripts/inspect refs path/to/model.step \
  --facts --planes --positioning
```

Detailed selector inspection:

```bash
python scripts/inspect refs '@cad[path/to/model.step#selector]' \
  --detail --positioning
```

Topology enumeration, only when needed:

```bash
python scripts/inspect refs path/to/model.step --topology
```

Plane options:

```bash
--plane-coordinate-tolerance FLOAT
--plane-min-area-ratio FLOAT
--plane-limit INT
```

Use lower plane limits and compact facts for normal validation. Use topology enumeration only for selector discovery, complex debugging, or when a feature cannot be verified through facts/planes/measurements.

## Measurement checks

Use `measure` for signed offsets along one axis: part spacing, plate thickness between parallel faces, hole-centre-to-face distances, and alignment verification. It is not a clearance check: the gap between two bodies is a minimum distance, which needs the Python check below.

```bash
python scripts/inspect measure \
  --from '@cad[path/to/model.step#selector_a]' \
  --to '@cad[path/to/model.step#selector_b]' \
  --axis x
```

Axis may be inferred when possible, but specify `x`, `y`, or `z` for deterministic checks.

## Mating checks

Use CLI `mate` when two exported STEP references should be flush or centered. It returns a read-only translation delta (along one axis in flush mode) and the relationship between the selections' directions; read `positioning.md` for what that does not show. It does not edit source files and does not replace native build123d joints in source. When source uses build123d `Joint`/`connect_to()` placement, still validate the resulting exported geometry with `refs --positioning`, `frame`, `measure`, or CLI `mate`.

```bash
python scripts/inspect mate \
  --moving '@cad[path/to/assembly.step#moving_selector]' \
  --target '@cad[path/to/assembly.step#target_selector]' \
  --mode flush \
  --axis z
```

Apply any required correction in the Python source using build123d joint definitions, `.connect_to()` calls, `Location`, parameter changes, or assembly child placement. Regenerate and re-inspect.

## Frame inspection

Use `frame` to validate occurrence transforms and selected-reference world frames:

```bash
python scripts/inspect frame '@cad[path/to/model.step#selector]'
```

Frame output is useful for assemblies, part-local-to-world conversion, and placement debugging.

## Diff checks

For modification tasks, compare before and after artifacts:

```bash
python scripts/inspect diff path/to/before.step path/to/after.step --planes
```

Use diff when a repair, feature addition, or source edit could affect unrelated geometry.

## Python checks on the saved STEP

`scripts/inspect` reports each selection's geometry (`refs --detail`) and one-axis offsets between selections. For the minimum clearance between bodies, overlap volume and mass properties, write a short build123d script that reads the saved STEP. Run it from the design root with the workbench's Python interpreter. Put a throwaway check in a temporary folder outside the project, such as the system temp directory, or in a scratch folder the project already ignores. Keep a check worth rerunning in the project's existing test or check location. Never put checks in the skill directory or in the project's source or output folders.

```python
import sys

from build123d import import_step

assembly = import_step(sys.argv[1])
parts = {child.label: child for child in assembly.children}
base, lid = parts["base"], parts["lid"]


def overlap_mm3(a, b):
    common = a & b  # None when the bodies do not overlap
    return 0.0 if common is None else sum(solid.volume for solid in common.solids())


gap, on_base, on_lid = base.distance_to_with_closest_points(lid)
print(f"base-lid minimum clearance: {gap:.3f} mm, between {on_base} and {on_lid}")
print(f"base-lid overlap: {overlap_mm3(base, lid):.3f} mm3")
print("all solids valid:", all(solid.is_valid for solid in assembly.solids()))
```

Notes for build123d 0.13:

- The top-level children of an imported assembly keep their labels and world placement. Deeper levels can come back with generic names such as `ASSEMBLY` or `SOLID`, and their `.children` report placements relative to their parent. Measure world geometry through `.solids()`, and use `scripts/inspect refs` to identify nested occurrences.
- `distance_to_with_closest_points` returns the minimum distance and one pair of closest points. It is zero for touching and for overlapping bodies alike, and it does not measure how deep an overlap goes. When parts touch on purpose, such as a lid resting on a rim, measure clearance between the specific faces that must stay apart: select them from `lid.faces()` and `base.faces()` by position or normal, and wrap each list in `Compound(...)` before measuring.
- Overlap volume is exact for the bodies given and zero for mere contact. Minimum clearance and overlap volume are different measurements: use clearance for "at least this gap" requirements and overlap for "these must not intersect" requirements, and report which one ran.
- A reversed solid passes `is_valid` with a negative `.volume`, and an assembly total can hide it. STEP export and re-import report it as positive, so the saved STEP cannot show it. Check `.volume` on each solid of the in-memory shape instead, for example `[solid.volume for solid in runpy.run_path("models/enclosure.py")["gen_step"]().solids()]`.
- A check proves only the pose in the saved STEP. For a hinge, slider or lid with several positions, check each pose that matters, or report which were not checked.
- Choose pairs from the question, such as a moving part against the parts it passes, and list deliberate press fits or contacts you excluded. Do not infer exclusions from the assembly hierarchy.

Measure the feature that defines the dimension: a circle edge's or cylinder face's radius and centre for holes and patterns (`params` in `refs --detail`, or `arc_center` and `radius` in Python), the distance between two faces for a wall, a face normal for direction. A bounding box is an envelope, and its centre is not a datum; see `positioning.md` for what CLI `mate` and `measure` do and do not show.

## Showing the model in CAD Explorer

For every final response involving a STEP/STP artifact, show it in the maintained CAD Explorer when the host can display it, and return the Explorer URL. Use `rendering-and-explorer.md` and the visual-review skill to open it. If an important selector was inspected, return the textual `@cad[...]` reference beside the Explorer URL.

## Reporting checks

Report only checks that actually ran or are directly supported by tool output. For each one, say what was measured (labels or selectors), the value with units, and the threshold or requirement it was compared against. Say where a threshold came from: the user's requirement, a drawing callout, or your own provisional choice.

- A failed or inconclusive computation is not a pass. Report it as failed or not checked, with the error.
- A requirement or relationship nobody tested has no verdict. List it as not checked rather than leaving it out.
- One pose proves only that pose; name the poses checked.
- Keep kinds of evidence apart: kernel validity, measured requirements, your visual review, the user's visual approval, slicer checks and physical tests each support only their own claims.

Shape the report to the task. A single plate needs a few lines; an assembly with fits needs its interfaces. For example:

```text
Checks (models/enclosure.step):
- Generation: passed; 2 solids, labels base and lid, all valid; source solids' volumes positive.
- Overall size: 120.00 × 80.00 × 35.00 mm (required 120 × 80 × 35).
- Lid seating: base top / lid underside Z delta 0.00 mm, faces opposed.
- Screw holes: circle centres at (±52, ±32) mm, offsets ≤ 0.01 mm from the bosses; radius 1.25 mm (provisional, printer fit not confirmed).
- Lid lip to base inner walls: minimum clearance between those faces 0.30 mm (provisional target ≥ 0.30 mm); no overlap between the bodies.
- Visual review: iso and front-section captures checked the bosses and wall; no concerns.
- Not checked: snap-fit deflection, print orientation, physical fit.
```

The values above are illustrative, not defaults.

Do not claim:

- structural safety
- process certification
- tolerance compliance
- manufacturability beyond geometric plausibility
unless the relevant analysis or manufacturing data was explicitly performed.
