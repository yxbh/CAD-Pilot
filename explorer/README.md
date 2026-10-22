# CAD Explorer

Maintained first-party STEP viewer for the project-scoped GitHub Copilot desktop canvas, and a local browser viewer that other agent hosts, such as Claude Code, can open and drive from a design project. The application lives here; `.github\extensions\cad-explorer\extension.mjs` is only the Copilot entry point. The workbench's cad skill generates and inspects the STEP files it shows. Python source owns a design's intent; STEP and preview meshes do not carry its parametric history.

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

The canvas accepts an explicit authorized `projectRoot`, a STEP `file` inside it, and an optional `viewId` for its remembered setup. Without a file it restores that setup, or creates the synthetic demo when none exists. The default project is the workbench checkout. Use Open STEP to import another local snapshot; the source file is not modified and its Python generator is never executed.

A remembered setup includes the active model, camera, hidden/exploded parts, section settings and drawing reviews. Reopen its existing panel rather than creating a linked duplicate. Explorer keeps one live panel per setup; independent `viewId` values allow side-by-side setups. Equivalent Windows path spellings resolve to the same owner. An exclusive OS lease also prevents another Explorer process from writing that setup simultaneously. Ownership is released if the owning process terminates: Windows releases the named pipe, and on macOS and Linux the next Explorer to open the setup reclaims a socket file that no process is listening on.

## Use from a design project

Agent hosts without the Copilot canvas, such as Claude Code, use `scripts/explorer.mjs`. Run it from the design project's root with the project-relative STEP path; the project folder is the viewer's root. Results are JSON, and failures exit nonzero with one plain sentence. With `$Workbench` holding the workbench path, the command is the same in bash and PowerShell:

```text
node "$Workbench/explorer/scripts/explorer.mjs" open outputs/part.step
```

`open` starts this project's viewer in the background and returns its URL. Show that URL to the user: in the Claude desktop app open it in the built-in browser pane, otherwise in a local browser. The viewer outlives the command and the chat session that started it. After regenerating the STEP, run the same `open` again: it reloads the file into the running viewer, keeps the camera, returns the same URL and never starts a competing viewer. Each project and setup keeps one address across restarts, so earlier links work again after the viewer restarts unless another program has taken its port; an open page reconnects by itself.

| Command | Purpose |
| --- | --- |
| `open [file.step]` | Start or reuse the project's viewer and load the STEP. Without a file it restores the remembered setup. |
| `state` | Model, camera, selection, section and the renderer's acknowledgement. `rendered` is the last view an open page drew; when it is null or older than `revision`, nobody has seen the current view yet. |
| `actions` | The view actions accepted by `do`, with their inputs. |
| `do <action> [key=value ...]` | Run a view action, for example `do set_view preset=top`, `do set_section enabled=true axis=x position=12`, `do set_explode amount=0.4` or `do set_step step=2`. Values that read as JSON keep their type. One JSON object also works where the shell preserves quotes. |
| `capture [path.png]` | Save an image of the view, optionally copied into a `.png` path inside the project. |
| `inspect <reference>` | Resolve pasted reference text, a `cadproto:v2` address, a descriptor JSON path or Copilot chip markup. No viewer needs to be running. |
| `stop` | Stop the project's viewer. Its address, saved setup and reviews are kept. |

`open` fails with the build command when the Explorer has not been built, rather than handing out a URL to an error page. Simultaneous `open` calls for one setup share a single viewer. View actions return the committed state immediately. `capture` waits until an open page renders the current view; with no page open it reports the URL to open. `--view <name>` (or `CAD_EXPLORER_VIEW`) selects an independent setup for side-by-side comparisons. Copilot's draft-attachment action is not available here.

`server/standalone.mjs` is the same viewer attached to a terminal for manual use. It also reuses a running viewer for the project: started again with a file, it reloads that file there and exits.

## Model, views and appearance

The viewer loads ordinary STEP/STP parts and assemblies through the workbench's local OCP converter. It preserves repeated occurrences, placements, names and supported part colors. Different surfaces within one part, transparency and source visibility flags are not fully represented; detected limitations appear as import warnings. Missing colors use blue-grey. The demo deliberately has a blue base, green cover and gold spacers.

When the live model has import warnings, a warning button with a count appears in the document header. Normal display cleanup of verified kernel point edges and exactly zero-area triangles is instead summarized as low-priority information, with counts for reusable part geometry rather than repeated placements. Cleanup alone shows a neutral information button; mixed imports keep the real warning count and show cleanup separately in the same panel. No CAD faces are removed by this cleanup. Tessellation tolerances, triangle filtering and selectable nondegenerate edges are unchanged; unflagged zero-length edges remain warnings, and invalid or missing geometry remains an error.

Open the header button to read the scrollable details; close them with the X button, Escape or the header button. Details stay above the bottom controls, so they never cover the explosion slider. Opening them dismisses a transient success notice, not an error. Closing the details does not erase diagnostics: reopen them from the same button. Details start closed for each newly loaded model and are not shown over captured drawing reviews.

Orbit, pan, zoom, fit and six exact axis views are available. Dragging orbits like a turntable around Z from every view, including top and bottom, which are held imperceptibly off the pole so their on-screen orientation is kept. Right is +X, left -X, back +Y, front -Y, top +Z and bottom -Z. Z is the source model's up direction, not a manufacturing instruction. The labelled corner indicator follows the camera and its endpoints choose a view. Toolbar buttons have mouse-hover and keyboard-focus tooltips.

Perspective and orthographic (parallel) projection share the same camera direction and target-plane scale when switched. The camera controller owns projection sizing so a window resize or parts-panel toggle does not replace the orthographic scale with pixel dimensions. Resizing may crop a narrower viewport; it must not silently change zoom.

Explode follows the assembly's own tree. The slider first moves each top-level part or subassembly away from the assembly's centre, then the parts within each subassembly away from its centre, down to three levels; anything nested deeper moves with its third-level group. Outward moves each group in the direction it already sits from its parent's centre, further for groups that sit further out or are larger, and keeps neighbours from overlapping. Groups centred on their parent have no outward direction, so they stack instead: along the axis their centres spread along (plates on a turntable), or along the longest side of the one that has to come out when they share a centre (a shaft in a housing). Up / down, Left / right and Front / back stack the same groups along Z, X or Y in the order they sit: groups at the same height move together, the layer at the centre stays, and each layer moves far enough to clear whatever it would meet along that axis. Keep fixed holds the chosen part where it is assembled and moves everything else so it keeps the same separation from it.

Explosion percentage, direction, fixed-part selection and Reassemble move only the parts, retaining the current camera, pan and zoom. Use Fit assembly if separation moves parts off-screen. Hide/show a specific part also retains the camera. Isolate and Show all retain their existing explicit-action behavior of fitting the resulting visible parts.

Section view is a visual cutaway for closed solids. Open Section view from the model toolbar, enable the cut, choose X, Y or Z, slide or enter the plane coordinate on the model's world axes, and flip which half is hidden. The slider and number limits span the actual visible displayed occurrences, including nested transforms, repeated parts, fixed parts and the current explosion preview. Axis changes and Reset use the relevant displayed midpoint. Exploded offsets extend this visual range but are not physical CAD measurements. Expanding the display preserves the plane; reassembly, hiding an outlier or changing the pose clamps it only when it falls outside the remaining visible bounds, without moving the camera. Hiding every part preserves the last plane and disables position changes until a part is shown. Opening a different STEP resets section view off at the new assembled model's midpoint.

Cut surfaces use per-part display-derived caps and outlines so closed solids read as solid while bores, voids and gaps remain open. Caps are not CAD faces, cannot be selected or copied, and block pointer selection through the artificial cut surface. Faces, native CAD edges, highlights, Studio shadows and exploded occurrences use the same world-aligned cut; the cap plane also expands and recenters over the displayed assembly. The `set_section` canvas action accepts optional `enabled`, `axis`, `position` and `flipped` fields with the normal `expectedRevision` contract, validating position against the committed visible displayed pose. False `flipped` keeps coordinates at or below the plane and true keeps coordinates at or above it.

The converter records whether each preview part is composed entirely of native closed solids. Section view is rejected for surface/open-shell parts rather than drawing a misleading cap. This metadata is part of the converted model's topology identity. Caches created before it existed remain immutable and restore with their original references, but Section view stays unavailable, and a remembered enabled cut is turned off, until the STEP is reopened. Reopening creates a new topology revision with the metadata; references copied from the older revision still resolve against its retained cache.

Inspect uses a grid and readable outlines. Studio uses local reflection and area lighting, soft-edged shadow lighting and a floor. Plastic, satin metal, polished metal and rubber are visual finishes over the original colors, not measured materials or changes to STEP. Outlines can be switched independently; changing modes starts with them on for Inspect and off for Studio. No remote environment images or conversion services are used.

## Assembly steps

A STEP can carry an assembly sequence in a sibling `<name>.assembly.json` file, such as `outputs/stop.assembly.json` beside `outputs/stop.step`. Explorer reads it whenever it opens or reloads that STEP; uploaded snapshots have none. The demo includes a two-step sequence.

Each step has a title, an optional note, part labels and a `from` offset in model millimeters: where those parts wait before the step brings them to their placement in the STEP. Labels match part or group names with `*` and `?` wildcards; every other character, including brackets, is literal. A group stands for all of its parts. Naming a part again in a later step carries it along with that step. Labels that match nothing, and a sequence written for different STEP bytes, are reported in the step panel and `state` rather than guessed.

Open the steps with the bottom bar's Assembly steps button. Step 0 shows every sequenced part waiting at its offset; the last step is fully assembled. Exploded keeps waiting parts visible with dashed paths to where they go, and Build up hides them until their step. Play, the step buttons and the slider animate between steps without moving the camera; render reports and captures wait until a step has finished moving. Agents use `do set_step step=2`, `do set_step mode=buildup` and `do set_step off=true` (`step=null` also works from the command line). Automatic explosion and the sequence are alternatives: a nonzero explosion or Reassemble turns the sequence off. Give later steps on the same axis larger offsets so waiting parts do not appear to pass through each other.

Write the sequence from the design's Python source when it has one. Add `gen_assembly()` beside `gen_step()`, returning `{"steps": [...]}` whose steps have `title`, `parts`, `from` and an optional `note`. After generating the STEP, run this from the design root with the workbench's Python interpreter:

```text
python "$Workbench/explorer/python/assembly.py" source/stop.py --step outputs/stop.step --check
```

`--check` moves each step's parts in a straight line from their placement towards their offset and measures exact B-rep overlap with the parts already placed, every 0.5 mm by default, wherever their bounding boxes can meet along that path. A failed B-rep intersection reports an error, never a clear step. Parts no step names count as already placed. Each step reports clear, blocked (the first blocking part and distance) or interferes (overlapping when installed). A step's `check_shapes` can stand in for one of its parts during the check only, such as a squeezed illustration of a snap part. The check is rigid and sampled: it does not model flexing, threads, gravity, tool access or friction, and features thinner than the spacing can be stepped over. Treat a clear result as a geometric screen, separate from visual review and physical assembly. The sequence never changes the STEP or print files.

## Face, edge and part references

Use the Faces, Edges or Parts toolbar buttons to choose what to select. Faces previews and selects a whole CAD face; Edges previews and selects a whole straight or curved CAD edge; Parts selects an occurrence. The parts list also selects an occurrence. Edge picking uses a six-CSS-pixel radius at any zoom, ignores edges behind opaque geometry and follows each part's exploded placement. Edge mode shows the selectable outlines even when Studio's Outlines setting is off. Selected edges have a stronger highlight, with their curve type and exact CAD length in millimeters in the selection panel. These are STEP topology edges, including seams, not triangle boundaries or view-dependent silhouettes.

Section clipping does not mint topology. A retained face or edge keeps its exact original `cadproto:v2` identity, partially cut native edge polylines are trimmed before screen-space hit testing, and entities wholly outside the retained half are not pickable. Moving a section plane clears a selected entity only when the displayed pose leaves none of it on the retained side.

Auto-copy copies the selected reference inside the user's click gesture; Copy reference also works explicitly. In the Copilot canvas, paste into the desktop's rich composer to create a native file-reference chip. The design-project viewer instead copies readable text for any chat: a summary line such as `CAD Explorer | part.step | Lid | Face f6 (plane, 260.00 mm^2)` followed by the exact `cadproto:v2` address. Moving over geometry never changes selection or the clipboard; clicking and copying never insert a draft attachment automatically and never send a message.

Changing the auto-copy preference through a canvas action acknowledges the saved preference without waiting for a render, including while a drawing review pauses the live scene. It still checks a supplied view revision and does not copy anything by itself.

The chip points to a real JSON descriptor containing a `cadproto:v2:` address: exact topology revision, occurrence and face (`fN`), edge (`eN`) or whole part (`part`). A middle dot separates the part and selected entity in the label so native file-chip basename formatting does not drop the part name. Explosion and appearance do not change this address. Raw/plain-text composer modes may intentionally show the markup.

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

Saved models, source snapshots, references, view setups, drawing reviews and captures live in `explorer/.runtime/`. Pasted file-reference chips contain absolute descriptor paths; copy them again after relocating the data. Each design-project setup also keeps its address in `views/*.endpoint.json` and its background log in `views/*.log`. Both contain the viewer's access URL, so on macOS and Linux they are readable only by the current user, and relocation copies the address records unchanged. The address stays the same across restarts; to issue a new one, stop the viewer and delete its `.endpoint.json` file.

Keep `.github/extensions/cad-explorer/` limited to the entry point. The Copilot app's repository-trust check counts every file under `.github/extensions/`, including Git-ignored data, against its size, entry-count and depth limits, and refuses to accept the extension when they are exceeded.

The runtime directory is local and Git-ignored. It is not a backup of a design project. Preserve useful references, snapshots, drawings and images before deliberately deleting runtime data or moving the checkout to another absolute path.

To relocate a runtime directory within this checkout, stop its Explorer processes and run `node explorer/scripts/relocate-runtime.mjs <source-.runtime-directory>` from the workbench root, then reload the extension. The destination must not exist; the command verifies the copy before removing the source and updates saved snapshot paths. It does not create old-path redirects or rewrite previously pasted chips.

## Validation

The repository-wide entry point is `node tools/check.mjs`, also available as the VS Code **CAD-Pilot: Check all** task. It covers both the workbench and maintained Explorer. **Test Python** and **Test Explorer core** provide narrower editor tasks without launching Chromium. Python discovery includes `explorer/tests/test_converter.py` and the cad skill's common/export suite; see the root README for dependency/API compatibility and fresh-resolution guidance.

Use these commands from the workbench root for narrower checks:

| Scope | Command | Coverage |
| --- | --- | --- |
| Complete Explorer | `npm --prefix explorer test` | Core checks, then a fresh build and the browser suite |
| Non-browser | `npm --prefix explorer run test:core` | Geometry helpers, section planes, commands, HTTP, references, persistence, cache compatibility and ownership |
| Browser | `npm --prefix explorer run test:browser` | Build/type-check, real selection/clipboard, camera matrices, Studio, section caps, drawing recovery, diagnostics and delayed render reports |
| Build only | `npm --prefix explorer run build` | TypeScript and production assets |
| Native converter | `uv run pytest explorer/tests/test_converter.py -q` | STEP topology, placements, face/edge retention, cleanup and resource/error boundaries |

Core checks do not launch a browser; some require the workbench's Python environment for native fixtures. Browser checks also require Playwright Chromium from the root setup. They run serially against isolated synthetic views, never a user's open model. The camera resize/DPR scenario is included, not an opt-in environment flag. Context-loss scenarios deliberately damage only their disposable renderer.

For a targeted run, build first if it uses the browser, then pass individual files to Node. For example:

```text
node --test explorer/tests/commands.test.mjs explorer/tests/protocol.test.mjs explorer/tests/copilot-host.test.mjs
node --test --test-concurrency=1 explorer/tests/render-reports.test.mjs explorer/tests/render-reports-browser.test.mjs
```

Name browser suites `*-browser.test.mjs` so the runner discovers them in the correct group. Shared Node fixtures own service startup/shutdown and a disposable runtime root for models, inputs, references, captures, reviews and view leases; test services and inspection use the same root. These stores are removed on success or failure, never merged with the user's durable runtime. `browser_session.py` owns state polling and settled-command checks. Scenario-specific pointer actions, assertions and delayed-response injection stay in the individual scripts. Browser evidence may be retained under `explorer/.local/`, separately from disposable runtime data.

Preserve these contracts when changing their owners:

| Contract | Regression files in `tests/` |
| --- | --- |
| Exact face/edge identity, pixel-space picking, occlusion and clipboard behavior | `references.test.mjs`, `edge-picking.test.ts`, `edge-browser.test.mjs`, `viewer-browser.test.mjs` |
| Fresh measured cleanup versus unknown historical counts; immutable caches and failed-import recovery | `model-import.test.mjs`, `diagnostics.test.mjs`, `cache-migration.test.mjs`, `cleanup-persistence-browser.test.mjs`, `test_converter.py` |
| Warning/info panels do not obscure controls or alter camera and drawings | `import-warnings-browser.test.mjs` |
| Actual camera scale/pose across resize, projection, explosion and capture | `camera.test.ts`, `camera-browser.test.mjs`, `viewer-browser.test.mjs` |
| Section planes in model-world coordinates across nested, repeated, fixed, hidden and exploded occurrences; caps that keep holes and gaps open; trimmed edge picking with unchanged references; persisted, captured and reviewed section poses; closed-solid identity for immutable caches | `section.test.ts`, `protocol.test.mjs`, `section-browser.test.mjs`, `cache-migration.test.mjs`, `test_converter.py` |
| Review conflicts preserve unsaved local marks and other writers' data | `reviews.test.mjs`, `review-recovery-browser.test.mjs` |
| Stale render reports neither write state nor release current waiters; genuine current errors remain visible | `render-reports.test.mjs`, `render-reports-browser.test.mjs` |
| View ownership, file-cache invalidation and runtime relocation | `view-registry.test.mjs`, `inspection-cache.test.mjs`, `runtime-relocation.test.mjs` |
| Test storage/inspection isolation and preference-only action acknowledgement | `runtime-isolation.test.mjs`, `copilot-host.test.mjs` |
| Automatic explode: subassemblies separate before their parts, same-height layers on an axis, concentric telescoping, sibling clearance, the fixed part, a drift-free return to assembled | `explode.test.mjs`, `model.test.ts`, `section.test.ts` |
| Assembly sequences: label and group resolution, carried parts, build-up hiding, step validation, explosion exclusivity; exporter ordering, direction, late-path, installed-overlap and stand-in checks; renders and captures wait for a step to settle, section range, cancelled drags | `assembly.test.mjs`, `test_assembly.py`, `assembly-browser.test.mjs` |
| Design-project viewer: one background viewer per setup, in-place reload, stable address across restarts, view actions, captures, references and gated shutdown | `launcher.test.mjs` |

The service reports the actual rendered camera and topology revision, not just requested parameters. Browser clipboard behavior, native host chip presentation and delivery to the next user message remain separate acceptance checks. Synthetic scenarios do not certify large-assembly responsiveness, physical fit or manufacturing suitability.

## Maintenance boundaries

`shared/commands.mjs` owns canvas action schemas and revision/render/review policies. The Copilot host adapter projects those definitions into SDK actions, and `scripts/explorer.mjs` offers the same canvas actions through `do`. `server/assembly.mjs` owns reading and resolving a STEP's sequence file, and `python/assembly.py` owns writing and checking it from a design source. `server/launcher.mjs` owns finding, starting, reusing and stopping a design project's viewer; `server/endpoint.mjs` owns its private address record. Only hosts that pass `onShutdown` expose the shutdown route; server handlers still validate model identity, geometry, cameras and stored data in context. HTTP inputs and canvas schemas are deliberately not interchangeable. Reads and snapshot loads retain their existing revision semantics; explicit draft attachment and camera persistence require a current revision.

`server/model-import.mjs` stages each import privately, validates it, then atomically publishes complete immutable source/cache files with same-filesystem hard links. Existing files, including a concurrent import's winner, are verified rather than overwritten. Conversion/validation failures remove only private staging data. Once published, shared artifacts are retained even if later cleanup or view-metadata persistence fails: another view may already depend on them. The local runtime filesystem must support hard links; unsupported publication fails explicitly. `server.mjs` publishes the live model only after saving its view metadata. If cleanup also fails, the original import error/code/status remains primary and the cleanup diagnostic remains visible.

Frontend lifetimes are feature-specific: `useSelection` handles selection/clipboard feedback, `useViewCapture` coordinates captured-review transitions, `useSectionControl` owns the uncommitted section-plane draft and its displayed range, `useStepPlayer` owns the animating assembly-step position, and `useRenderReports` scopes queued sends and failures to the active model/view. Its revision bookkeeping is private; `Rig` uses named invalidation and capture-readiness operations instead of mutating report refs. Camera ownership stays in `Rig`/`CameraController`; drawing-save recovery stays in `useReviews`. Do not combine their cancellation counters or remove the model/view/unmount guards merely to share code.

Services default to the durable runtime described above. Internal callers can supply a `runtimeRoot`; all service-owned storage, leases and reference inspection are scoped together. Launcher tests isolate real background viewers the same way through `CAD_EXPLORER_RUNTIME_ROOT`. This is a test/service boundary, not a new canvas input or a change to existing saved paths.

## Provenance

The Explorer is first-party apart from the code recorded here. Keep each entry's notice with it.

### Automatic explode layout

- Source repository: https://github.com/earthtojake/text-to-cad
- Source path: `packages/core/src/lib/viewer/explodedView.js`; its `explodedView.test.js` was read for behaviour.
- Source revision: `2f793659fb7bab537e2f00836e06448fc4087cb2`
- Imported: 2026-10-22.
- License: MIT, Copyright (c) 2026 Thompson Labs LLC; the notice is reproduced below.
- Scope: the hierarchical layout adapted into `shared/placement.mjs`: the level-by-level walk with wrapper collapse, radial offsets from spread, clearance and level falloff, the centred-child threshold, sibling separation, and overlapping level windows with smoothstep. Two scenarios in `tests/explode.test.mjs` (a shaft in a housing, siblings with nearby centres) follow upstream test cases.
- Local changes: rewritten over the Explorer's node tree and world matrices instead of occurrence-path records, without three.js; measured once per model and direction; levels that move nothing take no share of the slider; the fixed part is held by subtracting its offset from every part. Children centred on their parent are stacked with the X/Y/Z stacking along the axis their centres spread along, falling back to upstream's longest side only when they share a centre: upstream's per-child longest side laid flat coaxial plates out side by side. The X/Y/Z axis stacking is original CAD-Pilot code. Upstream's ease-out, bounds and scene helpers are not used.

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

CAD Explorer loads snapshots; it does not watch source files, simulate disassembly, slice models or control printers. Automatic explode separates bounding boxes, not shapes: it is not a disassembly path, and interlocking parts can still look interleaved. Assembly steps are straight-line display offsets, and the optional sequence check is a rigid geometric screen run by the exporter, not a physical simulation. Section caps are a tessellated display aid, not precise geometric measurements, new B-rep faces, a cut STEP, a minimum-wall check or exported print geometry. Large-assembly performance is not certified. Native conversion runs trusted local code, not a sandbox, with a 100 MB STEP cap and a two-minute timeout.

See the repository's [ownership and provenance guidance](../README.md#provenance).
