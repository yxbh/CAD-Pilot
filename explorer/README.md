# CAD Explorer

Maintained first-party STEP and mesh viewer for the project-scoped GitHub Copilot desktop canvas, and a local browser viewer that other agent hosts, such as Claude Code, can open and drive from a design project. The application lives here; `.github\extensions\cad-explorer\extension.mjs` is only the Copilot entry point. The workbench's cad skill generates and inspects the STEP files it shows. Python source owns a design's intent; STEP and preview meshes do not carry its parametric history. Mesh files (STL, OBJ, 3MF, PLY, GLB), such as vendor parts, remixes and scans, open directly as references and inputs; STEP stays the authoring path.

## Build and open

Use the workbench's Python environment and this package's local Node dependencies. From the workbench root:

```powershell
uv sync
Push-Location explorer
npm install
npm run build
Pop-Location
```

Reload project extensions, then open **CAD Explorer**. Build output and dependencies are Git-ignored; a source checkout needs the build step. Rebuild and reload after changing the application or extension. Missing assets produce the build command rather than opening an empty success state.

`package.json` is version-controlled; `package-lock.json` is local and Git-ignored because npm records resolved registry URLs in it. Use normal `npm install` with the machine's configured feed, without forcing a public registry or bypassing required feeds. The local lock can be reused on that machine, but versions permitted by the manifest can differ across machines.

The canvas accepts an explicit authorized `projectRoot`, a STEP or mesh `file` inside it, and an optional `viewId` for its remembered setup. Without a file it restores that setup, or creates the synthetic demo when none exists. The default project is the workbench checkout. Use Open to import another local snapshot, or Add file to show one beside it; the source file is not modified and its Python generator is never executed. Canvas actions answer with the same short summary as the design-project `state`; `get_state` with `detail: "full"` returns everything, and `capture_image` accepts `width`, `height` and `background`. Loads and view actions are confirmed by the [background renderer](#background-rendering) when the canvas is hidden.

A remembered setup includes the active model, camera, hidden/exploded parts, section settings and drawing reviews. Reopen its existing panel rather than creating a linked duplicate. Explorer keeps one live panel per setup; independent `viewId` values allow side-by-side setups. Equivalent Windows path spellings resolve to the same owner. An exclusive OS lease also prevents another Explorer process from writing that setup simultaneously. Ownership is released if the owning process terminates: Windows releases the named pipe, and on macOS and Linux the next Explorer to open the setup reclaims a socket file that no process is listening on.

## Use from a design project

Agent hosts without the Copilot canvas, such as Claude Code, use `scripts/explorer.mjs`. Run it from the design project's root with the project-relative STEP or mesh path; the project folder is the viewer's root. Results are JSON, and failures exit nonzero with one plain sentence. With `$Workbench` holding the workbench path, the command is the same in bash and PowerShell:

```text
node "$Workbench/explorer/scripts/explorer.mjs" open outputs/part.step
```

`open` starts this project's viewer in the background, loads the file, waits until a renderer has drawn it and returns a summary with its URL. Show that URL to the user: in the Claude desktop app open it in the built-in browser pane, otherwise in a local browser. The viewer outlives the command and the chat session that started it. After regenerating the STEP, run the same `open` again: it reloads the file into the running viewer, returns the same URL and never starts a competing viewer. When the same file is regenerated and every part keeps its name and place in the assembly tree, the reload keeps a camera the person moved, the section, explosion, assembly step and hidden parts (`view.kept` is true); an unmoved camera is fitted to the regenerated geometry; otherwise the view starts afresh and only display preferences (projection, appearance, outlines, selection mode and view preset) carry over. A viewer that starts with a file restores its saved setup first, so the same holds after it was stopped, the computer restarted or another checkout's viewer was replaced. Each project and setup keeps one address across restarts, so earlier links work again after the viewer restarts unless another program has taken its port; an open page reconnects by itself.

| Command | Purpose |
| --- | --- |
| `open [file] [--units ...] [--up ...]` | Start or reuse the project's viewer, load the file and confirm it was drawn. Without a file it restores the remembered setup. `--units` and `--up` say how to read a mesh file (see [Meshes](#meshes-scans-and-other-peoples-models)). |
| `state [--full]` | A short summary: the model's name, file, `revision` (the first 12 hex digits of the main file's SHA-256, whatever other files the view shows) and `generatedAt` (the file's modified time), the view (with `view.files` when it shows several), and `shown`: how many viewer pages are open, whether one has drawn the current revision (`seen`), and which renderer drew it (`drawn`). A `note` says plainly when no page is open or the open page has not drawn the view yet, or names an added file that had to be left out and how to add it back, and `changedOnDisk` when the file changed after it was loaded. `--full` adds parts, references, the files as `documents` and the renderer's report. |
| `actions` | The view actions accepted by `do`, with their inputs. |
| `do <action> [key=value ...]` | Run a view action, for example `do set_view preset=top`, `do set_view azimuth=45 elevation=32`, `do set_section enabled=true axis=x position=12`, `do set_explode amount=0.4` or `do set_step step=2`. Values that read as JSON keep their type. One JSON object also works where the shell preserves quotes. Answers with the summary; `--full` as for `state`. |
| `capture [path.png]` | Save an image of the view, drawn in the background at 1280x800, optionally copied into a `.png` path inside the project. `--size WxH` and `--background "#rrggbb"` apply to that image only. |
| `render <file> <out.png>` | Render a STEP or mesh file to a PNG inside the project without opening or changing any viewer; see [background rendering](#background-rendering). |
| `prune [--dry-run] [--all] [--copilot]` | Remove old snapshots, model caches and captures that no saved setup shows; see [local data](#local-data). |
| `inspect <reference>` | Resolve pasted reference text, a `cadproto:v2` address, a descriptor JSON path or Copilot chip markup, including mesh parts and picked points, from this viewer's store or the Copilot canvas's. No viewer needs to be running. |
| `stop` | Stop the project's viewer. Its address, saved setup and reviews are kept. |

`open` fails with the build command when the Explorer has not been built, rather than handing out a URL to an error page, and with one plain sentence when the file is not in the project. Each command refuses an option it does not read rather than ignoring it. Simultaneous `open` calls for one setup share a single viewer. Every workbench checkout shares the store, so a setup's viewer may have been started from another checkout: `open` restarts it from this one at the same address (`replaced` names the other checkout), and other commands say so instead of driving the other checkout's code. A checkout is compared by its real folder, so a link to it or another spelling of its path on macOS or Windows is the same checkout. View actions return the committed view at once, before any renderer draws it; `open` and `capture` wait for a drawing. `--view <name>` (or `CAD_EXPLORER_VIEW`) selects an independent setup for side-by-side comparisons. Copilot's draft-attachment action is not available here.

`server/standalone.mjs` is the same viewer attached to a terminal for manual use. It also reuses a running viewer for the project: started again with a file, it reloads that file there and exits.

## Background rendering

A view counts as shown once a renderer has drawn it: a person's viewer page, or the viewer's background renderer. The background renderer is the same page without controls, in Playwright's headless Chromium shell from the workbench setup (`CAD_EXPLORER_CHROMIUM` names another Chromium). A viewer starts it when a view needs drawing and no open page answers within about a second and a half (up to 15 s while a page in front is still meshing a model it has just fetched; a hidden tab says it is hidden and gets no longer), so a hidden canvas, a background tab or no tab at all never leaves a load unconfirmed. Chromium starts on a blank page and opens the viewer over its debugging pipe, so the viewer's private address never appears on a command line. It uses the GPU through ANGLE (Metal on macOS, Direct3D 11 on Windows, Chromium's own choice on Linux), lets Chromium switch to software WebGL by itself where it finds no usable GPU, as on CI runners, restarts once with software WebGL if the page still cannot create a WebGL context, stops after two idle minutes, and exits with its viewer; each browser has its own temporary profile, removed once the browser has exited, and profiles left by a killed viewer are removed the next time one starts. On Linux it runs without Chromium's sandbox, as Playwright does by default: Playwright's headless shell has no setuid helper, and Ubuntu 23.10+ blocks the user namespaces the sandbox otherwise needs. It only ever loads the viewer's own page on 127.0.0.1. A browser that crashes, or exits as it starts, fails the work waiting on it at once, not its viewer, with its exit status and the last error it or the system printed (such as a missing library). When nothing can draw the view, for example because Chromium is not installed, a load or view action still succeeds and its `note` says why the view was not drawn (with the install command where that is the reason), also when an open page that has had its moment draws nothing; captures fail, since they need an image.

Agents' captures always come from the background renderer, one at a time, at 1280x800 unless a size is given: the person's camera once they have moved it, otherwise the view preset fitted to the image. A custom background colour replaces the backdrop and leaves out the Inspect grid. The viewer's own Capture button saves what that tab shows. A capture while a drawing review is open is the review's saved version, marks included.

`render <file> <out.png>` loads a STEP or mesh file into a private, temporary viewer that saves no setup, applies `--hide "label,label"` (part or group labels with `*` and `?` wildcards, resolved as in [assembly steps](#assembly-steps); a label that matches nothing, or hiding every part, is refused), `--explode amount[:direction]`, `--step N[:buildup]`, `--section axis[:position][:flipped]`, `--projection`, `--appearance`, `--finish`, `--outlines on|off` and `--view`, in that order, and writes one image (`--size WxH`, `--background "#rrggbb"`). `--view` takes a preset or `AZ:EL` in degrees: azimuth 0 looks from the front and 90 from the right; elevation 90 looks down from the top. It reads the file the same way as `open`, with `--units` and `--up` for a mesh, and prunes the shared store when it finishes. Its image is kept in a private folder inside the store until it is copied out; a render interrupted before it can remove that folder leaves it for the next prune. Use it for documentation images: it never moves a person's view.

## Model, views and appearance

The viewer loads ordinary STEP/STP parts and assemblies through the workbench's local OCP converter. It preserves repeated occurrences, placements, names and supported part colors. Parts and groups nobody named are named as the cad skill names them, after their group (`kit 1`, `kit 2`) or, at the top, after the file, so the tree shows the names `scripts/inspect parts` lists; a name a CAD program made up, such as `COMPOUND`, counts as no name. Different surfaces within one part, transparency and source visibility flags are not fully represented; detected limitations appear as import warnings. Missing colors use blue-grey. The demo deliberately has a blue base, green cover and gold spacers.

When the live model has import warnings, a warning button with a count appears in the document header. Normal display cleanup of verified kernel point edges and exactly zero-area triangles is instead summarized as low-priority information, with counts for reusable part geometry rather than repeated placements. Cleanup alone shows a neutral information button; mixed imports keep the real warning count and show cleanup separately in the same panel. No CAD faces are removed by this cleanup. Tessellation tolerances, triangle filtering and selectable nondegenerate edges are unchanged; unflagged zero-length edges remain warnings, and invalid or missing geometry remains an error.

Open the header button to read the scrollable details; close them with the X button, Escape or the header button. Details stay above the bottom controls, so they never cover the explosion slider. Opening them dismisses a transient success notice, not an error. Closing the details does not erase diagnostics: reopen them from the same button. Details start closed for each newly loaded model and are not shown over captured drawing reviews.

The header shows the model's revision (`rev` and the first 12 hex digits of the main file's SHA-256, unchanged by files added beside it) and the file's modified time; hovering shows the file and the full hash. `state`, `capture` and `render` report the same, so a viewer showing an older model is obvious to the person and the agent alike.

Orbit, pan, zoom, fit and six exact axis views are available. `set_view` also takes `azimuth` and `elevation` in degrees for any other direction. Dragging orbits like a turntable around Z from every view, including top and bottom, which are held imperceptibly off the pole so their on-screen orientation is kept. Right is +X, left -X, back +Y, front -Y, top +Z and bottom -Z. Z is the source model's up direction, not a manufacturing instruction. The labelled corner indicator follows the camera and its endpoints choose a view. Toolbar buttons have mouse-hover and keyboard-focus tooltips.

Perspective and orthographic (parallel) projection share the same camera direction and target-plane scale when switched. The camera controller owns projection sizing so a window resize or parts-panel toggle does not replace the orthographic scale with pixel dimensions. Resizing may crop a narrower viewport; it must not silently change zoom.

Explode follows the assembly's own tree. The slider first moves each top-level part or subassembly away from the assembly's centre, then the parts within each subassembly away from its centre, down to three levels; anything nested deeper moves with its third-level group. Outward moves each group in the direction it already sits from its parent's centre, further for groups that sit further out or are larger. Groups that reach their parent's centre have no outward direction, so they stack instead: along the axis their centres spread along (plates on a turntable), or, when they share a centre, the largest stays and each other one slides out along its own axis, the side unlike its other two (a shaft's length, a bearing's thickness). Up / down, Left / right and Front / back stack the same groups along Z, X or Y in the order they sit: groups at the same height move together, the layer at the centre stays, and each layer moves far enough to clear whatever it would meet along that axis. When nothing would separate along the chosen axis, the top-level parts are laid out side by side along it instead. Each group makes room for its own parts once they have spread, so at full explode no two part boxes overlap, across subassemblies as well as within them; boxes that overlap by only a micrometre or so, as STEP conversion leaves faces that meet, count as touching. A pile of hundreds of parts all overlapping one another is left where the first offsets put it rather than stalling the viewer. Keep fixed holds the chosen part where it is assembled and moves everything else so it keeps the same separation from it.

Explosion percentage, direction, fixed-part selection and Reassemble move only the parts, retaining the current camera, pan and zoom. Use Fit assembly if separation moves parts off-screen. Hide/show a specific part also retains the camera. Isolate and Show all retain their existing explicit-action behavior of fitting the resulting visible parts.

Section view is a visual cutaway. Open Section view from the model toolbar, enable the cut, choose X, Y or Z, slide or enter the plane coordinate on the model's world axes, and flip which half is hidden. The slider and number limits span the actual visible displayed occurrences, including nested transforms, repeated parts, fixed parts and the current explosion preview. Axis changes and Reset use the relevant displayed midpoint. Exploded offsets extend this visual range but are not physical CAD measurements. Expanding the display preserves the plane; reassembly, hiding an outlier or changing the pose clamps it only when it falls outside the remaining visible bounds, without moving the camera. Hiding every part preserves the last plane and disables position changes until a part is shown. Reloading a file whose part tree is unchanged keeps the plane, clamped into the new visible bounds; opening one with a different tree resets section view off at the new assembled model's midpoint.

Cut surfaces use per-part display-derived caps and outlines so closed solids and closed meshes read as solid while bores, voids and gaps remain open. Open meshes and STEP surface or open-shell parts are cut too, with an amber outline where the plane crosses them and no cap, because they have no inside to fill. Caps are not CAD faces, cannot be selected or copied, and block pointer selection through the artificial cut surface. Faces, native CAD edges, highlights, Studio shadows and exploded occurrences use the same world-aligned cut; the cap plane also expands and recenters over the displayed assembly. The `set_section` canvas action accepts optional `enabled`, `axis`, `position` and `flipped` fields with the normal `expectedRevision` contract, validating position against the committed visible displayed pose. False `flipped` keeps coordinates at or below the plane and true keeps coordinates at or above it.

The converter records whether each preview part is composed entirely of native closed solids, and the mesh reader whether each mesh is closed; only those parts are capped. This metadata is part of the converted model's topology identity. Caches created before it existed remain immutable and restore with their original references, but Section view stays unavailable, and a remembered enabled cut is turned off, until the STEP is reopened. Reopening creates a new topology revision with the metadata; references copied from the older revision still resolve against its retained cache.

Inspect uses a grid and readable outlines. Studio uses local reflection and area lighting, soft-edged shadow lighting and a floor. Plastic, satin metal, polished metal and rubber are visual finishes over the original colors, not measured materials or changes to STEP. Outlines can be switched independently; changing modes starts with them on for Inspect and off for Studio. No remote environment images or conversion services are used.

## Meshes, scans and other people's models

STL, OBJ, 3MF, PLY and GLB files open directly, as `open scan.obj` or Open in the page: their triangles are drawn as they are, with no conversion to STEP or B-rep, so there are no face, entity, size or "invalid native geometry" limits to work around. Each file's parts keep their names: OBJ objects (or groups), 3MF and GLB objects with their placements, ASCII STL solids, otherwise the file name. Supported uniform colors are kept; other meshes get a muted palette. Mesh parts are drawn with flat shading, which shows the facets honestly, and dense meshes are picked through a bounding-volume tree, built in a background worker, so million-triangle parts stay interactive.

Units and the up axis come from the file when its format says (3MF declares its unit; glTF is metres, Y up), otherwise from convention and size: STL, 3MF and PLY are read Z-up, OBJ Y-up, and files without a unit are millimetres unless the whole model is under 2.5 units across, when it is read as metres. `state` gives the units and up axis used and a plain note saying why, as `model.frame` for one file or under `view.files` for several (`documents` with `--full`). When a size or orientation looks wrong, open it again with `--units mm|cm|m|in|ft|um` and `--up z|y` (or give `units` and `up` to `add_file`); everything is shown Z-up in millimetres either way.

Vertices that are exactly equal are merged so the file's own connectivity can be checked; nothing is repaired. Selecting a mesh part shows its triangle count, whether it is closed, and its faults: open edges (holes or the border of an open surface), edges shared by more than two triangles, edges whose two triangles wind the same way, and zero-area triangles. The Mesh faults button (`do set_faults visible=true`) draws them through the surface in red, magenta, orange and yellow. Outlines follow edges sharper than 30 degrees and open borders, and are left off a surface whose noise makes sharp edges common, as on scans.

Faces and Edges do not apply to meshes, whose triangles are not CAD faces: in those modes a click selects the whole mesh part. Points (`set_selection_mode mode=point`, the default for a mesh) picks a spot on any surface, mesh or STEP, and copies a reference to it.

These are viewer facts, not print limits: a mesh the viewer reads may still need repair in a slicer, and one it cannot read (over 300 MB or 4 million triangles) may print fine. Reading peaks at roughly 0.5 KB of memory per triangle for binary STL and 0.7 KB for OBJ, which sets the triangle cap.

### Several files in one view

`do add_file file=scan.stl` adds another file to the view in its own frame, for example a scan, the original model or an earlier revision over the new design. Added files are ghosts by default: see-through, and clicks in the view pass through them to what is behind; their parts can still be selected from the parts list or with `select_parts`. `do set_file id=ref1 style=solid offset=[0,0,5] rotate=[0,0,180]` restyles or moves one (rotate is degrees about X, then Y, then Z, before the offset), `do set_layout mode=side` lays the files out side by side along X under one camera and `mode=overlay` puts them back, and `do remove_file id=ref1` takes one away. Opening the main file again, as after regenerating it, keeps the files added beside it. If storage cleanup has removed Explorer's copy of an added file, it is read again from the project; one that cannot be (an upload, or a file that has gone) is left out, and the `note` names it and how to add it back. Add file in the page does the same for a local copy. Placement and layout are display only; they never change a file, its measurements, its references or the model's identity, so arranging files does not reload their geometry. Up to eight files share a view, and the setup remembers them.

The main file keeps its own part ids; an added file's ids are prefixed with its id, such as `ref1/node:1`. Explode, hide, section and capture treat each file as one top-level group.

### Measuring meshes

`explorer/python/measure.py` reads a mesh exactly as the viewer does, with the same `--units` and `--up` options, and prints JSON in millimetres on the viewer's model-world axes. Run it with the workbench's Python from the design project's root:

```text
python "$Workbench/explorer/python/measure.py" scan.obj --units m size
python "$Workbench/explorer/python/measure.py" part.stl section --z 4.5 --points 200
python "$Workbench/explorer/python/measure.py" part.stl distance --from 10,0,4 --to 10,25,4
python "$Workbench/explorer/python/measure.py" part.stl distance --from 10,0,4
python "$Workbench/explorer/python/measure.py" new.stl distance --to-file original.stl
python "$Workbench/explorer/python/measure.py" scan.stl faults
```

| Command | Result |
| --- | --- |
| `size` | Overall and per-part bounds, triangle counts, closed or open, surface area, volume of closed parts and fault counts. |
| `section` | Every loop where a plane (`--x`, `--y`, `--z` or `--plane POINT NORMAL`) cuts the triangles: length, enclosed area, bounds, whether it is a hole, the smallest bounding rectangle, a circle fit (centre, diameter) and a slot fit (width, length, axis), each with RMS and largest deviation, and a shape guess. `--points N` adds the outline. |
| `distance` | Between two points; from a point to the closest point on the surface; or, with `--to-file`, how far each vertex lies from another file's surface (minimum, maximum with where, mean and 95th percentile). |
| `faults` | Where the faults are: open borders with their lengths, centres and bounds, and the first 50 over-shared and flipped edges and zero-area triangles. |

`--part <name>` limits a command to the parts whose name matches, with `*` and `?` as the only wildcards. `--part`, `--units` and `--up` may come before or after the command's name. Measurements describe the triangles in the file, which approximate the real object; a fit's residuals say how well a circle or slot matches the outline, not how accurate the scan or export was. A picked point's reference holds part-local coordinates; `inspect` also gives its world position for `--from`.

## Assembly steps

A STEP can carry an assembly sequence in a sibling `<name>.assembly.json` file, such as `outputs/stop.assembly.json` beside `outputs/stop.step`. Explorer reads it whenever it opens or reloads that STEP; uploaded snapshots have none. The demo includes a two-step sequence.

Each step has a title, an optional note, part labels and a `from` offset in model millimeters: where those parts wait before the step brings them to their placement in the STEP. Labels match part names, and the names of groups someone labelled, with `*` and `?` wildcards; every other character, including brackets, is literal. A group stands for all of its parts. A group nobody labelled shows a made-up name, which never matches, as in the cad skill's matcher. A group holding every part, such as the top-level assembly, never matches, so a broad pattern cannot move the whole model; a pattern that matches only such a group is reported as unmatched. A step whose patterns together name every part (such as `*`) is refused, by both the exporter and the viewer, since it would have nothing to arrive at. Naming a part again in a later step carries it along with that step. Labels that match nothing, and a sequence written for different STEP bytes, are reported in the step panel and `state` rather than guessed.

Open the steps with the bottom bar's Assembly steps button. Step 0 shows every sequenced part waiting at its offset; the last step is fully assembled. Exploded keeps waiting parts visible with dashed paths to where they go, and Build up hides them until their step. Play, the step buttons and the slider animate between steps without moving the camera; render reports and captures wait until a step has finished moving. Agents use `do set_step step=2`, `do set_step mode=buildup` and `do set_step off=true` (`step=null` also works from the command line). Automatic explosion and the sequence are alternatives: a nonzero explosion or Reassemble turns the sequence off. Give later steps on the same axis larger offsets so waiting parts do not appear to pass through each other.

Write the sequence from the design's Python source when it has one. Add `gen_assembly()` beside `gen_step()`, returning `{"steps": [...]}` whose steps have `title`, `parts`, `from` and an optional `note`. The writer loads the source as the cad skill's tools do, so modules beside it, at the design root and in its `src/` folder import, and it matches `parts` against the generated STEP's parts by the cad skill's names and rules, so an unlabelled part's name, such as `kit 2`, works as `inspect parts` lists it. After generating the STEP, run this from the design root with the workbench's Python interpreter:

```text
python "$Workbench/explorer/python/assembly.py" source/stop.py --step outputs/stop.step --check
```

`--check` moves each step's parts of that STEP in a straight line from their placement towards their offset and measures exact B-rep overlap with the parts already placed, every 0.5 mm by default, wherever their bounding boxes can meet along that path. A failed B-rep intersection reports an error, never a clear step. Parts no step names count as already placed. Each step reports clear, blocked (the first blocking part and distance) or interferes (overlapping when installed). A step's `check_shapes` can stand in for one of its parts during the check only, such as a squeezed illustration of a snap part. The check is rigid and sampled: it does not model flexing, threads, gravity, tool access or friction, and features thinner than the spacing can be stepped over. Treat a clear result as a geometric screen, separate from visual review and physical assembly. The sequence never changes the STEP or print files.

## Face, edge and part references

Use the Faces, Edges, Points or Parts toolbar buttons to choose what to select. Faces previews and selects a whole CAD face; Edges previews and selects a whole straight or curved CAD edge; Points picks a spot on a surface; Parts selects an occurrence. The parts list also selects an occurrence. Edge picking uses a six-CSS-pixel radius at any zoom, ignores edges behind opaque geometry and follows each part's exploded placement. Edge mode shows the selectable outlines even when Studio's Outlines setting is off. Selected edges have a stronger highlight, with their curve type and exact CAD length in millimeters in the selection panel. These are STEP topology edges, including seams, not triangle boundaries or view-dependent silhouettes.

Section clipping does not mint topology. A retained face or edge keeps its exact original `cadproto:v2` identity, partially cut native edge polylines are trimmed before screen-space hit testing, and entities wholly outside the retained half are not pickable. Moving a section plane clears a selected entity only when the displayed pose leaves none of it on the retained side.

Auto-copy copies the selected reference inside the user's click gesture; Copy reference also works explicitly. In the Copilot canvas, paste into the desktop's rich composer to create a native file-reference chip. The design-project viewer instead copies readable text for any chat: a summary line such as `CAD Explorer | part.step | Lid | Face f6 (plane, 260.00 mm^2)` followed by the exact `cadproto:v2` address. Moving over geometry never changes selection or the clipboard; clicking and copying never insert a draft attachment automatically and never send a message.

Changing the auto-copy preference through a canvas action acknowledges the saved preference without waiting for a render, including while a drawing review pauses the live scene. It still checks a supplied view revision and does not copy anything by itself.

The chip points to a real JSON descriptor containing a `cadproto:v2:` address: exact topology revision, occurrence and face (`fN`), edge (`eN`), picked point (`tN@x,y,z`: triangle N, counting from 0 in the file's order, and the point in the part's own millimetres) or whole part (`part`). In a view of several files, a reference names the topology revision of the file its part came from, so it resolves the same whatever else was shown. Inspecting a mesh point checks it against its triangle and reports its world position and surface normal; a STEP point reports the CAD face it lies on. A middle dot separates the part and selected entity in the label so native file-chip basename formatting does not drop the part name. Explosion and appearance do not change this address. Raw/plain-text composer modes may intentionally show the markup.

`cad_explorer_inspect` resolves these references in Copilot, and `explorer.mjs inspect` resolves them from a design project. These are not the `@cad[...]` ordinals that the cad skill's `scripts/inspect` reports. Cached geometry and source snapshots are validated; missing or changed data is reported rather than guessed. Validated data is reused only while its file identity remains unchanged.

CAD kernel updates can change tessellation or topology ordering when a STEP is imported again, producing a new topology revision. Retained caches and their copied references are not rewritten to match the newer kernel; re-resolve selections against the newly generated or imported revision.

Inspection keeps compact validated face/edge/part/placement facts rather than retaining another copy of mesh or edge-polyline arrays. Its default cache is limited to four entries and 64 MiB of accounted fact data; source-digest entries have a separate bound. These are retained-cache accounting limits, not a bound on transient JSON parsing or total process memory. Unchanged warm selections avoid full mesh parsing/validation and source hashing; changed files invalidate the relevant entry, and source hashing is streamed. Synthetic timing checks do not certify real large-assembly performance.

Clipboard access can be denied by the host; a selected-text/manual-copy path remains available. Browser clipboard checks, native chip presentation, and delivery of the descriptor in the next user message are separate acceptance checks. Do not treat one as proof of the others.

## Drawing reviews

Draw captures the model's current appearance, camera, visibility, selection and exploded pose into a fixed image. Pen, line, arrows, rectangle, ellipse, highlight and erase operate on that image, with undo/redo and reversible clear. Highlight is a filled rectangle, not smart surface fill. Drawing does not orbit the model or copy geometry references.

The live WebGL canvas stays mounted but inactive beneath the drawing layer. Switching modes does not move the viewport or recreate shared geometry. Genuine graphics-context loss is still reported. Captured images retain their aspect ratio when resized; strokes use image-relative coordinates.

Drawing saves are versioned. Recovery must preserve unsaved local marks and other writers' work rather than blindly overwriting a conflicting version. Keep local recovery and exported images distinct from a confirmed server save. Review summaries do not require loading every saved image after each stroke.

A failed or uncertain save can be reconciled with the saved version. Conflicting local marks can be kept as a separate review without replacing the other version; loading the server's version or discarding local changes is explicit. Copy/download the marked image if the service is unavailable. Do not reload or close a tab with unsaved marks before saving, exporting or explicitly discarding them. When opening a review, live rendering pauses before the load starts so cold Studio rendering cannot delay the transition.

Copy marked image and Save marked image include annotations. The saved metadata records the original source revision, pose, visual appearance and section settings. A review remains tied to its captured snapshot even after the live section or a different STEP is changed. The current limits are 20 reviews per setup, bounded image sizes and bounded stroke/history counts.

## Local data

The design-project viewer keeps saved models, source snapshots, references, view setups, drawing reviews and captures in the user's local application data: `~/Library/Application Support/CAD-Pilot/Explorer` on macOS, `%LOCALAPPDATA%\CAD-Pilot\Explorer` on Windows and `$XDG_STATE_HOME/cad-pilot/explorer` (by default under `~/.local/state`) elsewhere. `CAD_EXPLORER_RUNTIME_ROOT` relocates it. Copies of design geometry therefore stay out of both the workbench checkout and the design project. A mesh's model is its manifest (`models/<revision>.json`) and geometry file (`models/<revision>.bin`), kept and removed together; its source snapshot keeps its own extension. The Copilot canvas keeps its store in `explorer/.runtime/`, where the absolute descriptor paths in its native file-reference chips point inside the workspace. Pasted file-reference chips contain absolute descriptor paths; copy them again after relocating the data.

Both stores are content-addressed (snapshots and model caches by hash, captures by image content) and bounded. After imports and captures, at most every ten minutes, a viewer removes snapshots and model caches that no saved setup shows once they are 7 days old or beyond 256 MiB in all, captures beyond the newest 50 or older than 7 days, and reference descriptors whose model is gone. A setup protects the models it shows, added files included, while it has been used in the last 30 days; reopening a setup whose model was removed says so and asks for the file again. A running viewer keeps what it shows in memory, so cleanup never breaks its view. Anything written or reused in the last ten minutes is kept: reopening an identical file refreshes its snapshot's time before reusing it, and a prune skips anything touched after it listed the store, so a prune in another process never removes what a load has just reused. A mesh geometry file without its manifest, and a folder an interrupted conversion or one-shot render left behind, go once they are ten minutes old. `explorer.mjs prune` applies the same rules at once: `--dry-run` reports what it would free, `--all` removes everything no recently used setup shows whatever its age, and `--copilot` prunes the Copilot canvas's store instead. A reference whose model was removed reports that its snapshot is no longer cached; reopen the file and select again. Each design-project setup also keeps its address in `views/*.endpoint.json` and its background log in `views/*.log`. Both contain the viewer's access URL, so on macOS and Linux they are readable only by the current user, and relocation copies the address records unchanged. The address stays the same across restarts; to issue a new one, stop the viewer and delete its `.endpoint.json` file.

Keep `.github/extensions/cad-explorer/` limited to the entry point. The Copilot app's repository-trust check counts every file under `.github/extensions/`, including Git-ignored data, against its size, entry-count and depth limits, and refuses to accept the extension when they are exceeded.

The runtime directory is local and Git-ignored. It is not a backup of a design project. Preserve useful references, snapshots, drawings and images before deliberately deleting runtime data or moving the checkout to another absolute path.

To relocate the Copilot canvas's runtime directory within this checkout, stop its Explorer processes and run `node explorer/scripts/relocate-runtime.mjs <source-.runtime-directory>` from the workbench root, then reload the extension. The destination must not exist; the command verifies the copy before removing the source and updates saved snapshot paths. It does not create old-path redirects or rewrite previously pasted chips.

## Validation

The repository-wide entry point is `node tools/check.mjs`, also available as the VS Code **CAD-Pilot: Check all** task. It covers both the workbench and maintained Explorer. **Test Python** and **Test Explorer core** provide narrower editor tasks without launching Chromium. Python discovery includes `explorer/tests/test_converter.py` and all of the cad skill's tests; see the root README for dependency/API compatibility and fresh-resolution guidance.

Use these commands from the workbench root for narrower checks:

| Scope | Command | Coverage |
| --- | --- | --- |
| Complete Explorer | `npm --prefix explorer test` | Core checks, then the browser suite |
| Non-browser | `npm --prefix explorer run test:core` | Geometry helpers, section planes, commands, HTTP, references, persistence, cache compatibility and ownership |
| Browser | `npm --prefix explorer run test:browser` | Real selection/clipboard, camera matrices, Studio, section caps, drawing recovery, diagnostics and delayed render reports |
| One CI share | `node explorer/scripts/test.mjs shard 2/4` | What CI's `explorer 2/4` jobs run: a share of the test files, balanced by the times in `tests/durations.json` for this platform; `--list` prints the files, and `--durations <file>` records each file's time |
| Build only | `npm --prefix explorer run build` | Type-check and production assets; skipped when the sources, configuration and installed packages match the last successful build |
| Native converter | `uv run pytest explorer/tests/test_converter.py -q` | STEP topology, placements, face/edge retention, cleanup and resource/error boundaries |
| Mesh reader and measurement | `uv run pytest explorer/tests/test_mesh.py -q` | Mesh formats, frames, faults, the geometry file, section fits and distances |

Core checks do not launch a browser; some require the workbench's Python environment for native fixtures. Browser checks also require Playwright Chromium from the root setup. They run a few files at a time (a quarter of the cores, at most three; scenarios within a file run in order) against isolated synthetic views, never a user's open model. The camera resize/DPR scenario is included, not an opt-in environment flag. Context-loss scenarios deliberately damage only their disposable renderer.

Both suites build the Explorer first when it is out of date, because the browser scenarios and the launcher's background viewers serve the built page. For a targeted run, build first if it uses either, then pass individual files to Node. For example:

```text
node --test explorer/tests/commands.test.mjs explorer/tests/protocol.test.mjs explorer/tests/copilot-host.test.mjs
node --test --test-concurrency=1 explorer/tests/render-reports.test.mjs explorer/tests/render-reports-browser.test.mjs
```

Name browser suites `*-browser.test.mjs` so the runner discovers them in the correct group. Shared Node fixtures own service startup/shutdown and a disposable runtime root for models, inputs, references, captures, reviews and view leases; test services and inspection use the same root. These stores are removed on success or failure, never merged with the user's durable runtime. `browser_session.py` owns state polling and settled-command checks. Scenario-specific pointer actions, assertions and delayed-response injection stay in the individual scripts. Each test process runs its scenario and fixture scripts through one Python host (`tests/python-host.mjs` and `tests/browser_host.py`): every script runs as from a command line, but Playwright, Chromium and imports such as build123d start once, and each scenario gets fresh browser contexts that close when it finishes. A scenario script takes `sync_playwright` and `launch_chromium` from `browser_session.py` (`test_browser_scripts.py` checks this) and still runs on its own with `python tests/<script>.py --url … --output …`. On a runner that runs browser files one at a time, a CI shard's files share one test process and so one host. Browser evidence may be retained under `explorer/.local/`, separately from disposable runtime data.

Preserve these contracts when changing their owners:

| Contract | Regression files in `tests/` |
| --- | --- |
| Exact face/edge identity, pixel-space picking, occlusion and clipboard behavior | `references.test.mjs`, `edge-picking.test.ts`, `edge-browser.test.mjs`, `viewer-browser.test.mjs` |
| Fresh measured cleanup versus unknown historical counts; immutable caches and failed-import recovery | `model-import.test.mjs`, `diagnostics.test.mjs`, `cache-migration.test.mjs`, `cleanup-persistence-browser.test.mjs`, `test_converter.py` |
| Warning/info panels do not obscure controls or alter camera and drawings | `import-warnings-browser.test.mjs` |
| Actual camera scale/pose across resize, projection, explosion and capture | `camera.test.ts`, `camera-browser.test.mjs`, `explode-camera-browser.test.mjs`, `studio-views-browser.test.mjs` |
| Section planes in model-world coordinates across nested, repeated, fixed, hidden and exploded occurrences; caps that keep holes and gaps open; trimmed edge picking with unchanged references; persisted, captured and reviewed section poses; closed-solid identity for immutable caches | `section.test.ts`, `protocol.test.mjs`, `section-browser.test.mjs`, `cache-migration.test.mjs`, `test_converter.py` |
| Review conflicts preserve unsaved local marks and other writers' data | `reviews.test.mjs`, `review-recovery-browser.test.mjs` |
| Stale render reports neither write state nor release current waiters; genuine current errors remain visible | `render-reports.test.mjs`, `render-reports-browser.test.mjs` |
| View ownership, file-cache invalidation and runtime relocation | `view-registry.test.mjs`, `inspection-cache.test.mjs`, `runtime-relocation.test.mjs` |
| Test storage/inspection isolation and preference-only action acknowledgement | `runtime-isolation.test.mjs`, `copilot-host.test.mjs` |
| Automatic explode: subassemblies separate before their parts, same-height layers on an axis, coaxial parts sliding out along their own axes, no overlapping boxes at full explode across subassemblies, side-by-side fallback, the fixed part, a drift-free return to assembled, first-layout time on 20,000 parts | `explode.test.mjs`, `model.test.ts`, `section.test.ts` |
| Assembly sequences: label and group resolution, carried parts, build-up hiding, step validation, explosion exclusivity; exporter ordering, direction, late-path, installed-overlap and stand-in checks; renders and captures wait for a step to settle, section range, cancelled drags | `assembly.test.mjs`, `test_assembly.py`, `assembly-browser.test.mjs` |
| Design-project viewer: one background viewer per setup, in-place reload keeping a matching view, also when a viewer starts with its file, stable address across restarts, compact answers with the main file's own revision, options each command reads, background captures and renders (hidden parts named like sequence parts), references and gated shutdown | `launcher.test.mjs`, `launcher-browser.test.mjs`, `view-reload.test.mjs`, `mesh-import.test.mjs` |
| Background rendering: starting only when no page answers, the viewer page's grace and meshing time (only for a page in front), a renderer that cannot start or crashes ending the wait once the page has had its grace, a browser that exits as it starts, the address sent only over the debugging pipe, one profile per browser removed after it exits, the Linux sandbox switch, software fallback including a page that cannot create WebGL, crash, pipe-reset and missing-browser reports, loads that still open when nothing can draw, captures taking turns and never released by a viewer page's or a closed page's report | `renderer.test.mjs`, `renderer-browser.test.mjs`, `render-reports.test.mjs`, `launcher-browser.test.mjs` |
| Viewers from another workbench checkout restarted from this one, the same checkout through a link or another spelling recognised; references resolved from either host's store | `launcher.test.mjs`, `references.test.mjs` |
| Storage retention: setups' snapshots kept, age and size limits, capture count, orphaned references and geometry, staging and one-shot render folders, a snapshot reused during a prune kept, a running mesh view served from memory, added files read again or named when their copy is gone | `runtime-store.test.mjs`, `model-import.test.mjs`, `mesh-import.test.mjs` |
| Mesh files: formats, names and placements, units and up axis, exact-only welding, fault positions, the manifest and geometry-file contract, open-mesh sections, point references, several files per view with their own references and restart; measurement fits, distances and faults; a faulty scan beside a STEP in the browser and captured in the background | `test_mesh.py`, `mesh-import.test.mjs`, `mesh-browser.test.mjs` |

The service reports the actual rendered camera and topology revision, not just requested parameters. Browser clipboard behavior, native host chip presentation and delivery to the next user message remain separate acceptance checks. Synthetic scenarios do not certify large-assembly responsiveness, physical fit or manufacturing suitability.

## Maintenance boundaries

`python/mesh.py` owns reading mesh files, their frame, welding and faults, and writes a JSON manifest with one binary geometry file; `python/measure.py` measures through the same reader. `shared/mesh.mjs` owns the file types and the typed views over that geometry file, which the server validates once and the page uses without copying. `server/documents.mjs` composes the files in a view, and `shared/arrangement.mjs` places them from view state, the same way on the server and in the page; references always name a single file's own revision. `shared/commands.mjs` owns canvas action schemas and revision/render/review policies. The Copilot host adapter projects those definitions into SDK actions, and `scripts/explorer.mjs` offers the same canvas actions through `do`. `server/assembly.mjs` owns reading and resolving a STEP's sequence file, and `python/assembly.py` owns writing and checking it from a design source. `server/launcher.mjs` owns finding, starting, reusing and stopping a design project's viewer; `server/endpoint.mjs` owns its private address record. `server/renderer.mjs` owns finding, starting and stopping the background Chromium, and `src/HeadlessApp.tsx` is the page it shows; `server.mjs` decides which renderer a confirmation or capture waits for. `server/summary.mjs` owns the compact summary, `server/runtime-store.mjs` storage retention and `server/render-once.mjs` one-shot renders. Only hosts that pass `onShutdown` expose the shutdown route; server handlers still validate model identity, geometry, cameras and stored data in context. HTTP inputs and canvas schemas are deliberately not interchangeable. Reads and snapshot loads retain their existing revision semantics; explicit draft attachment and camera persistence require a current revision.

`server/model-import.mjs` stages each import privately, validates it, then atomically publishes complete immutable source/cache files with same-filesystem hard links. Existing files, including a concurrent import's winner, are verified rather than overwritten. Conversion/validation failures remove only private staging data. Once published, shared artifacts are retained even if later cleanup or view-metadata persistence fails: another view may already depend on them. The local runtime filesystem must support hard links; unsupported publication fails explicitly. `server.mjs` publishes the live model only after saving its view metadata. If cleanup also fails, the original import error/code/status remains primary and the cleanup diagnostic remains visible.

Frontend lifetimes are feature-specific: `useSelection` handles selection/clipboard feedback, `useViewCapture` coordinates captured-review transitions, `useSectionControl` owns the uncommitted section-plane draft and its displayed range, `useStepPlayer` owns the animating assembly-step position, and `useRenderReports` scopes queued sends and failures to the active model/view. Its revision bookkeeping is private; `Rig` uses named invalidation and capture-readiness operations instead of mutating report refs. Camera ownership stays in `Rig`/`CameraController`; drawing-save recovery stays in `useReviews`. Do not combine their cancellation counters or remove the model/view/unmount guards merely to share code.

Services default to the durable runtime described above. Internal callers can supply a `runtimeRoot`; all service-owned storage, leases and reference inspection are scoped together. Core tests pass `renderer: null` and stand in for renderer pages themselves; browser tests use the real background renderer. Launcher tests isolate real background viewers the same way through `CAD_EXPLORER_RUNTIME_ROOT`. This is a test/service boundary, not a new canvas input or a change to existing saved paths.

## Provenance

The Explorer is first-party apart from the code recorded here. Keep each entry's notice with it.

### Automatic explode layout

- Source repository: https://github.com/earthtojake/text-to-cad
- Source path: `packages/core/src/lib/viewer/explodedView.js`; its `explodedView.test.js` was read for behaviour.
- Source revision: `2f793659fb7bab537e2f00836e06448fc4087cb2`
- Imported: 2026-10-22.
- License: MIT, Copyright (c) 2026 Thompson Labs LLC; the notice is reproduced below.
- Scope: the hierarchical layout adapted into `shared/placement.mjs`: the level-by-level walk with wrapper collapse, radial offsets from spread, clearance and level falloff, the centred-child threshold, sibling separation, and overlapping level windows with smoothstep. Two scenarios in `tests/explode.test.mjs` (a shaft in a housing, siblings with nearby centres) follow upstream test cases.
- Local changes: rewritten over the Explorer's node tree and world matrices instead of occurrence-path records, without three.js; measured once per model and direction; levels that move nothing take no share of the slider; the fixed part is held by subtracting its offset from every part. Children centred on their parent are stacked with the X/Y/Z stacking along the axis their centres spread along, falling back to upstream's longest side only when they share a centre: upstream's per-child longest side laid flat coaxial plates out side by side. Only children that reach their parent's centre count as centred; when several share a centre each slides out along its own axis, the side unlike its other two, rather than its longest side, so a bearing leaves a housing along its thickness. Levels are laid out deepest first and siblings are separated by the boxes their spread-out parts fill, so cousins clear each other; overlap tests use a uniform grid instead of comparing every pair, with more separation sweeps and a cap for dense piles. The X/Y/Z axis stacking and its side-by-side fallback are original CAD-Pilot code. Upstream's ease-out, bounds and scene helpers are not used.

```text
MIT License

Copyright (c) 2026 Thompson Labs LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

To update, review an explicit upstream commit and its license against the pinned revision, record the new revision and any further local changes here, then run `explode.test.mjs` and look at a real assembly exploded in each direction.

## Limits

CAD Explorer loads snapshots; it does not watch source files, simulate disassembly, slice models, repair meshes or control printers. Automatic explode separates bounding boxes, not shapes: it is not a disassembly path, and interlocking parts can still look interleaved. Assembly steps are straight-line display offsets, and the optional sequence check is a rigid geometric screen run by the exporter, not a physical simulation. Section caps are a tessellated display aid, not precise geometric measurements, new B-rep faces, a cut STEP, a minimum-wall check or exported print geometry. Large-assembly performance is not certified. Native conversion runs trusted local code, not a sandbox, with a 100 MB STEP cap, a 300 MB and 4-million-triangle mesh cap, and a two-minute timeout. Mesh measurements and section caps describe triangles, not the exact object they approximate.

See the repository's [ownership and provenance guidance](../README.md#provenance).
