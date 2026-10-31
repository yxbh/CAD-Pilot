# build123d modeling patterns

Read this file when writing or repairing build123d Python source.

## Modeling objective

Create a valid STEP-ready BREP model, not a visual mesh. Prefer closed solids, explicit labels, and stable parametric dimensions.

## Topology stack

Think in this order:

```text
Vertex → Edge → Wire → Face → Shell → Solid → Compound
```

For normal STEP output, return one of:

- a valid `Solid`
- a compound of valid solids
- a labeled assembly compound

Avoid returning loose wires, open faces, or construction surfaces unless the user explicitly requested them.

## Source envelope

Generated sources should define:

```python
def gen_step():
    ...
    return shape_or_compound
```

Do not hardcode output paths inside `gen_step()`. The CLI owns output paths.

## Parameters first

Put meaningful dimensions in named variables:

```python
width = 80.0
depth = 50.0
thickness = 6.0
hole_diameter = 4.5
hole_offset_x = 30.0
hole_offset_y = 17.5
```

Avoid burying important numbers inside geometry calls.

## Coordinate system

Declare or comment the convention:

```text
Origin: center of primary part or chosen mating datum
XY: main base/sketch plane
+Z: up/extrusion direction
```

Use `Location`, `Plane`, and `Axis` intentionally. For positioning-sensitive tasks and source-level assembly relationships, read `positioning.md`.

## Placement pitfalls

The library behaviours named below were checked on build123d 0.13; re-check them after a build123d upgrade.

- **Replace versus compose.** `shape.located(loc)` replaces the shape's placement, so a rotation applied earlier is lost. `shape.moved(loc)`, `loc * shape` and `Pos(...) * shape` compose the new placement with the existing one. A `Pos(...) * part` copy also shares the original's geometry and keeps its label and joints. Use `.located()` only when replacing the placement is what you mean.

```python
bar = Solid.make_box(10, 2, 1).rotate(Axis.Z, 90)  # now 2 × 10 in XY
kept = Pos(5, 0, 0) * bar                          # still 2 × 10: rotation kept
lost = bar.located(Location((5, 0, 0)))            # 10 × 2 again: rotation replaced
```

- **`align=None` is not centred.** It keeps the primitive's raw datum: a `Cylinder` sits on Z = 0, centred in XY, and a `Box` starts at its corner. The default alignment centres both. Set `align` deliberately when placement depends on it.
- **Rotation frames.** Do not infer which local axis a rotation turns about from how the angles are written. When orientation matters, check the transformed axes or a face normal after the rotation, or build the frame from explicit direction vectors.
- **Compound children keep local placements.** After moving a labelled `Compound`, its `.children` still report their placement inside the compound; the compound's `.solids()` and the exported STEP carry the world placement. Measure placed solids or the saved STEP, not the children.
- **Mirrored copies.** Mirroring creates new geometry. The `part.mirror(plane)` method keeps the original's label and joint objects without mirroring the joint locations, so the holes move while the joints stay where the original's were. The `mirror()` function and the builder's `mirror()` return a part with no label and no joints. Give a mirrored part its own label and define its datums or joints after mirroring.

## Builder contexts

Use the context that matches the geometry:

```python
with BuildLine() as path:
    ...

with BuildSketch() as profile:
    ...

with BuildPart() as part:
    ...
```

Typical flow:

```text
curves/paths → sketches/profiles → solids/features → labels → STEP
```

## Primitives

Use canonical primitives when they fit the design intent:

- `Box` for rectangular blocks and plates
- `Cylinder` for bosses, rods, pins, and subtractive cylindrical cuts
- `Sphere` for knobs or spherical ends
- `Torus` for rings and circular sweeps
- `Cone` for tapered features
- `Wedge` for sloped solids

Use sketches plus `extrude`, `revolve`, `sweep`, or `loft` when the shape is profile-driven.

## Feature operations

Map design intent to operations:

```text
hole              → Hole or subtractive cylinder
counterbore       → CounterBoreHole
countersink       → CounterSinkHole
slot              → slot profile + subtractive extrude
boss/standoff     → cylinder addition + central hole
rib               → extruded rectangular/triangular profile
rounded edge      → fillet
beveled edge      → chamfer
hollow enclosure  → shell or subtractive inner volume
revolved part     → revolve profile
swept tube/rail   → sweep profile along path
```

## Selection practices

Avoid fragile topology order when possible. Select by:

- axis or normal
- location or bounding position
- plane grouping
- feature intent
- stable construction plane
- inspected `@cad[...]` reference for downstream validation

For source operations, prefer robust selectors such as top/bottom by axis or position rather than arbitrary list indexes.

## Fillet and chamfer edges

Select the edges to round or bevel from the solid you are finishing, after its last operation. A Boolean or other feature returns new edges wherever it changed the solid, so an edge list held from before it may name edges the solid no longer has. Edges an operation did not touch keep their identity. `edge in solid.edges()` is true only for the solid's own edge, so it is a quick test of a held selection.

On build123d 0.13, a stale edge fails in confusing ways:

- `fillet` given only stale edges raises `Failed creating a fillet with radius of …, try a smaller value`. The message points at the radius, but the cause is the selection.
- `fillet` given a mix silently skips the stale edges and rounds the rest.
- `chamfer` given any stale edge raises `Standard_NoSuchObject`.

Reselect the edges from the final solid before changing a radius. When a fillet genuinely does not fit, `solid.max_fillet(edges, max_iterations=20)` estimates the largest radius the selected edges allow, to within its `tolerance` (0.1 mm by default). On build123d 0.13 the default 10 iterations often fail with `Failed to find the max value`, even on a plain box, so raise `max_iterations`; choosing a smaller radius than specified is a design decision, not a repair.

## One welded body, then round it

A part that should look and print as one piece needs one solid with one face per surface and rounded edges where hands meet it. `inspect hygiene` reports each place where it is not; see `inspection-and-validation.md`.

- **Fuse first, round last.** Combine every piece of a part with `+` or one `BuildPart` before rounding, then select edges from the fused solid. Rounding pieces and fusing them afterwards leaves sharp edges and seams where the pieces meet, which no fillet ever saw. A `Compound([...])` of touching pieces is not a fused part: it stays several solids, and its edges fillet piece by piece.
- **One face per surface.** `+`, `-` and `BuildPart` merge faces that lie on one surface. Raw OCP Booleans, `Compound`, `split` and imported geometry can leave such faces split, which shows as a seam across a flat face and splits its edges. `shape.clean()` merges them; rerun `inspect hygiene` and expect no `split-face` finding.
- **Rounding convention.** Unless the project sets its own, propose a comfort radius as a provisional assumption (about 1 mm suits most hand-held FDM parts; ask when the edge is a grip, a lip or a child's toy), round every convex edge a hand meets to at least that radius, and record the radius as a named parameter. Leave or chamfer the edges on the print bed; the fdm-design skill covers overhangs. Check with `inspect hygiene --round <radius>`.
- **When a fillet fails.** `BRep_API: command not done`, `StdFail_NotDone` or `Failed creating a fillet` usually means stale edges (above), several solids where one was meant, a radius larger than the smallest neighbouring face allows, or edges meeting at one corner rounded in separate calls. Fuse, reselect, and round the edges that meet at a corner in one `fillet` call; larger radii before smaller ones.
- **Check result types.** `ShapeList` is a list of shapes, not a shape: it has no `.fillet` or `.volume`. `a & b` of bodies that only touch returns a zero-volume compound, not a solid. Read `.solids()` and each solid's `.volume` before using a result as a part.
- **Labels after the last operation.** `.solids()`, a `Solid`'s `.fillet()` and `Part(...)` return unlabelled shapes; set `.label` on what you export, not on an intermediate. `scripts/step` names unlabelled parts after their group and warns.

## Lofts and sampled profiles

A loft joins each section to the next by matching their edges and start points. A loft can be topologically valid and still twisted or rippled when those do not correspond. On build123d 0.13, polygon sections with shifted start vertices were aligned automatically, but identical periodic spline sections with shifted start points produced a valid solid whose volume differed from the straight extrusion.

- Sample every section in the same order, with the same start point, direction and feature positions. Equal sample counts alone do not guarantee a correct loft.
- Check the sections themselves as well as the result: a disconnected or self-crossing section can surface as a confusing loft failure. Lofting adjacent pairs of sections can locate the failing region, but a successful pair does not prove the full loft.
- Compare the result with expectations, such as volume, a cross-section at a known height, or a capture from the side, not only `is_valid`.
- Easing every interval to zero slope adds flat bands; choose interpolation for the continuity the design needs. Smooth measured or traced noise only within the task's tolerance.
- A ruled loft can help diagnose a smooth-loft failure, but it changes the surface. Use it as the final construction only when its faceting meets the design.

For a rotationally symmetric shape such as a pot or vase, a revolved profile is usually simpler and more robust than a loft.

## Booleans

Kernel behaviour depends on topology, tolerances and the installed build123d/OCP version. Diagnose the failing operation before changing the construction, and inspect the result rather than trusting a successful return.

- **Touching bodies.** On build123d 0.13, fusing two boxes that share only an edge, or a cylinder tangent to a box face, returns a compound of two solids without an error. Bodies that share a face merge into one. Check the solid count after a fuse that should produce one part.
- **Coincident or near-tangent boundaries.** Inspect the removed or added region and the solid count, for example by volume. A profile that already describes the final outline can avoid an unstable intersection.
- **Intersection results.** `a & b` returns `None` for two `Solid` objects that do not overlap; `.intersect()` can return a `ShapeList`. Handle both before reading `.volume`.
- **Many tools.** Combine independent cuts into one operation when that avoids rebuilding the same intersections repeatedly; keep cuts sequential when later features depend on earlier ones. Trim tool extents that reach far past the material.
- **Slow operations.** Time the suspect operation before changing it. Consider simpler surfaces, smaller tools or a different construction of the same feature. A feature being small on screen is not a reason to remove it.
- **2D algebra.** Check intermediate types. `ShapeList + ShapeList` concatenates the lists rather than fusing the geometry, while sketch objects combined with `+` do fuse. Check wire direction before extruding mirrored or sampled points, and confirm an intersection is non-empty before using it as a cut.

## Preserve the requested geometry

Never shrink, drop or approximate a specified feature to make a build or check succeed, whether by hand or through a retry ladder. Smaller radii, a different feature order, grouped edge selections or a bevel built into the profile are possible remedies when they still meet the requirement. If the specified feature cannot be built, report the limitation or ask for a design decision.

## Validity, volume and seams

`is_valid` checks topology. It does not prove the shape is the requested one, that it is positively oriented, or that it will survive a later Boolean.

- On build123d 0.13, a solid with reversed orientation passes `is_valid` and reports a negative `.volume`. A compound's total volume can hide it: a valid solid and a reversed copy sum to zero. STEP export and re-import report the reversed solid as positive, so check `.volume` on each solid of the in-memory shape from `shape.solids()`, not on the saved STEP.
- Open shells are legitimate when the user asked for surfaces.
- A full revolve gives each periodic face a seam edge. The seam is a real edge of a valid closed solid, not a crack: it appears in `refs --topology`, can be picked as an edge in the Explorer, and may be drawn as a line by other viewers or slicers. Confirm closure with `is_valid` and the solid count rather than by eye. Do not rotate a finished, datum-constrained part only to hide its seam.


## Assemblies and positioning

For assemblies, keep this file focused on BREP modeling patterns and labels. Use `positioning.md` as the single source of truth for:

- part-local coordinate conventions
- choosing build123d joints or explicit `Location` transforms
- `connect_to()` behavior
- mirrored parts
- CLI `inspect mate` as read-only validation
- frame, measure, and positioning report expectations

## Labels and assemblies

Label every exported part and assembly child:

```python
base.label = "base"
lid.label = "lid"
assembly.label = "electronics_enclosure"
```

For repeated parts, keep transforms or joint connections explicit and inspect frames/positioning after generation.

## Common failure modes

- Fillet radius larger than local edge geometry.
- Fillet or chamfer edges held from before a later operation.
- `.located()` used after a rotation, discarding it.
- Subtractive tool does not pass fully through target material.
- A fuse of bodies that only touch returns two solids.
- Loft sections whose start points or sample order do not correspond.
- Open sketch profile produces invalid or missing face.
- Face selector changes after a boolean or fillet.
- Source-level assembly composition is lost by re-importing generated STEP instead of using the Python assembly source.
- Part origin is arbitrary and later mating checks become ambiguous.
- Joint labels are duplicated within the same part.
- Source-level joints are treated as if they were persistent STEP constraints rather than one-time source placement operations.
- Joint labels are missing, duplicated, or attached to the wrong local datum.
- `.connect_to()` fixes the wrong side of the relationship, moving the part intended to remain fixed.

Use `repair-loop.md` when generation or validation fails.
