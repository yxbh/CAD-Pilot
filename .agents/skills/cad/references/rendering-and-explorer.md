# Viewing and CAD Explorer review

Read this file when a model should be shown to the user, after creating or visibly changing geometry, when the user asks for screenshots, previews or sections, or when programmatic facts need visual confirmation.

## Policy

Show relevant STEP/STP artifacts in the maintained CAD Explorer whenever the host can display it. Viewing belongs to the workbench's visual-review skill: load it to choose between the Copilot `cad-explorer` canvas and `explorer/scripts/explorer.mjs`, open the model, drive the view and capture images. This skill does not start, stop or bundle a viewer.

Captures serve two purposes:

- **Self-review:** after creating or visibly changing geometry, capture the model and look at it yourself before reporting. See Self-review below.
- **Images for the user:** save an image into the project when the user asks for an image, screenshot, preview or section, or when a section or step image is worth keeping with the project's notes.

Do not use images as the sole validation mechanism for dimensions, topology, labels, clearances, or mating checks.

## Opening a model

In hosts without the Copilot canvas, run the workbench's Explorer command from the design project's root, with the same project-relative STEP path that `scripts/step -o` wrote and `scripts/inspect` read:

```bash
node <workbench>/explorer/scripts/explorer.mjs open path/to/model.step
```

It prints the viewer URL as JSON. Show that URL to the user and keep reusing it. After regenerating, run the same `open` again: it reloads the running viewer and returns the same URL. Do not invent URL parameters or start another viewer. If `open` reports that the Explorer is not built, follow the build command it prints or report the failure.

In the Copilot desktop, open the `cad-explorer` canvas with the design directory as `projectRoot` and the STEP as `file` instead. The visual-review skill owns the details for both hosts.

## Self-review

Geometry checks cover only what you thought to measure. Looking at the model catches a missing cut, a part on the wrong side, a flipped lid or a surface that twisted. After creating or visibly changing geometry:

1. Use a separate review setup, so your views never move the user's camera. From the design root, run `explorer.mjs open <same STEP> --view review`, and pass `--view review` to every `do` and `capture` for it. Run that `open` again after each regeneration. The setup has its own URL: open it in its own browser-pane tab. A background tab does not draw, so bring the review tab to the front while you capture, then return to the user's tab. In the Copilot canvas, the visual-review skill covers the canvas's own capture action.
2. Choose views that expose the features under review, using the table below. Keep it proportionate: one or two views for a small change, more only for features those views hide. No set of views proves every face is right.
3. Run `capture` without an output path. The result's `path` names the image the Explorer saved in its own runtime folder; open that file and look at it. Those files are not cleaned up automatically, so capture only the views you need. Give a project-relative `.png` path only for an image the user wants to keep.
4. Turn each concern into a measurement before calling it resolved (second table below), and fix the source if the measurement confirms a problem.
5. If you have to use the user's setup instead, read `state` first. Afterwards restore its projection and view preset, turn off sections you added, and show hidden parts again. The CLI cannot restore an arbitrary orbit, so tell the user if you moved their camera.

Skip self-review captures when no visible geometry was created or changed: export-only requests, source edits that leave the shape alone, inspection-only questions, or a generation that failed before a valid STEP existed. Also skip, and say so, when the Explorer cannot open or no page can show it. When skipping, report why and which geometry checks still ran.

Do not loop. Capture again only after a repair changed visible geometry, or to confirm a specific finding. Self-review images are your evidence; the user sees the model in the Explorer, so share an image only when they ask for one.

Choose views by the feature under review:

| Under review | View |
| --- | --- |
| Overall shape, proportions, which part is where | `do set_view preset=iso` |
| Features on the underside, back or far side | the opposite axis view: `bottom`, `back` or `left` |
| Hole or boss patterns, outlines, symmetry | the axis view facing the pattern, with `do set_projection projection=orthographic` |
| The profile of a part revolved about Z, such as a pot's wall, floor and rim | `do set_view preset=front`, orthographic, with `do set_section enabled=true axis=y position=0 flipped=true` so the kept half shows its cut face to the camera |
| Internal cavities, bores, blind holes, wall and floor thickness | a section through the feature (`axis`, and `position` at its centre), viewed from the side the cut faces |
| Lid seating, fits and interfaces between parts | an orthographic side view plus a section through the interface; `do isolate id=<occurrence>` to look at one part alone |
| A reproduction of a photo | the axis view closest to the photo's viewpoint |
| Assembly order | `do set_step step=<n>`, as the visual-review skill describes |

`set_section` keeps the side of the plane at or below `position` by default and the side at or above it with `flipped=true`. Keep the half farther from the camera so the cut face points toward it; otherwise the image shows the uncut outside.

Turn visual concerns into measurements:

| The image suggests | Measure |
| --- | --- |
| A hole pattern looks off-centre or uneven | circle centres (`params.center` from `refs --detail`, or `measure` from the circle edges) and their offsets or spacing |
| A part looks shifted, flipped or floating | `frame`, `mate` with its direction relationship, and the minimum distance to what it should touch |
| A rib, boss or handle may not be attached | solid count, and the minimum distance and overlap with the body |
| A wall or floor looks thin or uneven | the distance between its inner and outer faces at that spot |
| A cavity, bore or blind hole looks wrong | its depth and radius, and whether it passes through |
| Parts look like they collide or rub | overlap volume and minimum clearance |
| A surface looks twisted or rippled | cross-sections at known heights, and the volume against expectations |
| A line or gap crosses a revolved surface | `is_valid` and solid count; a seam edge is expected (see `build123d-modeling.md`) |

See `inspection-and-validation.md` for the Python checks and `positioning.md` for what `mate` and `measure` show. A section cut surface is display-only and is not evidence of clearance.

## Images for the user

With the viewer page open, set up the view and capture it:

```bash
node <workbench>/explorer/scripts/explorer.mjs do set_view preset=iso
node <workbench>/explorer/scripts/explorer.mjs do set_section enabled=true axis=x
node <workbench>/explorer/scripts/explorer.mjs capture path/to/model_section.png
```

List the available view actions with `explorer.mjs actions`. A capture waits until an open page has drawn the current view; with no page open it reports the URL to open. There is no headless renderer, so open the URL (in the Claude desktop app, in the built-in browser pane) before capturing. Keep capture paths inside the design project, not in this skill directory.

Without `position`, the plane stays inside the visible model: a newly loaded model starts at the middle of its X range, and changing the axis moves the plane to the middle of the new axis. To cut at a chosen coordinate, add `position=<mm>` in model-world millimetres within the visible model's extent on that axis, for example from the bounding box `scripts/inspect refs --facts` reports for an unexploded model. A position outside the visible model is rejected, and the error states the allowed range on that axis.

Section view is a display-only cutaway: it does not cut the STEP, and its cut surfaces are not CAD faces or evidence of clearance.

## References

`@cad[...]` refs come from `scripts/inspect` and are resolved there. The Explorer copies its own `cadproto:v2` references, which `explorer.mjs inspect` resolves. Never feed one kind to the other tool.

If an inspected selector matters, include its textual ref next to the Explorer URL:

```text
Explorer: <URL printed by explorer.mjs open>
Key ref: @cad[models/mounting_plate.step#<selector>]
```

## Reporting visual review

Report visual review honestly, naming what the captures showed or why they were skipped, and which measurements back any visual finding:

```text
Visual review: opened models/mounting_plate.step in CAD Explorer; self-review iso and top captures showed four holes and the cutout where expected; hole centres confirmed by measurement.
```

or:

```text
Visual review: no capture; only the STL export settings changed, so the shape is unchanged. Geometry checks still ran.
```

or:

```text
Visual review: CAD Explorer could not start (<reported error>); validation relies on CLI inspection.
```

or:

```text
Visual review: section capture (Y = 0) showed the bore and wall where expected; bore depth and lid-to-base clearance confirmed by measurement, not by the image.
```
