# build123d modeling

Read this when writing or repairing build123d source. The library behaviours below were checked on build123d 0.13; re-check them after an upgrade.

## Source shape

Return a valid `Solid`, a compound of valid solids or a labelled assembly from `gen_step()`; no loose wires, open faces or construction surfaces unless the user asked for surfaces. Put every meaningful dimension in a named variable, flow curves → sketches → solids → labels, and use sketches with `extrude`, `revolve`, `sweep` or `loft` when a shape is profile-driven. Select faces and edges by axis, normal, position, plane grouping or feature intent rather than list indexes, which change after a Boolean or fillet. Label every exported part and assembly child after its last operation (`step-generation.md`).

## Placement pitfalls

- **Replace versus compose.** `shape.located(loc)` replaces the shape's placement, so a rotation applied earlier is lost. `shape.moved(loc)`, `loc * shape` and `Pos(...) * shape` compose the new placement with the existing one. A `Pos(...) * part` copy also shares the original's geometry and keeps its label and joints. Use `.located()` only when replacing the placement is what you mean.

```python
bar = Solid.make_box(10, 2, 1).rotate(Axis.Z, 90)  # now 2 × 10 in XY
kept = Pos(5, 0, 0) * bar                          # still 2 × 10: rotation kept
lost = bar.located(Location((5, 0, 0)))            # 10 × 2 again: rotation replaced
```

- **`align=None` is not centred.** It keeps the primitive's raw datum: a `Cylinder` sits on Z = 0, centred in XY, and a `Box` starts at its corner. The default alignment centres both. Set `align` deliberately when placement depends on it.
- **Rotation frames.** Do not infer which local axis a rotation turns about from how the angles are written. When orientation matters, check the transformed axes or a face normal after the rotation, or build the frame from explicit direction vectors.
- **Compound children keep local placements.** After moving a labelled `Compound`, its `.children` still report their placement inside the compound; the compound's `.solids()` and the exported STEP carry the world placement. Measure placed solids or the saved STEP, not the children.
- **Mirrored parts are new geometry.** The `part.mirror(plane)` method keeps the original's label and joint objects without mirroring the joint locations, so the holes move while the joints stay where the original's were. The `mirror()` function and the builder's `mirror()` return a part with no label and no joints. Give a mirrored part its own label, define its datums or joints after mirroring, and select its references afresh rather than reusing the original's.

## Fillet and chamfer edges

Select the edges to round or bevel from the solid you are finishing, after its last operation. A Boolean or other feature returns new edges wherever it changed the solid, so an edge list held from before it may name edges the solid no longer has. Edges an operation did not touch keep their identity. `edge in solid.edges()` is true only for the solid's own edge, so it is a quick test of a held selection.

On build123d 0.13, a stale edge fails in confusing ways:

- `fillet` given only stale edges raises `Failed creating a fillet with radius of …, try a smaller value`. The message points at the radius, but the cause is the selection.
- `fillet` given a mix silently skips the stale edges and rounds the rest.
- `chamfer` given any stale edge raises `Standard_NoSuchObject`.

Other causes of `BRep_API: command not done`, `StdFail_NotDone` or `Failed creating a fillet`: several solids where one was meant, a radius larger than the smallest neighbouring face allows, edges meeting at one corner rounded in separate calls, or tiny unintended edges in the selection. Fuse, reselect, filter the selection by feature, round the edges that meet at a corner in one `fillet` call with larger radii before smaller ones, or build the rounding or bevel into the profile. When a fillet genuinely does not fit, `solid.max_fillet(edges, max_iterations=20)` estimates the largest radius the selected edges allow, to within its `tolerance` (0.1 mm by default); the default 10 iterations often fail with `Failed to find the max value`, even on a plain box. Choosing a smaller radius than specified is a design decision, not a repair.

## One welded body, then round it

A part that should look and print as one piece needs one solid with one face per surface and rounded edges where hands meet it. `inspect hygiene` reports each place where it is not.

- **Fuse first, round last.** Combine every piece of a part with `+` or one `BuildPart` before rounding, then select edges from the fused solid. Rounding pieces and fusing them afterwards leaves sharp edges and seams where the pieces meet. A `Compound([...])` of touching pieces is not a fused part: it stays several solids, and its edges fillet piece by piece.
- **One face per surface.** `+`, `-` and `BuildPart` merge faces that lie on one surface. Raw OCP Booleans, `Compound`, `split` and imported geometry can leave such faces split, which shows as a seam across a flat face. `shape.clean()` merges them; rerun `inspect hygiene` and expect no `split-face` finding.
- **Rounding convention.** Unless the project sets its own, propose a comfort radius as a provisional assumption (about 1 mm suits most hand-held FDM parts; ask when the edge is a grip, a lip or a child's toy), round every convex edge a hand meets to at least that radius, and keep it as a named parameter. Leave or chamfer the edges on the print bed; the fdm-design skill covers overhangs. Check with `inspect hygiene --round <radius>`.
- **Check result types.** `ShapeList` is a list of shapes, not a shape: it has no `.fillet` or `.volume`. `a & b` of bodies that only touch returns a zero-volume compound, not a solid. Read `.solids()` and each solid's `.volume` before using a result as a part.

## Lofts and sampled profiles

A loft joins each section to the next by matching their edges and start points, and can be topologically valid yet twisted or rippled when those do not correspond. On build123d 0.13, polygon sections with shifted start vertices were aligned automatically, but identical periodic spline sections with shifted start points produced a valid solid whose volume differed from the straight extrusion.

- Sample every section in the same order, with the same start point, direction and feature positions. Equal sample counts alone do not guarantee a correct loft.
- Check the sections themselves: a disconnected or self-crossing section can surface as a confusing loft failure. Lofting adjacent pairs can locate the failing region, but a passing pair does not prove the full loft.
- Compare the result with expectations, such as volume, a cross-section at a known height, or a capture from the side, not only `is_valid`.
- Easing every interval to zero slope adds flat bands; choose interpolation for the continuity the design needs, and smooth measured or traced noise only within the task's tolerance.
- A ruled loft can help diagnose a smooth-loft failure, but it changes the surface; use it as the final construction only when its faceting meets the design.

For a rotationally symmetric shape such as a pot or vase, a revolved profile is usually simpler and more robust than a loft.

## Booleans

Kernel behaviour depends on topology, tolerances and the installed build123d/OCP version. Diagnose the failing operation before changing the construction, and inspect the result rather than trusting a successful return.

- **Touching bodies.** Fusing two boxes that share only an edge, or a cylinder tangent to a box face, returns a compound of two solids without an error; bodies that share a face merge into one. Check the solid count after a fuse that should produce one part, and overlap bodies that must become one.
- **Coincident or near-tangent boundaries.** Inspect the removed or added region and the solid count, for example by volume. A profile that already describes the final outline can avoid an unstable intersection.
- **Intersection results.** `a & b` returns `None` for two `Solid` objects that do not overlap; `.intersect()` can return a `ShapeList`. Handle both before reading `.volume`.
- **Many tools.** Combine independent cuts into one operation when that avoids rebuilding the same intersections; keep cuts sequential when later features depend on earlier ones. Trim tool extents that reach far past the material, and make through-cuts pass fully through.
- **Slow operations.** Time the suspect operation before changing it; consider simpler surfaces, smaller tools or a different construction of the same feature.
- **2D algebra.** `ShapeList + ShapeList` concatenates the lists rather than fusing the geometry, while sketch objects combined with `+` do fuse. Check wire direction before extruding mirrored or sampled points, and confirm an intersection is non-empty before using it as a cut.

## Validity, volume and seams

`is_valid` checks topology. It does not prove the shape is the requested one, that it is positively oriented, or that it will survive a later Boolean.

- A solid with reversed orientation passes `is_valid` and reports a negative `.volume`, and a compound's total can hide it: a valid solid and a reversed copy sum to zero. STEP export and re-import report it as positive, so check `.volume` on each solid of the in-memory shape (`[s.volume for s in runpy.run_path("models/part.py")["gen_step"]().solids()]`), not on the saved STEP.
- Open shells are legitimate when the user asked for surfaces.
- A full revolve gives each periodic face a seam edge. The seam is a real edge of a valid closed solid, not a crack: it appears in `refs --topology`, can be picked as an edge in the Explorer, and may be drawn as a line by other viewers or slicers. Confirm closure with `is_valid` and the solid count rather than by eye. Do not rotate a finished, datum-constrained part only to hide its seam.
