# Repair loop

Read this file when generation, export, inspection, positioning, Explorer viewing or capture, or documentation validation fails, or when `scripts/step` warns that a part is not a sound solid.

## Loop

1. Read the failing command output.
2. Classify the failure and find the first operation that goes wrong.
3. Make the smallest responsible source or command change.
4. Rerun the failed command.
5. Rerun any dependent validation checks.
6. Report remaining risk or deliberate deviations.

Preserve specified features and dimensions. Never shrink, drop or approximate a specified feature to make a build or check pass. If the requirement cannot be met as stated, report it and ask for a design decision.

## Failure classes and fixes

### Source import or syntax failure

Likely causes:

- invalid Python syntax
- missing import
- wrong build123d symbol
- function not named `gen_step()`
- executable code outside the intended function has side effects

Fix:

- correct imports and syntax
- ensure `gen_step()` returns the STEP-ready shape or compound
- keep output paths in CLI commands, not inside `gen_step()`

### Invalid or missing geometry

Likely causes:

- open sketch
- subtractive profile outside target
- zero thickness
- boolean operation failed
- construction geometry used as exported geometry
- a solid with reversed orientation (negative `.volume`) that still passes `is_valid`

Fix:

- close profiles intended to become faces
- verify dimensions are positive
- make subtractive tools pass through when through-cuts are intended
- check `is_valid`, solid count and `.volume` of each solid on intermediates around the suspect operation to find the first one that goes wrong
- rebuild that feature on its own, then add the rest back

### Self-intersecting solid

`scripts/step` warns that a part `is not a sound solid`, often with a count of self-intersections, although `is_valid` can still be true. `common.geometry.is_sound(part)` returns `False`, and `self_intersections(part)` returns the faces that cross.

Likely causes:

- a sweep whose profile reaches farther toward the inside of a bend than the bend's radius, so the inner side folds back through itself, such as a thick handle around a tight curve
- other surfaces that cross each other, such as a loft through a self-crossing section

Fix:

- check `is_sound` on intermediates to find the first operation whose result is not sound
- for a sweep, compare the profile's reach on the inside of each bend with the path's tightest bend radius; on a planar path, a sketch on `path ^ 0` puts its local X, the first dimension of a `Rectangle`, in the bend plane
- ease the tightest bend of the path, or turn or reshape the profile so its inner side stays within the bend radius; changing a specified dimension is a design decision, so report the limit and ask
- regenerate and confirm the warning is gone before exporting meshes for printing

### Fillet or chamfer failure

Likely causes:

- edges selected before a later operation that replaced them; on build123d 0.13 the fillet error then suggests a smaller radius even though the selection is the cause
- radius/length exceeds local geometry
- selected edges include tiny or unintended edges
- boolean operation created complex edge topology

Fix:

- reselect the edges from the final solid, and test a held selection with `edge in solid.edges()`
- filter selected edges more narrowly, or split edge groups by feature intent
- apply fillets later in the model, or build the rounding or bevel into the profile
- use `solid.max_fillet(edges, max_iterations=20)` to see how much room there is; the default 10 iterations often fail on build123d 0.13
- changing a specified radius or length is a design decision: report the limit and ask, or record the user's decision, rather than reducing it silently

### Loft failure or twisted surface

Likely causes:

- sections sampled in different orders, start points or directions
- a disconnected or self-crossing section
- interpolation that adds flat bands or ripples

Fix:

- sample every section the same way and check each section wire on its own
- loft adjacent pairs to locate the failing region; a passing pair does not prove the full loft
- compare volume or a cross-section with expectations, and capture the surface from the side
- for a rotationally symmetric shape, revolve a profile instead

### Boolean returns the wrong result or runs slowly

Likely causes:

- bodies that only touch along an edge or tangent face, so a fuse returns two solids
- coincident or near-tangent faces between the body and the tool
- many overlapping tools, or tools that reach far past the material
- large spline surfaces

Fix:

- check the solid count and the added or removed volume, not only that the operation returned
- overlap bodies that must become one part, or build the outline as one profile
- time the suspect operation; combine independent cuts, trim tool extents, or construct the same feature differently
- keep the feature: being slow or small on screen is not a reason to remove it

### Wrong scale or bounding box

Likely causes:

- units mismatch
- mistaken diameter/radius
- extrusion direction or amount wrong
- part not centered as assumed, for example a primitive created with `align=None`
- `.located()` used after a rotation, replacing it
- direct imported STEP uses unexpected units

Fix:

- check parameter values
- inspect facts and planes
- measure critical extents
- correct source dimensions or import handling

### Missing feature

Likely causes:

- wrong `Mode.ADD`/`Mode.SUBTRACT`
- feature profile not inside target
- blind cut too shallow
- selector changed after prior operation

Fix:

- confirm feature mode
- increase cut length for through-cuts
- inspect topology or planes
- regenerate and measure/check feature-specific refs

### Selector fragility

Likely causes:

- arbitrary index selection
- topology changed after fillet or boolean
- similar faces/edges are indistinguishable

Fix:

- select by axis, plane, position, normal, or inspected reference
- use `refs --facts --planes --positioning` to rediscover stable references
- add construction datums or simplify operations if needed

### Positioning, joint or mating mismatch

Likely causes:

- wrong fixed/root component, or `.connect_to()` moved the part meant to stay fixed
- wrong part-local origin
- child `Location` offset wrong, or not recomputed after a parameter change
- `.located()` used where `.moved()` or `Location * shape` should compose the placement
- joint location defined in world coordinates when a part-local datum was intended
- build123d joint attached to the wrong datum, or duplicate or incorrect joint labels
- joint axis or orientation inverted, or rotation applied about the wrong axis
- a mirrored part still carrying the original's joints
- sign error in symmetric placement
- mating face selected incorrectly, shown by a `parallel` rather than `opposed` vector relationship
- CLI `inspect mate` delta treated as an edit instead of a diagnostic

Fix:

- inspect `refs --positioning` and run `frame` on the affected occurrences
- run `mate` for the read-only delta and check the reported direction relationship; check the other axes and the minimum clearance separately
- verify the build123d joint labels and `joint_location` definitions
- apply the smallest correction to the joint location, axis, angle, position, `.connect_to()` call, explicit transform, datum or feature offset
- regenerate the assembly from the Python source
- rerun `refs --facts --planes --positioning` to rediscover selectors, which can change on regeneration, then rerun the failed `measure`, `mate` or Python check

### Explorer open failure

Likely causes:

- Node unavailable
- the workbench's Explorer is not built (`open` prints the build command)
- `open` was run from a different folder than the design project's root
- the STEP path is not relative to that root, or the STEP was not generated

Fix:

- build the Explorer as its README describes, or report that it needs building
- rerun `explorer.mjs open path/to/model.step` from the design project's root
- report the failure if unresolved; do not switch to another viewer
- rely on CLI facts/measurements for validation

### Capture failure

Likely causes:

- no viewer page is open (the capture reports the URL to open)
- the page did not finish drawing before the timeout, for example just after it was opened (retry once)
- the output path is outside the design project

Fix:

- open the reported URL, then capture again
- use a project-relative `.png` path
- skip the capture if it is not needed for validation

## Diff after repair

Use `diff` when the fix might have affected unrelated geometry:

```bash
python scripts/inspect diff path/to/before.step path/to/after.step --planes
```

Also rerun the measurements that should not have changed, such as unaffected dimensions, volumes and mating relationships, resolving references afresh in each revision.

## Reporting failed repairs

If a check cannot be repaired in the current environment, report:

```text
- what failed
- what was tried
- which artifact is still usable
- which validation claims cannot be made
- what the next source-level correction should be
- which requirements remain untested or unresolved
```
