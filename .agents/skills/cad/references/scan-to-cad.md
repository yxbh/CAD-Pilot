# Rebuilding a part from a scan

Read this when a 3D scan (STL, OBJ, PLY or 3MF) is the source of a part's dimensions, such as a pot to reproduce or a broken part with no drawing. The scan is measured in ScanRuler, a separate measuring app that runs in the user's browser, through its MCP tools (`scanruler_*`, `element_*`, `deviation_*` and others) when this host has them. To look at a scan, cut a section or take a rough size, the visual-review skill's [Meshes, Scans and Comparisons](../../visual-review/SKILL.md#meshes-scans-and-comparisons) is enough, but its tools do not align a scan or fit surfaces to it. Without ScanRuler, tell the user which of the steps below could not be done.

## Who owns what

- ScanRuler measures the scan and, at the end, compares the model with it. Do not build a model in ScanRuler with its `reverse_*` features, sketches or bodies, because the design belongs in the project's build123d source. Its section reads that change nothing, such as `reverse_section_fit`, are measurements and can be used as such. They cut a profile into lines and arcs, so on a curved wall they fit well outside the scan's noise.
- The generator owns the design: each measured value becomes a named parameter (Modelling, below).
- ScanRuler's own guide explains its tools for the build that is connected. Read `guide_read` topic `measure` whole, and from topic `scan-to-cad` only the sections "1. Inspect, classify, decide" and "3. Measuring". Skip their steps that build in ScanRuler, such as the profile road, `reverse_plan_set` and `reverse_note_add`; the rest of that guide builds the model in ScanRuler. Follow the guide for how to call the tools; this file covers what the workbench needs around them. This file was written against ScanRuler 0.9 and scanruler-mcp 0.6, so where a name here differs from the connected guide, the guide is right.

## Connecting

Call `scanruler_status`, then `scanruler_open`, which opens ScanRuler in the user's browser. The first time, the browser shows two prompts for the user to accept: ScanRuler's data warning, and the browser asking to let the page reach apps and services on this device. Tell the user about them in plain words before calling, and never accept them yourself. `scanruler_wait` gives up after a short while. Call it again until the page connects, and if it does not, tell the user what the result's `howToConnect` says. `guide_read` works only once a page is connected. The user sees every step in that tab and can undo it there.

All sessions on one computer share that tab, so measure one scan at a time. Before replacing what the tab holds, read `session` in `scanruler_status`; `scan_open` with `saveTo` saves the current work first.

A tab left open stays paired. Once scanruler.com has been updated, though, its tools answer `stale_page`:

1. Save the project with `project_save`.
2. Ask the user to reload the tab. The reload empties the page but keeps the pairing.
3. Reopen the project with `project_load`.

## Files

Pass an absolute path in the design project to every tool that writes a file: exports, `project_save` and any picture worth keeping. Without one:

- an export lands in the folder the ScanRuler server started in, which can be this workbench;
- a relative path starts from the folder of the scan or project last opened or saved by any session sharing the tab;
- a picture is only shown, except in `scanruler_batch`, which writes it into a `scanruler-work` folder beside the open scan, along with any answer too long to return.

Keep the scan, the `.scanruler` project and the section and comparison files where the project's layout keeps measurements and reviews.

## Measuring

1. **Open and check the scan.** `scan_open` with the file's units, then `scan_qa`.
   - Its `noise.median` is the scan's local scatter, the floor under every fit.
   - Its open rims show surfaces the scan never saw, such as the underside a pot stood on.
   - Noise is not accuracy: a smooth scan can still be off in scale, so check one real measurement as the visual-review skill says.
   - Its notes about faces that should be parallel and steps in thickness assume a boxy part; on a curved pot they are expected.
2. **Agree the tolerance T.** T is what "close enough" means for every step below: the rounding, the spline and the comparison. ScanRuler's guide gives values by process, never less than 3 × the noise, and a hand-made, worn or fired piece needs a wider one. Agree T with the user in plain words, for example as how far a mould may be off before it matters, and report it.
3. **Square it up.** `align_auto` puts a turned or thrown part's axis on Z as a coarse pose. Read `session_state` before and after, and check the axis (step 7) before trusting heights and radii.
4. **Fit the plain surfaces.** Fit planes, cylinders, cones and spheres with `element_fit`, seeded at the middle of each surface, with `side`, `radius` or `axis` to say what is sought. Trust a fit whose `sigma` is close to the scan's noise and whose grown region covers the surface you meant. A larger `sigma` means the region spread onto a neighbour or the surface is not that shape. Distances and angles between fitted elements come from `dimension_add`.
5. **Confine every fillet fit.** A torus seeded on a fillet spreads onto the walls it blends into and returns a confident radius that is too large, often without a warning and with `sigma` only a little above the noise.
   - Pass `within` a box that holds the fillet's arc and stops short of both walls.
   - Fit again with a slightly smaller box; a fit whose radius holds is believable.
   - The arc spans the angle between the two faces' normals: 90° in a square corner, whether the fillet is inside or outside. A confined fit covers less, and a `tubeCoverage` at or beyond that span says the region reached the walls.
6. **Rebuild missing datums.** A scan's bounding box ends where scanning ended. When a base, rim or mating face is open or missing, place it from fitted geometry, such as a plane or the face a fitted fillet runs into, and say which in the brief.
7. **Read curved profiles from files.** For a profile that is not lines and arcs, such as a vase's wall, work from a file rather than from answers: `section_get` puts its points in the conversation, about 13k tokens for 4,000, so use it and `section_render` only to look.
   - **Turned or thrown forms.** First list with the user what is not round, such as a handle, spout, lug or carving. Leave those features' sector out of the profile, and model them on their own or name them. Export the aligned scan with `export_stl`, which keeps the alignment. Reduce every vertex to its radius and height about the axis with a short script kept in the design project and run with the workbench's Python.
   - **Axis.** Fit it from the whole outer skin, by solving for the shift and tilt that leave the radius depending on height alone. Thin slices can hold too few points to fit a circle. Report how far the fitted axis lies from `align_auto`'s, in shift and tilt.
   - **Skins.** Tell them apart by position, since the outer skin is the largest radius at each height. Vertex normals are unreliable on small triangles. A narrow neck hides the inner skin: take the wall from the rim or a caliper reading and mark it provisional.
   - **Bands.** Take each height band's mean radius and mean height: on a sloped wall that point lies on the profile, and the band's middle height does not. Where the profile runs flat or turns back, such as a bowl's underside or a rolled lip, separate the skins and band them along the profile instead, and fit radius and height against distance along it.
   - **One section.** For a quick read, a cut across `{ axis: "Z", angleDeg }` in the aligned frame has its sheet on that axis, so its `export_dxf` reads as signed radius and height. Other sections' sheets start at the part's or the element's centre.

## Modelling

Snap a measured value to a round one, such as a whole millimetre or a common radius, only when it lies within T of it, and never across T; otherwise keep the measured value. Look for round values at the size the piece was made at. For a fired piece that is the wet size, which can be told only when the shrinkage is confirmed to within about T ÷ the piece's size; otherwise keep the measured values (Ceramics, below). Put both values in the CAD brief, for example `outer Ø 80 (measured 79.93, T 0.1)`, and list each snap as a provisional assumption for the user to confirm. A scan is of one object: wear, warping and the scanner's own error are in it, and a hand-made piece is not truly round. Ask what matters before reproducing an irregularity.

Revolve a turned or thrown form's half-profile. A curved wall is a B-spline fitted to the band means (Measuring, step 7), never one threaded through scan points, which wiggles however many points it gets. There are two ways to fit it:

- `Edge.make_spline_approx(points, tol, smoothing=(1, 1, 1))` fits one in a single call; without `smoothing` it wiggles too. It does not hold its end tangents, so it can meet a foot arc or the rim with a slight kink.
- Where the wall must run tangent into a neighbouring arc or face, fit a smooth curve to the band means first, such as a smoothing spline whose smoothing is chosen by cross-validation. Then pass a `Spline` through points spaced evenly along it, with its end tangents taken from the neighbours.

Use the least detail that keeps every band mean within T of the curve: matching the scan more closely copies its noise, as [Lofts and sampled profiles](build123d-modeling.md#lofts-and-sampled-profiles) warns. Where the wall is nearly upright, as at a belly or a neck, the height of the widest or narrowest point is poorly defined. Report its diameter, and its height only roughly.

## Comparing the model with the scan

After generating the STEP and running its usual checks, compare it with the scan in ScanRuler:

1. Load the STEP with `deviation_open_reference`.
2. Set `deviation_settings` from T, because ScanRuler's defaults are not T: `tolerance` T, `range` 3 T, and a `maxDistance` under the wall thickness.
3. Align the scan to the model with `deviation_align` (mode `auto`), a rigid best fit without scaling.
4. Read `deviation_hotspots`.

How to read the result:

- **The match.** Judge it by the share of points within T, a `far` count of zero, and an explanation for each `feature` patch. `withinTolerance` is a count of points; divide it by the points measured for a share.
- **Patches on one side.** A patch on only one side of a turned form is a feature the profile lacks, such as a handle, spout or carving, or else a dent or a scanning fault. Ask the user which before modelling it or naming it.
- **RMS.** An RMS close to the scan's noise means the model follows the scan as closely as the scan can show. A hand-made piece usually stays above it, which is fine within T.
- **Inferred parts.** `deviation_hotspots` with `on: "reference"` reads the map on the model. Its `noScan` is where the model has no scan under it, such as a rebuilt base: report those parts as inferred.
- **The best fit spreads errors.** It spreads one feature's error over the others, so read the map and the hotspots, not the RMS alone. When a region looks off, measure that dimension on the scan again.
- **What a match shows.** A matching map says the model matches the scan, within the scan's quality. It says nothing about how well the scan matches the object, or about fits, which the design states (fdm-design skill). Report it as the skill's Non-negotiables ask, with T and where it came from.
- **Showing it.** Show the user the colour map with its scale in millimetres, and say in plain words where it differs. To see the model and the scan together in CAD Explorer, export the scan with `export_stl` after `deviation_align`, which places it on the model, and open both as the visual-review skill describes.

## Ceramics

Ask whether a scanned piece is fired, and to what stage (bisque or glaze), since clay shrinks more the hotter it is fired. Fired clay is smaller than the clay that was shaped, so a model of the wet form, or a mould to cast it, needs the clay body's total shrinkage added back.

- **The number.** Get it from the user; a data sheet's value is only a proposal for them to confirm ([natural-language-specs.md](natural-language-specs.md#when-to-ask)).
- **The arithmetic.** Data sheets usually give shrinkage as a share of the wet size, so the wet size is the fired size ÷ (1 − shrinkage): at 12 %, a 100 mm pot was 113.6 mm wet.
- **One size.** State in the brief which size the parameters hold, fired or wet, and derive the other from a named shrinkage parameter, so the scale is applied once. Compare the model with the scan at fired size, since the comparison does not scale.
- **Glaze.** A glazed piece's scan includes its glaze.
