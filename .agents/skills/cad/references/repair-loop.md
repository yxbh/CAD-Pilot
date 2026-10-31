# Repair loop

Read this when generation, export, inspection or a positioning check fails, or when `scripts/step` warns about a part's solid.

1. Read the failing command's output and find the first operation that goes wrong: check `is_valid`, `is_sound`, the solid count and each solid's `.volume` on intermediates around the suspect operation, or rebuild that feature on its own and add the rest back.
2. Make the smallest responsible source or command change, within the skill's rule against shrinking or dropping specified features.
3. Rerun the failed command and the checks that depend on it, resolving selectors afresh, and rerun the measurements that should not have changed (`inspect diff --planes` when the fix could reach unrelated geometry).

Fillet and chamfer, loft and Boolean failures are covered in `build123d-modeling.md`.

## Source import or syntax

Invalid syntax, a missing import or wrong build123d symbol, no function named `gen_step()`, or side effects at module level; `step-generation.md` states what a generator returns and what it leaves to the command line. A module the interpreter cannot import is reported in one line: run with the project's own environment when the design has one (`step-generation.md`).

## Invalid or missing geometry

An open sketch, a subtractive profile outside the target, zero thickness, a failed Boolean, construction geometry exported, or a feature with the wrong `Mode.ADD`/`Mode.SUBTRACT`, too shallow a blind cut or a selector that changed after an earlier operation. Close profiles meant to become faces, keep dimensions positive, make through-cuts pass through, and confirm each feature's mode and refs after regenerating.

## Self-intersecting solid

`scripts/step` warns that a part `is not a sound solid`, often with a count of self-intersections, although `is_valid` can still be true. `common.geometry.is_sound(part)` returns `False` and `self_intersections(part)` returns the faces that cross.

- Usual causes: a sweep whose profile reaches farther toward the inside of a bend than the bend's radius, so the inner side folds through itself (a thick handle around a tight curve), or other crossing surfaces, such as a loft through a self-crossing section.
- Check `is_sound` on intermediates to find the first unsound result. For a sweep, compare the profile's reach on the inside of each bend with the path's tightest bend radius; on a planar path, a sketch on `path ^ 0` puts its local X, the first dimension of a `Rectangle`, in the bend plane.
- Ease the tightest bend, or turn or reshape the profile so its inner side stays within the bend radius. Confirm the warning is gone before exporting meshes for printing.

## Open or inside-out solid

`scripts/step` warns that a part `is not a closed solid` (faces that do not enclose a volume, or an open shell) or `is inside out` (negative volume). A face, shell or sketch was returned where a solid was intended, a hand-built shell was not closed, or a solid was built from reversed faces. Return the solid from the builder (`part.part`, an extrusion or a revolve), check `.solids()`, `is_valid` and the sign of `.volume`, and rebuild the feature from a closed profile rather than reversing or patching faces.

## Wrong scale or bounding box

Units mismatch, diameter used as radius, wrong extrusion direction or amount, a primitive created with `align=None`, `.located()` after a rotation, or an imported STEP in unexpected units. Check parameters against `refs --facts` and measure the critical extents.

## Positioning, joint or mating mismatch

Likely causes: the wrong root, or `.connect_to()` moving the part meant to stay fixed; a wrong part-local origin; a `Location` not recomputed after a parameter change; `.located()` where `.moved()` should compose; a joint location in world coordinates where a part-local datum was meant, on the wrong datum, or with a duplicate label; an inverted axis or rotation about the wrong axis; a mirrored part still carrying the original's joints; a sign error in symmetric placement; or a mating face selected wrongly, shown by `parallel` instead of `opposed`.

Inspect `refs --positioning` and `frame` on the affected occurrences, run `mate` for the delta and direction, check the other axes and `clearance` separately, apply the smallest correction in source (`positioning.md`), regenerate from the Python source and rerun the failed checks with fresh selectors.

## When it cannot be repaired

Report what failed, what was tried, which artifact is still usable, which claims cannot be made, the next source-level correction, and which requirements remain untested.
