# Self-review

Read this after creating or visibly changing geometry, before reporting it. Geometry checks cover only what you thought to measure; looking at the model catches a missing cut, a part on the wrong side, a flipped lid or a surface that twisted. Opening and capturing follow the visual-review skill's [Showing a Model](../../visual-review/SKILL.md#showing-a-model). Images never replace measurements of dimensions, topology, labels, clearances or mating.

## Procedure

1. Use a separate review setup so your views never move the user's camera: from the design root run `explorer.mjs open <same STEP> --view review`, and pass `--view review` to every `do` and `capture` for it. Run that `open` again after each regeneration. In the Copilot canvas, use the canvas's own capture action.
2. Choose the one or two views that expose the changed features (table below); more only for features those views hide. No set of views proves every face is right.
3. Run `capture` without an output path and open the image its result's `path` names. These captures live in the Explorer's runtime folder and are removed automatically; give a project-relative `.png` only for an image the user wants to keep.
4. Turn each concern into a measurement before calling it resolved (second table), and fix the source if the measurement confirms a problem.
5. If you must use the user's setup instead, read `state` first and afterwards restore its projection and view preset, turn off sections you added and show hidden parts again. The CLI cannot restore an arbitrary orbit, so tell the user if you moved their camera.

Skip it, and say why and which geometry checks still ran, when no visible geometry changed (export-only requests, source edits that leave the shape alone, inspection-only questions, a generation that failed before a valid STEP existed) or when the Explorer cannot open or draw. Do not loop: capture again only after a repair changed visible geometry or to confirm a specific finding. Share a self-review image only when the user asks for one; they see the model in the Explorer.

| Under review | View |
| --- | --- |
| Overall shape, proportions, which part is where | `do set_view preset=iso` |
| Features on the underside, back or far side | the opposite axis view: `bottom`, `back` or `left` |
| Hole or boss patterns, outlines, symmetry | the axis view facing the pattern, with `do set_projection projection=orthographic` |
| The profile of a part revolved about Z, such as a pot's wall, floor and rim | `do set_view preset=front`, orthographic, with `do set_section enabled=true axis=y position=0 flipped=true` |
| Internal cavities, bores, blind holes, wall and floor thickness | a section through the feature (`axis`, and `position` at its centre), viewed from the side the cut faces |
| Lid seating, fits and interfaces between parts | an orthographic side view plus a section through the interface; `do isolate id=<occurrence>` to look at one part alone |
| A reproduction of a photo | the axis view closest to the photo's viewpoint |
| Assembly order | `do set_step step=<n>`, as the visual-review skill describes |

`set_section` keeps the side at or below `position`, or at or above it with `flipped=true`. Keep the half farther from the camera so the cut face points toward it; otherwise the image shows the uncut outside.

| The image suggests | Measure |
| --- | --- |
| A hole pattern looks off-centre or uneven | circle centres (`params.center` from `refs --detail`, or `measure` from the circle edges) and their offsets or spacing |
| A part looks shifted, flipped or floating | `frame`, `mate` with its direction relationship, and `clearance` to what it should touch |
| A rib, boss or handle may not be attached | solid count (`hygiene` reports extra solids), and `clearance` with the body |
| A wall or floor looks thin or uneven | the distance between its inner and outer faces at that spot |
| A cavity, bore or blind hole looks wrong | its depth and radius, and whether it passes through |
| Parts look like they collide or rub | `clearance`: overlap volume and minimum gap |
| A surface looks twisted or rippled | cross-sections at known heights, and the volume against expectations |
| A line or gap crosses a revolved surface | `is_valid` and solid count; a seam edge is expected (see `build123d-modeling.md`) |

## Reporting visual review

Name what the captures showed or why they were skipped, and which measurements back a visual finding. Next to the Explorer URL, give the textual `@cad[...]` ref of any selector that mattered.

```text
Visual review: self-review iso and top captures of models/mounting_plate.step showed four holes and the cutout where expected; hole centres confirmed by measurement.
Visual review: section capture (Y = 0) showed the bore and wall where expected; bore depth and lid-to-base clearance confirmed by measurement, not by the image.
Visual review: no capture; only the STL export settings changed, so the shape is unchanged. Geometry checks still ran.
Visual review: CAD Explorer could not start (<reported error>); validation relies on CLI inspection.
```
