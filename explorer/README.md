# CAD Explorer

First-party STEP and mesh viewer: the project-scoped GitHub Copilot desktop canvas, and a local browser viewer that other agent hosts, such as Claude Code, open and drive from a design project. The application lives here; `.github\extensions\cad-explorer\extension.mjs` is only the Copilot entry point. The cad skill generates and inspects the STEP files it shows, and the visual-review skill says how agents use it. Mesh files (STL, OBJ, 3MF, PLY, GLB), such as vendor parts, remixes and scans, open directly; STEP stays the authoring path.

## Build and open

From the workbench root, with the workbench's Python environment:

```powershell
uv sync
Push-Location explorer
npm install
npm run build
Pop-Location
```

Build output, dependencies and `package-lock.json` are Git-ignored (AGENTS.md has the lock policy). Rebuild after changing the application, and reload project extensions in Copilot after changing the extension. Missing assets produce the build command rather than an empty success state.

The canvas takes an explicit authorized `projectRoot`, a STEP or mesh `file` inside it and an optional `viewId` for its remembered setup; without a file it restores that setup, or the synthetic demo when there is none. The default project is the workbench checkout. Open imports another local snapshot and Add file shows one beside it; source files are never modified and Python generators are never executed. Canvas actions answer with the same summary as the design-project `state`; `get_state` with `detail: "full"` returns everything, and `capture_image` accepts `width`, `height` and `background`.

A remembered setup holds the active model, camera, hidden and exploded parts, section settings and drawing reviews. There is one live panel per setup; independent `viewId` values give side-by-side setups. An exclusive OS lease (a named pipe on Windows, a socket file on macOS and Linux, reclaimed when no process listens on it) stops two Explorer processes writing one setup, and equivalent Windows path spellings resolve to the same owner.

## Use from a design project

Hosts without the Copilot canvas use `scripts/explorer.mjs`, run from the design project's root, which becomes the viewer's root. Results are JSON; failures exit nonzero with one plain sentence. With `$Workbench` holding the workbench path, the command is the same in bash and PowerShell:

```text
node "$Workbench/explorer/scripts/explorer.mjs" open outputs/part.step
```

`open` starts the project's viewer in the background, loads the file, waits until a renderer has drawn it and returns a summary with its URL. The viewer outlives the command. Running `open` again reloads the file into the running viewer at the same URL, and never starts a competing one. When the same file is reloaded and every part keeps its name and place in the assembly tree, the reload keeps a camera the person moved, the section, explosion, assembly step and hidden parts (`view.kept` is true) and fits an unmoved camera to the new geometry; otherwise the view starts afresh with only display preferences kept. A viewer that starts with a file restores its saved setup first, so this also holds after a stop or restart. Each project and setup keeps one address across restarts unless another program takes its port, and an open page reconnects by itself.

| Command | Purpose |
| --- | --- |
| `open [file] [--units ...] [--up ...]` | Start or reuse the project's viewer, load the file and confirm it was drawn. Without a file it restores the remembered setup. `--units` and `--up` say how to read a mesh. |
| `state [--full]` | The model's name, file, `revision` (the first 12 hex digits of the main file's SHA-256) and `generatedAt` (its modified time), the view (`view.camera` in the shape [`render`](#background-rendering) reports, with `viewHeight` once a renderer has drawn the view and `view` "moved by the user" once the person has moved it; `view.files` when it shows several), and `shown`: how many pages are open, whether one has drawn the current revision (`seen`) and which renderer drew it (`drawn`). `note` says when no page is open, the open page has not drawn the view, or an added file had to be left out and why; `changedOnDisk` when the file changed after loading. `--full` adds parts, references, the files as `documents` and the renderer's report. |
| `actions` | The view actions `do` accepts, with their inputs. |
| `do <action> [key=value ...]` | Run a view action, such as `do set_view preset=top`, `do set_view azimuth=45 elevation=32`, `do set_section enabled=true axis=x position=12`, `do set_explode amount=0.4` or `do set_step step=2`. Values that read as JSON keep their type; one JSON object also works where the shell preserves quotes. |
| `capture [path.png]` | Save an image of the view, drawn in the background at 1280x800, optionally copied to a `.png` inside the project; `--size WxH`, `--background "#rrggbb"`, the [analysis options](#analysis-views) and [ray tracing](#ray-traced-view) (`--samples`, `--time`) apply to that image only. Its answer includes the camera that drew the image, as [`render`](#background-rendering)'s does; `state`'s camera is the one that drew the view, which may be a person's page of another shape. |
| `render <file> <out.png>` | Render a STEP or mesh to a PNG inside the project without opening or changing any viewer. |
| `prune [--dry-run] [--all] [--copilot]` | Remove old snapshots, model caches and captures that no saved setup shows. |
| `inspect <reference>` | Resolve pasted reference text, a `cadproto:v2` address, a descriptor JSON path or Copilot chip markup, including mesh parts and picked points, from this viewer's store or the Copilot canvas's. No viewer needs to be running. |
| `stop` | Stop the project's viewer; its address, saved setup and reviews are kept. |

`open` fails with the build command when the Explorer is not built and with one sentence when the file is not in the project. Each command refuses options it does not read. Simultaneous `open` calls for one setup share one viewer. Every workbench checkout shares the store, so a setup's viewer may come from another checkout: `open` restarts it from this one at the same address (`replaced` names the other checkout; links and other spellings of a path count as the same checkout), and other commands say so instead of driving the other checkout's code. View actions return the committed view at once; `open` and `capture` wait for a drawing. `--view <name>` (or `CAD_EXPLORER_VIEW`) selects an independent setup. `server/standalone.mjs` is the same viewer attached to a terminal; started again with a file, it reloads it in the running viewer and exits.

## Background rendering

A view counts as shown once a renderer has drawn it: a person's page or the viewer's background renderer, the same page without controls in Playwright's headless Chromium shell (`CAD_EXPLORER_CHROMIUM` names another Chromium). A viewer starts it when a view needs drawing and no open page answers within about a second and a half (up to 15 s while a page in front is still meshing a model it just fetched), so a hidden canvas, a background tab or no tab never leaves a load unconfirmed. It uses the GPU through ANGLE, falls back to software WebGL where there is no usable GPU, stops after two idle minutes and exits with its viewer; each browser gets a temporary profile, removed after it exits or at the next start. The viewer's private address reaches Chromium only over its debugging pipe, and it only loads the viewer's page on 127.0.0.1. On Linux it runs without Chromium's sandbox, as Playwright does by default. A browser that crashes or exits at start fails the work waiting on it, with its exit status and last error. When nothing can draw, a load or view action still succeeds and its `note` says why (with the install command where that is the reason); captures fail.

Agents' captures always come from the background renderer, one at a time: the person's camera once they have moved it, otherwise the view preset fitted to the image. A custom background replaces the backdrop, leaving out Studio's floor and the Inspect grid. A capture while a drawing review is open is the review's saved version, marks included. The page's own Capture button saves what that tab shows.

`render <file> <out.png>` loads a file into a private, temporary viewer that saves no setup and applies, in order, `--hide "label,label"` (labels resolved as in [assembly steps](#assembly-steps); a label that matches nothing, or hiding every part, is refused), `--explode amount[:direction]`, `--step N[:buildup]`, `--section axis[:position][:flipped]`, `--projection`, `--appearance`, `--finish`, `--outlines on|off`, the [analysis options](#analysis-views), `--samples N` and `--time S` (which [ray trace](#ray-traced-view) the image) and `--view` (a preset or `AZ:EL` in degrees: azimuth 0 looks from the front and 90 from the right; elevation 90 looks down), then writes one image (`--size WxH`, `--background "#rrggbb"`). It reads files like `open`, prunes the shared store when it finishes, and never moves a person's view. Its answer includes the camera that drew the image: `view`, `projection` and `viewHeight`, the view's height in millimetres at the target. An orthographic render up to 20 times taller than it is wide shows `viewHeight / height` millimetres per pixel, so renders of different parts can be brought to one physical scale.

## Model, views and appearance

STEP/STP parts and assemblies load through the workbench's local OCP converter with repeated occurrences, placements, names and supported part colours. Parts and groups nobody named are named as the cad skill names them, so the tree shows the names `scripts/inspect parts` lists. Different surfaces within one part, transparency and source visibility flags are not fully represented; detected limitations appear as import warnings in the header's warning button. Display cleanup of verified kernel point edges and exactly zero-area triangles is summarized separately as information and removes no CAD faces. Missing colours use blue-grey. The demo has a blue base, green cover and gold spacers.

The header shows the model's `rev` (the main file's hash prefix, unchanged by added files) and modified time, matching what `state`, `capture` and `render` report.

Orbit, pan, zoom, fit, six axis views and any `azimuth`/`elevation` are available; dragging orbits like a turntable around Z. Right is +X, back +Y and top +Z; Z is the source model's up direction, not a manufacturing instruction. Perspective and orthographic projection share the camera direction and target-plane scale, and resizing never silently changes zoom. Inspect uses a grid and readable outlines; Studio uses reflections, soft shadows, a floor and visual finishes (matte by default, plastic, satin or polished metal, rubber) that are not measured materials; [Ray traced](#ray-traced-view) path-traces Studio's light and finishes. No remote images or conversion services are used.

Explode follows the assembly's own tree, down to three levels: the slider first moves top-level parts or subassemblies from the assembly's centre, then the parts within each. Outward moves each group in the direction it sits from its parent's centre; groups at their parent's centre stack along the axis their centres spread along or, when they share a centre, slide out along their own distinct axis (a shaft's length, a bearing's thickness). Up/down, Left/right and Front/back stack groups along Z, X or Y in the order they sit, falling back to a side-by-side layout when nothing would separate. At full explode no two part boxes overlap; a pile of hundreds of mutually overlapping parts is left where the first offsets put it. Keep fixed holds a chosen part in place. Explosion, hiding and showing parts keep the camera; Isolate and Show all fit the visible parts.

Section view is a visual cutaway along X, Y or Z in model-world coordinates. Its range spans the visible displayed occurrences, including explosion, and axis changes and Reset use the displayed midpoint. Reassembly, hiding or a pose change clamps the plane only when it falls outside the remaining visible bounds, and a reload with an unchanged part tree keeps it. `flipped` false keeps coordinates at or below the plane, true at or above it. Closed solids and closed meshes get display-only caps, so bores, voids and gaps stay open; open meshes and STEP surfaces are cut with an amber outline and no cap. Caps are not CAD faces: they cannot be selected and block picking through the cut. The converter records which parts are entirely closed solids as part of the topology identity; older caches without it keep their references but leave section view unavailable until the STEP is reopened.

## Analysis views

Analysis views colour or overlay every part a view draws, STEP previews and mesh files alike, to show how its triangles sit. Set them in the page's Analysis panel, with `do set_analysis`, or with `render` and `capture` options; a capture's options apply to that image only and leave the view as it was. The settings are a display preference, kept when another file opens. A legend in the view's top-left corner explains each colour map, with its scale, and each overlay's colour; captures draw it into the image. `state`, `capture` and `render` report the settings under `analysis`, with the legend's numbers: `thinnest` for wall thickness and `curvatureScale` for curvature. Ghost files stay plain references. These are review aids drawn from displayed triangles, not print checks: the fdm-design skill says how to read overhangs and walls.

| View | `do set_analysis` | `render`, `capture` | Shows |
| --- | --- | --- | --- |
| Triangle edges | `triangleEdges=true` | `--overlays triangles` | Every triangle edge, thinly over the shading. Outlines, by contrast, show only edges sharper than 30° and open borders. |
| Back faces | `backfaces=true` | `--overlays backfaces` | The back of every triangle in red, so inside-out parts, flipped patches and holes into a part show. |
| Overhang | `map=overhang overhangAngle=45 buildDirection=[0,0,1]` | `--overhang 45[:+z]` | Faces facing down more than the angle from vertical (0 is an upright wall, 90 a flat underside), from amber at the angle to red at a flat underside; faces resting on the plate, the lowest point along the build direction, are blue. Explorer Z is the model's up, not a print orientation, so set the direction the part will build toward: an axis such as `-y` or three numbers. |
| Wall thickness | `map=thickness minimumWall=1` | `--wall 1` | Thickness from red below the minimum wall through yellow and green to blue at four times it; grey where a ray finds no opposite wall. |
| Curvature | `map=curvature curvature=mean curvatureScale=null` | `--curvature mean[:scale]` | Mean (1/mm, red where convex) or Gaussian (1/mm², red at domes, blue at saddles) curvature from blue to red over plus or minus the scale; without one, the scale is fitted to the shown parts (90 % of their vertices, rounded to 1, 2 or 5). Grey marks open borders. |
| Zebra stripes | `map=zebra` | `--map zebra` | Reflections of parallel light strips, fixed to the view: stripes kink at creases and bunch where curvature changes. |
| Normals | `normals=true` | `--overlays normals` | Each triangle's normal as a short line from dark at its base to bright at its tip, a twentieth of the part's diagonal long, at most one for each cell one and a half lengths across and each of the six directions a triangle mostly faces (from the largest such triangle), so both sides of a thin wall keep theirs. Lines pointing into a part are hidden by its surface. |

`--map none` turns a colour map off, and `--overlays` names every overlay to draw (`none` for none). The overhang, thickness and curvature options choose their map.

Limits, each following from the triangles drawn:

- Wall thickness casts one ray per triangle, from its centre straight inward against its normal, to the first surface it meets, through a bounding-volume tree in a background worker; each vertex shows the thinnest of the triangles meeting there. A ray counts only where it leaves through the back of a surface, as from inside a closed part, so inside-out patches and open sheets read as no opposite wall; slivers, whose normals rounding decides, cast none. Along the normal, the narrow side of a thin plate reads the plate's length, and `thinnest` includes knife edges such as a tapered rim. A mesh file's large triangles carry a thin wall's colour across to the next vertex. It samples triangle centres, so it is a screen, not a minimum-wall certification. A dense mesh takes seconds; the view and its captures wait for it.
- Curvature joins vertices at the same position (a STEP preview repeats a vertex on every face that meets there), then estimates mean curvature with the cotangent formula and Gaussian curvature by angle deficit, each over a vertex's mixed Voronoi area. On a tessellated STEP it reflects the triangulation: sharp edges and corners get large values set by their triangles' size, and facets give a curved face's radius only approximately. On a scan it shows the noise.
- Overhang and zebra stripes follow the shading normal: interpolated across a STEP face, a mesh file's own triangle. Mesh stripes therefore step at every triangle edge.

## Ray-traced view

The Ray-traced appearance (Ray traced in the Appearance settings, or `do set_appearance mode=raytraced`) path-traces the parts a view draws with three-gpu-pathtracer's WebGL tracer. Studio's soft boxes, drawn as a studio around the model, light them, and Studio's finishes (matte, plastic, satin and polished metal, rubber) are physical materials with their roughness, metalness and clear coat, so reflections, soft shadows and contact shading all come from that light. A page refines it a sample at a time up to 512 samples, with a counter in the view's corner, and an edge-avoiding filter guided by the parts' normals, depth and colours smooths the noise. Moving the camera starts it over; showing, hiding or moving parts prepares its scene again, and until the scene is prepared and the tracer compiled the Studio view shows. A page drawing with software WebGL keeps the Studio view and says so: compiling the tracer there holds the browser's GPU process, and every tab's drawing, for a minute or more.

`render` and `capture` take `--samples N` and `--time S` (`samples` and `seconds` for `capture_image`), which ray trace that image and stop at whichever comes first; the images of a ray-traced view take 128 samples or 60 s. The answer's `raytrace` gives the `samples` reached of those `asked`, the `seconds` traced, the time `waited` in all and what `stopped` it, and the WebGL `renderer`. The tracer compiles its shader before its first sample: seconds on a GPU, a minute or more in software WebGL (headless Chromium without a usable GPU), which then traces for at most 20 s; its `note` says so.

The traced view leaves out section cuts, outlines, analysis views and mesh faults, and traces ghosts with their see-through material. Its light and finishes are visual, not measured materials. Its scene is a merged copy of the shown triangles with its own bounding-volume tree, so a dense mesh needs that much memory again.

## Meshes, scans and other people's models

STL, OBJ, 3MF, PLY and GLB files open directly (`open scan.obj`, or Open in the page): their triangles are drawn as they are, with no conversion to STEP. Parts keep their names (OBJ objects or groups, 3MF and GLB objects with their placements, ASCII STL solids, otherwise the file name) and supported uniform colours. Mesh parts use flat shading, and dense meshes are picked through a bounding-volume tree built in a background worker, so million-triangle parts stay interactive.

Units and up axis come from the file when its format says (3MF declares its unit; glTF is metres, Y up), otherwise from convention and size: STL, 3MF and PLY are Z-up, OBJ Y-up, and unitless files are millimetres unless the whole model is under 2.5 units across, when they are read as metres. `state` gives the frame used and why (`model.frame`, or under `view.files`). `--units mm|cm|m|in|ft|um` and `--up z|y` (or `units` and `up` for `add_file`) override them; everything is shown Z-up in millimetres.

Exactly equal vertices are merged so connectivity can be checked; nothing is repaired. A selected mesh part shows its triangle count, whether it is closed, and its faults: open edges, edges shared by more than two triangles, edges whose triangles wind the same way, and zero-area triangles, which `set_faults` draws in red, magenta, orange and yellow, named in the view's legend. Faces and Edges do not apply to meshes; Points (`set_selection_mode mode=point`, the default for a mesh) picks a spot on any surface, mesh or STEP. These are viewer facts, not print limits; a mesh over 300 MB or 4 million triangles is refused.

### Several files in one view

`do add_file file=scan.stl` adds a file in its own frame as a see-through ghost that clicks pass through; its parts can still be selected from the list or with `select_parts`. `do set_file id=ref1 style=solid offset=[0,0,5] rotate=[0,0,180]` restyles or moves one (degrees about X, then Y, then Z, before the offset), `do set_layout mode=side|overlay` lays files side by side along X or back over each other, and `do remove_file id=ref1` removes one. Reopening the main file keeps the added files; one whose model was pruned is rebuilt from Explorer's copy of what was added, or from its project file while that still holds the same bytes, and is otherwise left out with a `note` saying why (`state.droppedFiles` has its `reason`: `changed`, `missing` or `unreadable`). Placement and layout are display only and never change a file, its measurements or its references. Up to eight files share a view. An added file's ids are prefixed with its id, such as `ref1/node:1`, and explode, hide, section and capture treat each file as one top-level group.

### Measuring meshes

`python/measure.py` reads a mesh exactly as the viewer does, with the same `--units` and `--up`, and prints JSON in millimetres on the viewer's model-world axes. Run it with the workbench's Python from the design project's root:

```text
python "$Workbench/explorer/python/measure.py" scan.obj --units m size
python "$Workbench/explorer/python/measure.py" part.stl section --z 4.5 --points 200
python "$Workbench/explorer/python/measure.py" part.stl distance --from 10,0,4 --to 10,25,4
python "$Workbench/explorer/python/measure.py" new.stl distance --to-file original.stl
python "$Workbench/explorer/python/measure.py" scan.stl faults
```

| Command | Result |
| --- | --- |
| `size` | Overall and per-part bounds, triangle counts, closed or open, surface area, volume of closed parts and fault counts. |
| `section` | Every loop where a plane (`--x`, `--y`, `--z` or `--plane POINT NORMAL`) cuts the triangles: length, area, bounds, whether it is a hole, the smallest bounding rectangle, a circle fit (centre, diameter) and a slot fit (width, length, axis), each with RMS and largest deviation, and a shape guess. `--points N` adds the outline. |
| `distance` | Between two points; from a point to the closest surface point; or, with `--to-file`, how far each vertex lies from another file's surface (minimum, maximum with where, mean and 95th percentile). |
| `faults` | Open borders with their lengths, centres and bounds, and the first 50 over-shared and flipped edges and zero-area triangles. |

`--part <name>` limits a command to matching parts (`*` and `?` only), and `--part`, `--units` and `--up` may come before or after the command. Measurements describe the file's triangles; a fit's residuals say how well a circle or slot matches the outline, not how accurate the scan was. A picked point's reference is in part-local coordinates; `inspect` gives its world position for `--from`.

## Assembly steps

A STEP can carry an assembly sequence in a sibling `<name>.assembly.json`, such as `outputs/stop.assembly.json` beside `outputs/stop.step`, read whenever the STEP opens or reloads; uploads have none. The demo includes a two-step sequence.

Each step has a `title`, an optional `note`, `parts` and a `from` offset in model millimetres: where those parts wait before the step brings them to their STEP placement. Parts match part names and labelled group names with `*` and `?` (every other character, brackets included, is literal); a group stands for its parts; an unlabelled group's made-up name never matches; and a group holding every part, such as the top-level assembly, never matches, so a pattern matching only it is reported as unmatched. A step whose patterns name every part is refused, since it would have nothing to arrive at. Naming a part again in a later step carries it along; parts no step names stay in place. Unmatched labels and a sequence written for different STEP bytes are reported in the step panel and `state`.

The bottom bar's Assembly steps button opens them: step 0 shows every sequenced part waiting at its offset and the last step is assembled; Exploded keeps waiting parts visible with dashed paths, and Build up hides them until their step. Steps animate without moving the camera, and render reports and captures wait until a step has finished moving. Agents use `do set_step step=2`, `mode=buildup` and `off=true` (`step=null` also works from the command line). A nonzero explosion or Reassemble turns the sequence off.

`python/assembly.py` writes the file from a design source's `gen_assembly()`, returning `{"steps": [...]}`. It loads the source as the cad skill's tools do and matches `parts` against the generated STEP's parts by the cad skill's names and rules. After generating the STEP, run it from the design root with the same interpreter as the cad tools:

```text
python "$Workbench/explorer/python/assembly.py" source/stop.py --step outputs/stop.step --check
```

`--check` moves each step's parts in a straight line from their placement towards their offset and measures exact B-rep overlap with the parts already placed every 0.5 mm, wherever their bounding boxes can meet along the path; a failed intersection is an error, never a clear step. Each step reports clear, blocked (first blocking part and distance) or interferes (overlapping when installed). A step's `check_shapes` can stand in for one of its parts during the check only, such as a squeezed snap part. The check is rigid and sampled: it does not model flexing, threads, gravity, tool access or friction, and features thinner than the spacing can be stepped over. The sequence never changes the STEP or print files.

## Face, edge and part references

Faces selects a whole CAD face, Edges a whole straight or curved CAD edge (seams included, not triangle boundaries or silhouettes, with curve type and exact length shown), Points a spot on a surface and Parts an occurrence, as does the parts list. Edge picking uses a six-CSS-pixel radius at any zoom, ignores edges behind opaque geometry, follows exploded placements and shows the selectable outlines even when Studio's outlines are off. Section clipping mints no topology: retained faces and edges keep their identity, partly cut edges are trimmed before hit testing, and entities wholly on the hidden side cannot be picked.

Auto-copy copies the selected reference inside the user's click; Copy reference also works explicitly. In the Copilot canvas, pasting into the desktop's rich composer creates a native file-reference chip. The design-project viewer copies readable text for any chat: a summary line such as `CAD Explorer | part.step | Lid | Face f6 (plane, 260.00 mm^2)` followed by the `cadproto:v2` address. Hovering never changes selection or the clipboard, and nothing inserts a draft attachment or sends a message. Clipboard access can be denied by the host; selected-text copying remains.

The address names the exact topology revision and occurrence, and a face (`fN`), edge (`eN`), picked point (`tN@x,y,z`: triangle N in the file's order and the point in the part's own millimetres) or whole part (`part`). In a view of several files it names the revision of its own file. Explosion and appearance do not change it. `cad_explorer_inspect` in Copilot and `explorer.mjs inspect` resolve it: a mesh point is checked against its triangle and reported with world position and normal, a STEP point with the CAD face it lies on. These are not the cad skill's `@cad[...]` ordinals. Cached geometry and source snapshots are validated, and missing or changed data is reported rather than guessed. A kernel update can change tessellation or topology order when a STEP is imported again, producing a new revision; old caches and their references are not rewritten, so re-resolve selections against the new revision.

Inspection keeps compact validated face, edge, part and placement facts, at most four entries and 64 MiB by default, reused while the file identity is unchanged. Clipboard behaviour, native chip presentation and delivery in the next user message are separate acceptance checks.

## Drawing reviews

Draw captures the current appearance, camera, visibility, selection and exploded pose into a fixed image; pen, line, arrows, rectangle, ellipse, highlight and erase work on that image, with undo, redo and reversible clear. Drawing does not orbit the model or copy geometry references, and live rendering pauses beneath it. Copy and Save marked image include the marks, and a saved review records its source revision, pose, appearance and section settings, staying tied to that snapshot. Saves are versioned: a failed or conflicting save keeps unsaved local marks and other writers' work, loading the server's version or discarding local changes is explicit, and the marked image can be copied or downloaded when the service is unavailable. Limits: 20 reviews per setup, bounded image sizes and stroke histories.

## Local data

The design-project viewer keeps saved models, source snapshots, references, view setups, drawing reviews and captures in the user's local application data: `~/Library/Application Support/CAD-Pilot/Explorer` on macOS, `%LOCALAPPDATA%\CAD-Pilot\Explorer` on Windows and `$XDG_STATE_HOME/cad-pilot/explorer` (by default under `~/.local/state`) elsewhere; `CAD_EXPLORER_RUNTIME_ROOT` relocates it. Copies of design geometry therefore stay out of both the workbench and the design project. A mesh's model is a manifest (`models/<revision>.json`) and geometry file (`models/<revision>.bin`), kept and removed together. The Copilot canvas keeps its store in `explorer/.runtime/`, where its chips' absolute descriptor paths point; copy chips again after relocating it.

Both stores are content-addressed and bounded. At most every ten minutes, after imports and captures, a viewer removes snapshots and model caches no saved setup shows once they are 7 days old or beyond 256 MiB in all, captures beyond the newest 50 or older than 7 days, and references whose model is gone. A setup protects what it shows, added files included, while it was used in the last 30 days; reopening one whose model was removed asks for the file again. A running viewer keeps what it shows in memory, and anything written or reused in the last ten minutes is kept, so a prune in another process never removes what a load just reused. `explorer.mjs prune` applies the same rules at once (`--dry-run`, `--all` for everything no recent setup shows, `--copilot` for the canvas's store). Each setup's address is in `views/*.endpoint.json` and its log in `views/*.log`; both contain the access URL and are readable only by the current user on macOS and Linux. To issue a new address, stop the viewer and delete its `.endpoint.json`.

Keep `.github/extensions/cad-explorer/` limited to the entry point: the Copilot app's repository-trust check counts every file under `.github/extensions/`, Git-ignored data included, against size, entry-count and depth limits.

The runtime directory is not a backup of a design project; keep useful references, drawings and images in the project. To relocate the Copilot canvas's runtime within this checkout, stop its Explorer processes, run `node explorer/scripts/relocate-runtime.mjs <source-.runtime-directory>` from the workbench root and reload the extension; the destination must not exist, and the copy is verified before the source is removed.

## Validation

`node tools/check.mjs` from the workbench root covers the workbench and the Explorer (see the root README). Narrower commands:

| Scope | Command | Coverage |
| --- | --- | --- |
| Complete Explorer | `npm --prefix explorer test` | Core checks, then the browser suite |
| Non-browser | `npm --prefix explorer run test:core` | Geometry helpers, analysis settings and fields, section planes, commands, HTTP, references, persistence, cache compatibility and ownership |
| Browser | `npm --prefix explorer run test:browser` | Real selection and clipboard, camera matrices, Studio, section caps, analysis views, the ray-traced view, drawing recovery, diagnostics and delayed render reports |
| Chosen files | `node explorer/scripts/test.mjs camera-browser.test.mjs edges.test.mjs` | Those files of `tests/`, run as the suites run them; CI's jobs run their share of the files this way (`node tools/check.mjs --share <i>/<n>`), and `--durations <file>` records their times |
| Build only | `npm --prefix explorer run build` | Type-check and production assets; skipped when sources, configuration and installed packages match the last build |
| Native converter | `uv run pytest explorer/tests/test_converter.py -q` | STEP topology, placements, face/edge retention, cleanup and resource/error boundaries |
| Mesh reader and measurement | `uv run pytest explorer/tests/test_mesh.py -q` | Mesh formats, frames, faults, the geometry file, section fits and distances |

Core checks launch no browser; some need the workbench's Python environment. Browser checks need Playwright Chromium and run a few files at a time (a quarter of the cores, at most three; scenarios within a file in order) against isolated synthetic views, never a user's model. Both suites build first when the Explorer is out of date; for a targeted run, build first, then pass files to Node, such as `node --test explorer/tests/commands.test.mjs`. Name browser suites `*-browser.test.mjs`.

Shared Node fixtures own service startup and shutdown and a disposable runtime root, removed on success or failure and never merged with the user's runtime. `browser_session.py` owns state polling and settled-command checks. Each test process runs its scenario and fixture scripts through one Python host (`tests/python-host.mjs` and `tests/browser_host.py`), so Playwright, Chromium and imports start once and each scenario gets fresh browser contexts; scenario scripts take `sync_playwright` and `launch_chromium` from `browser_session.py` (`test_browser_scripts.py` checks this) and still run alone with `python tests/<script>.py --url … --output …`.

Preserve these contracts when changing their owners:

| Contract | Regression files in `tests/` |
| --- | --- |
| Exact face/edge identity, pixel-space picking, hover previews, occlusion and clipboard | `references.test.mjs`, `edge-picking.test.ts`, `edge-browser.test.mjs`, `hover-browser.test.mjs`, `viewer-browser.test.mjs` |
| Measured cleanup versus unknown historical counts; immutable caches; failed-import recovery | `model-import.test.mjs`, `diagnostics.test.mjs`, `cache-migration.test.mjs`, `cleanup-persistence-browser.test.mjs`, `test_converter.py` |
| Warning panels never cover controls or change camera and drawings | `import-warnings-browser.test.mjs` |
| Camera scale and pose across resize, projection, explosion and capture | `camera.test.ts`, `camera-browser.test.mjs`, `explode-camera-browser.test.mjs`, `studio-views-browser.test.mjs` |
| Section planes in world coordinates across nested, repeated, fixed, hidden and exploded occurrences; open caps; trimmed edge picking; persisted, captured and reviewed section poses | `section.test.ts`, `protocol.test.mjs`, `section-browser.test.mjs`, `cache-migration.test.mjs`, `test_converter.py` |
| Review conflicts keep unsaved local marks and other writers' data; every drawing tool saves, undoes and copies the PNG it shows; drawing transitions keep the layout and report only genuine context loss; reopening a review suspends live rendering until it loads | `reviews.test.mjs`, `review-recovery-browser.test.mjs`, `drawing-tools-browser.test.mjs`, `draw-transition-browser.test.mjs`, `review-reopen-browser.test.mjs` |
| Stale render reports neither write state nor release current waiters | `render-reports.test.mjs`, `render-reports-browser.test.mjs` |
| View ownership, file-cache invalidation, runtime relocation and isolation, preference-only acknowledgement | `view-registry.test.mjs`, `inspection-cache.test.mjs`, `runtime-relocation.test.mjs`, `runtime-isolation.test.mjs`, `copilot-host.test.mjs` |
| Automatic explode: levels, axis layers, coaxial parts, no overlap at full explode, side-by-side fallback, the fixed part, drift-free return, 20,000-part layout time | `explode.test.mjs`, `model.test.ts`, `section.test.ts` |
| Assembly sequences: matching, carried parts, build-up, validation, explosion exclusivity; the exporter's order, direction, path, installed-overlap and stand-in checks; settled captures | `assembly.test.mjs`, `test_assembly.py`, `assembly-browser.test.mjs` |
| Design-project viewer: one viewer per setup, in-place reload keeping a matching view, stable address, compact answers, options each command reads, background captures and renders, other checkouts' viewers, references from either store, gated shutdown | `launcher.test.mjs`, `launcher-browser.test.mjs`, `launcher-images-browser.test.mjs`, `view-reload.test.mjs`, `mesh-import.test.mjs`, `references.test.mjs` |
| Background rendering: start only when no page answers, grace and meshing time, crashes and failed starts, pipe-only address, profiles removed, Linux sandbox switch, software fallback, loads that open when nothing can draw, captures taking turns | `renderer.test.mjs`, `renderer-browser.test.mjs`, `render-reports.test.mjs`, `launcher-images-browser.test.mjs` |
| Storage retention: setups protected, age and size limits, capture count, orphans, staging and render folders, reuse during a prune, mesh views served from memory, added files read again | `runtime-store.test.mjs`, `model-import.test.mjs`, `mesh-import.test.mjs` |
| Mesh files: formats, names, placements, frames, exact welding, faults, the geometry file, open-mesh sections, point references, several files per view; measurement fits, distances and faults | `test_mesh.py`, `mesh-import.test.mjs`, `mesh-browser.test.mjs` |
| Ray-traced view: image limits and answers, software notes, the appearance and its flags; the page's button and sample counter, a background capture traced to its samples | `raytrace.test.mjs`, `raytrace-browser.test.mjs` |
| Analysis views: settings, flags and legends; edges, wall thickness, curvature, normals and the build plate from the drawn triangles; every STEP and mesh part drawn with them by the page and the background renderer, legends in captures, a capture's own settings | `analysis.test.mjs`, `analysis-fields.test.ts`, `analysis-browser.test.mjs` |

The service reports the rendered camera and topology revision, not just requested parameters. Synthetic scenarios do not certify large-assembly responsiveness, physical fit or manufacturing suitability.

## Maintenance boundaries

- `python/mesh.py` reads mesh files, their frame, welding and faults, writing a JSON manifest and one binary geometry file; `python/measure.py` measures through it. `shared/mesh.mjs` owns the file types and typed views over that geometry, validated once by the server and used by the page without copying.
- `server/documents.mjs` composes the files in a view and `shared/arrangement.mjs` places them, the same way on server and page; references always name one file's own revision.
- `shared/commands.mjs` owns canvas action schemas and revision, render and review policies; the Copilot adapter and `scripts/explorer.mjs do` both project them. HTTP inputs and canvas schemas are deliberately not interchangeable; explicit draft attachment and camera persistence require a current revision.
- `server/assembly.mjs` reads and resolves a STEP's sequence; `python/assembly.py` writes and checks it.
- `shared/analysis.mjs` owns the analysis settings, their validation, colours and legend. In `src/analysis/`, `fields.ts` computes each part's edges, thickness, curvature and normals in `src/geometryWorker.ts` (which also builds picking trees), `material.ts` adds the maps to the surfaces' material, and `legend.ts` draws the legend on the page and into captures.
- `shared/raytrace.mjs` owns an image's ray-tracing limits and how answers describe them. In `src/raytrace/`, `RayTraced.tsx` builds the traced scene from the view's surfaces and runs the tracer, `studio.ts` draws its light and `denoiser.ts` filters its noise.
- `server/launcher.mjs` finds, starts, reuses and stops a project's viewer, and `server/endpoint.mjs` owns its address record. `server/renderer.mjs` owns the background Chromium, `src/HeadlessApp.tsx` is its page, and `server.mjs` decides which renderer a confirmation or capture waits for. `server/summary.mjs` owns the summary, `server/runtime-store.mjs` retention, and `server/render-once.mjs` one-shot renders. Only hosts that pass `onShutdown` expose the shutdown route.
- `server/model-import.mjs` stages each import privately, validates it and publishes immutable source and cache files atomically with same-filesystem hard links, verifying rather than overwriting existing files; failures remove only private staging data, published artifacts are kept, and the original import error stays primary over a cleanup failure. `server.mjs` publishes the live model only after saving its view metadata.
- Frontend lifetimes are feature-specific: `useSelection` (selection and clipboard), `useViewCapture` (captured reviews), `useSectionControl` (the uncommitted section draft), `useStepPlayer` (assembly-step animation), `useAnalysis` (analysis data arriving for the shown parts), `RayTraced` (the tracer's scene, camera and the capture waiting on it), `useRenderReports` (queued reports for the active model and view; `Rig` uses its named invalidation and readiness operations), `Rig`/`CameraController` (camera) and `useReviews` (drawing-save recovery). Do not merge their cancellation counters or remove model, view and unmount guards to share code.
- Services default to the durable runtime; internal callers can pass a `runtimeRoot` that scopes all storage, leases and inspection together. Core tests pass `renderer: null`, browser tests use the real renderer, and launcher tests isolate real viewers through `CAD_EXPLORER_RUNTIME_ROOT`.

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

### Ray-traced view

- Source repository: https://github.com/yxbh/vaultaway, the same author's project, which carries no separate license.
- Source paths: `site/src/photo/denoiser.ts` (the edge-avoiding denoiser), `site/src/photo/webgl.ts` (fixes to three-gpu-pathtracer's shader and its defines set before the first compile) and `site/src/viewer/studio.ts` (a studio drawn as an equirectangular HDR), as `site/src/photo/lighting.ts` uses it.
- Source revision: `2733ff1d004057b14008e7dd4eaa322eb3836a1c`
- Imported: 2026-11-01.
- Scope: `src/raytrace/denoiser.ts`, `src/raytrace/studio.ts` and `patchShader` in `src/raytrace/RayTraced.tsx`.
- Local changes: the denoiser drops depth of field, frame-sliced filtering and the low-memory snapshot, runs its five passes at once, and takes a mesh file's triangle normal where the surface has none. The studio is Studio's four soft boxes over dim walls, turned so its up is the model's +Z. A shader fix that no longer applies stops the view with an error rather than a warning. VAULTaway's WebGPU tracer, worker, tile pacing and resolution scaling are not used: the Explorer traces on its own WebGL canvas, in tiles on a page and whole samples in the background renderer.

To update, compare the source paths at a newer revision, carry over fixes that apply to the Explorer's use, record the revision here, then run `raytrace-browser.test.mjs` and look at a traced render of each finish.

## Limits

CAD Explorer loads snapshots; it does not watch source files, simulate disassembly, slice models, repair meshes or control printers. The ray-traced view's light and finishes are visual, not measured materials. Automatic explode separates bounding boxes, not shapes, so interlocking parts can still look interleaved. Assembly steps are straight-line display offsets and their check is a rigid geometric screen. Section caps are a tessellated display aid, not measurements, B-rep faces, a cut STEP or a minimum-wall check; analysis views are display aids with the [limits](#analysis-views) their triangles give them. Large-assembly performance is not certified. Native conversion runs trusted local code, not a sandbox, with a 100 MB STEP cap, a 300 MB and 4-million-triangle mesh cap and a two-minute timeout. Mesh measurements and section caps describe triangles, not the exact object they approximate.

See the repository's [provenance](../README.md#provenance).
