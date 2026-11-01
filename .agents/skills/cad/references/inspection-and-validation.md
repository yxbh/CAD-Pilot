# Inspection and validation

Read this for every generated STEP and whenever the user asks for geometry facts, references, dimensions, mating, clearance, diffing or frames. Programmatic checks of the saved STEP are the source of truth; captures are for your own look (`self-review.md`), not a substitute.

## Tool

```bash
python <cad>/scripts/inspect {refs|parts|hygiene|clearance|diff|frame|measure|mate|worker|batch} ...
```

Targets are `path/to/model.step`, `path/to/entry` or `@cad[path/to/entry#selector]`, relative to the current folder unless absolute. Output is JSON unless `--format text`. `hygiene` and `clearance` exit 1 when they find something, 2 on an error and 0 when clean; a part `hygiene` could not check is an error and the result is not `clean`.

Any STEP can be inspected: one `scripts/step` wrote, a download, another CAD program's export, or a file outside the design root by an absolute or `../` path. Without a current sidecar from `scripts/step`, the STEP is indexed on first use (seconds for a large model) into the per-user cache: `CAD_PILOT_CACHE`, else `~/Library/Caches/cad-pilot` on macOS, `%LOCALAPPDATA%\cad-pilot\Cache` on Windows and `$XDG_CACHE_HOME/cad-pilot` on Linux. Entries unused for 30 days are removed, and deleting one only means the next inspect indexes again. A STEP saved over while it is read is not indexed; run the command again. Part sizes come from the exact geometry either way, and nothing is written beside the STEP.

## Choosing checks

Choose from the requirements: the dimensions the user gave, the fits and clearances that matter, the topology the part needs and what the edit could have disturbed. Check the saved STEP, not parameter constants or the in-memory shape; placement, export and labelling happen after `gen_step()` returns.

- `parts`: every part's name, size, centre and occurrence ref; use it instead of reading names out of the STEP text.
- `refs --facts --planes --positioning`: scale, solid counts, labels, major planes and selectors to measure from. `refs --detail` on a selector gives its geometry, including a circle edge's or cylinder face's radius and true centre or axis under `params`.
- `hygiene`: what makes a part look or print like pieces stuck together.
- `clearance`: minimum distance and overlap between parts, as assembled and in every declared pose.
- `measure` and `mate`: one-axis offsets and read-only alignment deltas; `positioning.md` says what they do not show.
- `frame`: the world frame of an occurrence or selection. `diff`: before/after geometry, when a change could have disturbed unrelated features.
- A short Python check on the saved STEP for what the CLI cannot measure.

Measure the feature that defines a dimension: a hole by its circle's radius and centre, a wall by the distance between its faces, a direction by a face normal.

## References

```bash
python <cad>/scripts/inspect refs path/to/model.step --facts --planes --positioning
python <cad>/scripts/inspect refs '@cad[path/to/model.step#selector]' --detail --positioning
python <cad>/scripts/inspect refs path/to/model.step --topology
```

Enumerate `--topology` only for selector discovery or debugging; it is expensive on large models. `--plane-limit`, `--plane-min-area-ratio` and `--plane-coordinate-tolerance` tune plane grouping.

`@cad[...]` selectors belong to one generated revision. Occurrence paths such as `o1.2` and face and edge numbers can change whenever the model is regenerated, including when the exporter changes how it writes the assembly tree. After regenerating, run `refs` again and take selectors from the new output; never reuse or translate a saved `@cad` path, which can silently resolve to a different part.

## Parts

```bash
python <cad>/scripts/inspect parts path/to/model.step --format text
```

Each part has its name and the path of labelled groups, size, bounding-box centre, local-frame origin, solid count, volume and an occurrence ref such as `@cad[path/to/model#o1.2]`. A part with a face nothing closes, as a damaged STEP leaves when its reader cannot resolve a reference (the reader says so on standard error), is marked unbounded and has no size, centre or box; `hygiene` names what is wrong with it. A part with no name, a name a kernel made up (`COMPOUND`, `SOLID` and other type names in capitals, `=>[0:1:1:3]`) or a name of digits alone, which other writers use for ids, is named after its group (`kit 1`, `kit 2`) and, in a STEP from elsewhere, marked unlabelled; an unlabelled group is left out of part paths. CAD Explorer shows the same names. `hygiene --parts`, `clearance`, `gen_poses()` and the Explorer's assembly steps match these names with `*` and `?`; a labelled group's name covers its parts, and a group holding every part, such as a labelled top-level assembly, never matches, so `Anchor *` cannot catch an `Anchor v3` root.

## Geometry hygiene

```bash
python <cad>/scripts/inspect hygiene path/to/model.step --round 1 --format text
```

Each finding names the part, says what is wrong in plain words and gives the `@cad` refs of the faces and edges involved, with a world position for edges:

- `solids`: a part is several separate solids, such as pieces that touch without being fused.
- `split-face`: several faces on one surface, the seam a viewer shows across a flat face.
- `sliver-face` and `short-edge`: narrower or shorter than `--sliver` (0.05 mm), usually left by a Boolean between nearly coincident faces.
- `open-edge`, `non-manifold`, `no-solid` and `invalid`: geometry that does not enclose a volume properly or fails the kernel's validity check.
- `sharp-edge` and `small-round`: with `--round R`, the project's comfort radius, convex edges whose faces meet at 15 degrees or more, and rounds tighter than R (spline fillets included). Without `--round` they are only counted.

`--parts` limits it to some parts; parts with the same shape are checked once. A finding is a prompt to look, not a verdict: a crisp edge or several solids can be intended. Self-intersection is checked by `scripts/step` at generation. `build123d-modeling.md` covers fusing before rounding and merging split faces.

## Clearance and poses

```bash
python <cad>/scripts/inspect clearance path/to/model.step --format text
python <cad>/scripts/inspect clearance path/to/model.step --poses path/to/model.py --format text
```

Without `--poses` it checks every pair of parts (or pairs among `--parts`) as assembled. With `--poses` it also checks every pose the generator's `gen_poses()` declares beside `gen_step()`. A pose moves named parts from their STEP placement by a build123d `Location` in world coordinates or an `(x, y, z)` offset in mm, so hinges, slides, insertion paths and lock positions are lists of poses:

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

A plain list of poses also works, and `--min-gap` overrides the declared gaps. Each pair is reported worst first: `overlap` with the largest shared volume and the poses where it happens; `tight` when closer than its required gap, touching included; `touching` for contact without overlap when no gap is required; `clear` otherwise. Distances are exact B-rep minimum distances with a pair of closest points. A pair is measured again only in poses that move one of its parts relative to the other, and a pair whose bounding boxes stay farther apart than `--horizon` (5 mm, or the pair's gap if larger) is reported clear by at least that distance.

It checks the listed poses only, rigidly: no flexing, threads, gravity or motion between poses, so sample a path finely enough for the features it passes, and report which poses were not checked. Use clearance for "at least this gap" requirements and overlap for "must not intersect", and list deliberate press fits or contacts you excluded rather than inferring exclusions from the hierarchy. Parts that touch on purpose, such as a lid on a rim, report `touching`; when a gap between other faces of those parts matters, measure those faces in Python.

## Measure, mate, frame and diff

```bash
python <cad>/scripts/inspect measure --from '@cad[path/to/model.step#a]' --to '@cad[path/to/model.step#b]' --axis x
python <cad>/scripts/inspect mate --moving '@cad[path/to/assembly.step#moving]' --target '@cad[path/to/assembly.step#target]' --mode flush --axis z
python <cad>/scripts/inspect frame '@cad[path/to/model.step#selector]'
python <cad>/scripts/inspect diff path/to/before.step path/to/after.step --planes
```

`measure` gives signed offsets along one axis (spacing, plate thickness, hole-centre-to-face distances); give `--axis` for deterministic checks. It is not a clearance check. `mate` returns a read-only translation delta and the selections' direction relationship; apply any correction in source and regenerate. `frame` validates occurrence transforms and part-local-to-world conversion. Use `diff` when a repair or edit could affect unrelated geometry, and rerun the measurements that should not have changed.

## Python checks on the saved STEP

For mass properties, or the gap between particular faces of parts that touch elsewhere, write a short build123d script that reads the saved STEP and run it from the design root with the tools' interpreter. Put a throwaway check in the system temp folder or a scratch folder the project ignores, and one worth rerunning in the project's existing test location; never in the skill directory or the project's source or output folders.

```python
import sys

from build123d import Axis, Compound, import_step

assembly = import_step(sys.argv[1])
parts = {child.label: child for child in assembly.children}
base, lid = parts["base"], parts["lid"]

# The lid rests on the rim, so the parts touch; the gap that matters is between the lid's lip (below Z = 5)
# and the base's inner walls (inside X = ±19).
lip = Compound(lid.faces().filter_by(Axis.Z, reverse=True).filter_by(lambda face: face.center().Z < 5))
walls = Compound(base.faces().filter_by(Axis.Z, reverse=True).filter_by(lambda face: abs(face.center().X) < 19))
gap, on_lip, on_wall = lip.distance_to_with_closest_points(walls)
print(f"lip to inner walls: minimum {gap:.3f} mm, between {on_lip} and {on_wall}")
```

Notes for build123d 0.13:

- An imported assembly's top-level children keep their labels and world placement. Deeper levels can come back with generic names such as `ASSEMBLY` or `SOLID`, and their `.children` report placements relative to their parent; measure world geometry through `.solids()` and identify nested occurrences with `scripts/inspect`.
- `distance_to_with_closest_points` is zero for touching and overlapping bodies alike and says nothing about overlap depth. Select specific faces by position or normal and wrap each list in `Compound(...)` before measuring.
- A reversed solid reads as positive after STEP export, so the saved STEP cannot show it; see Validity in `build123d-modeling.md`.

## Reporting checks

Follow the skill's Non-negotiables for what a reported check must say. Shape the report to the task: a single plate needs a few lines, an assembly with fits needs its interfaces.

```text
Checks (models/enclosure.step):
- Generation: passed; 2 solids, labels base and lid, all valid; source solids' volumes positive.
- Overall size: 120.00 × 80.00 × 35.00 mm (required 120 × 80 × 35).
- Lid seating: base top / lid underside Z delta 0.00 mm, faces opposed.
- Screw holes: circle centres at (±52, ±32) mm, offsets ≤ 0.01 mm from the bosses; radius 1.25 mm (provisional, printer fit not confirmed).
- Lid lip to base inner walls: minimum clearance between those faces 0.30 mm (provisional target ≥ 0.30 mm); clearance reports no overlap.
- Visual review: iso and front-section captures checked the bosses and wall; no concerns.
- Not checked: snap-fit deflection, print orientation, physical fit.
```

The values are illustrative, not defaults.
