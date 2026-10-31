# Inspection and validation

Read this file for every generated STEP artifact and whenever the user asks for geometry facts, references, dimensions, mating, diffing, or frame inspection.

## Principle

Use programmatic geometry checks as the validation source of truth. Use CAD Explorer views and captures for visual review, not as substitutes for measurements, facts, planes, labels, or positioning checks.

## Tool

The launcher lives in the CAD skill directory:

```bash
python scripts/inspect {refs|parts|hygiene|clearance|diff|frame|measure|mate|worker|batch} ...
```

Inspection targets are resolved from the command cwd unless absolute. Keep the root model in `SKILL.md` explicit when choosing whether to run from the workspace root or the skill directory.

Any STEP file can be inspected: one `scripts/step` wrote, a download, another CAD program's export, or a file outside the design root given by an absolute or `../` path. A STEP without a current sidecar from `scripts/step` is read and indexed on first use, which takes a few seconds for a large model, into the per-user cache, and the index is reused until the file changes. The cache is `CAD_PILOT_CACHE` when set, otherwise `~/Library/Caches/cad-pilot` on macOS, `%LOCALAPPDATA%\cad-pilot\Cache` on Windows and `$XDG_CACHE_HOME/cad-pilot` (default `~/.cache/cad-pilot`) on Linux; entries unused for 30 days are removed, and deleting any of them only means the next inspect indexes that STEP again. A STEP saved over while it is being read is not indexed; run the command again. Part sizes and centres come from the exact geometry, so they are the same whether the STEP has a sidecar or was indexed into the cache. Nothing is written beside the STEP, so there is no need to run `scripts/step --kind` just to inspect a file.

`hygiene` and `clearance` exit with status 1 when they find something, 2 on an error and 0 when the check is clean. A part `hygiene` could not check is an error, listed under `errors`, and the result is not `clean`. Paths may be written with either separator, with `./` or an inner `..`, as for `scripts/step`.

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
- `parts` lists every part with its name, size, centre and occurrence ref; use it instead of reading names out of the STEP text.
- `refs --facts --planes --positioning` gives scale, solid counts, labels, major planes and selectors to measure from. `refs --detail` on a selector gives its geometry, including a circle edge's or cylinder face's radius and true centre or axis under `params`.
- `hygiene` finds what makes a part look or print like pieces stuck together: faces left split on one surface, extra solids, slivers, open, non-manifold or invalid geometry, and sharp edges against the project's comfort radius.
- `clearance` gives the minimum distance and any overlap between parts, as assembled and in every pose the generator declares.
- `measure` and `mate` give one-axis offsets and read-only alignment deltas between selections. Read `positioning.md` for what they do not show.
- `frame` gives the world frame of an occurrence or selected reference.
- `diff` compares before/after geometry for modifications.
- A short Python check on the saved STEP measures what the CLI cannot, such as mass properties or the gap between particular faces of parts that touch elsewhere.
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

`@cad[...]` selectors belong to one generated revision. Occurrence paths such as `o1.2`, and face and edge numbers, can change whenever the model is regenerated, including when the exporter changes how it writes the assembly tree. After regenerating, run `refs` again and take selectors from the new output; never reuse a saved `@cad` path, which can silently resolve to a different part.

## Parts

```bash
python scripts/inspect parts path/to/model.step --format text
```

Each part has its name and the path of groups someone labelled, size, bounding-box centre, the placement origin of its local frame, solid count, volume and an occurrence ref such as `@cad[path/to/model#o1.2]`. `scripts/step` writes a part nobody labelled under its group's name, `kit 1`, `kit 2`, and warns about it then; in a STEP from elsewhere, a part with no name is listed the same way and marked unlabelled. A name a CAD kernel made up, such as `COMPOUND` from build123d's `import_step` or `=>[0:1:1:3]`, counts as no name. A group nobody labelled is not written with a name, is left out of part paths and never matches a pattern; its parts are named after the group above it. CAD Explorer shows the same names. Part names are what `hygiene --parts`, `clearance`, `gen_poses()` and CAD Explorer's assembly steps match, with `*` and `?` as wildcards and a labelled group's name covering its parts; the file's own name is not a group, and a group holding every part, such as a labelled top-level assembly, never matches, so `Anchor *` written for an anchor's parts cannot catch an `Anchor v3` root.

## Geometry hygiene

```bash
python scripts/inspect hygiene path/to/model.step --round 1 --format text
```

Each finding names the part, says what is wrong in plain words, and gives the `@cad` refs of the faces and edges involved, plus a world position for edges:

- `solids`: a part is several separate solids, for example pieces that touch without being fused.
- `split-face`: two or more faces lie on one surface, the seam a viewer shows across a flat face.
- `sliver-face` and `short-edge`: faces narrower and edges shorter than `--sliver` (0.05 mm by default), usually left by a Boolean between nearly coincident faces.
- `open-edge`, `non-manifold`, `no-solid` and `invalid`: geometry that does not enclose a volume properly or fails the kernel's validity check.
- `sharp-edge` and `small-round`: with `--round R`, the project's comfort radius, convex edges whose faces meet at 15 degrees or more, and rounds smaller than R, measured by how sharply the rounded face curves across its tangent edge, spline fillets included. Without `--round` they are counted per part, not reported.

Use `--parts` to check some parts only. Parts with the same shape are checked once. A finding is a prompt to look, not a verdict: a crisp edge or a part made of several solids can be intended. Self-intersection is checked by `scripts/step` at generation, not here. `build123d-modeling.md` covers fusing before rounding and merging split faces.

## Clearance and poses

```bash
python scripts/inspect clearance path/to/model.step --format text
python scripts/inspect clearance path/to/model.step --poses path/to/model.py --format text
```

Without `--poses` it checks every pair of parts, or pairs among `--parts`, as assembled. With `--poses` it also checks every pose the generator's `gen_poses()` declares beside `gen_step()`. A pose moves named parts from where the STEP places them, by a build123d `Location` in world coordinates or an `(x, y, z)` offset in mm, so hinges, slides, insertion paths and lock positions are a list of poses:

```python
def gen_poses():
    hinge = Pos(0, HINGE_Y, HINGE_Z)
    return {
        "min_gap": 0.3,  # mm, a provisional fit unless the user confirmed it
        "pairs": [["lid", "box"], ["latch", "box", 0.2]],  # optional; a third value is that pair's own gap
        "poses": [
            *({"name": f"lid {a} deg", "move": {"lid": hinge * Rot(-a, 0, 0) * hinge.inverse()}} for a in range(5, 101, 5)),
            *({"name": f"latch {d} mm", "move": {"latch": (0, -d, 0)}} for d in (2, 4, 6)),
        ],
    }
```

A plain list of poses also works. `--min-gap` overrides the declared gaps. Each pair is reported worst first with its status: `overlap` with the largest shared volume and the poses where it happens; `tight` when closer than its required gap, touching included; `touching` for contact without overlap when no gap is required; `clear` otherwise. Distances are exact B-rep minimum distances with a pair of closest points. A pair is measured again only in poses that move one of its parts relative to the other, and a pair whose bounding boxes stay farther apart than `--horizon` (5 mm by default, or the pair's gap if larger) is reported as clear by at least that distance rather than measured.

It is a rigid check of the listed poses: it does not model flexing, threads, gravity or motion between poses, so sample a path finely enough for the features it passes. Parts that touch on purpose, such as a lid resting on a rim, report `touching`; when a gap between other faces of the same two parts matters, measure it with a Python check on those faces.

## Measurement checks

Use `measure` for signed offsets along one axis: part spacing, plate thickness between parallel faces, hole-centre-to-face distances, and alignment verification. It is not a clearance check: the gap between two bodies is a minimum distance, which `clearance` reports.

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

`scripts/inspect` reports each selection's geometry (`refs --detail`), one-axis offsets between selections, and clearance and overlap between whole parts. For mass properties, or the gap between particular faces of parts that touch elsewhere, write a short build123d script that reads the saved STEP. Run it from the design root with the workbench's Python interpreter. Put a throwaway check in a temporary folder outside the project, such as the system temp directory, or in a scratch folder the project already ignores. Keep a check worth rerunning in the project's existing test or check location. Never put checks in the skill directory or in the project's source or output folders.

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
- A check proves only the pose in the saved STEP. For a hinge, slider or lid with several positions, declare the poses in `gen_poses()` and run `clearance --poses`, or report which poses were not checked.
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
