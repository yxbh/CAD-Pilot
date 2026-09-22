# CAD Explorer

Maintained first-party STEP viewer for the project-scoped GitHub Copilot desktop canvas. The application lives here; `.github\extensions\cad-explorer\extension.mjs` is only the Copilot entry point. The imported CAD skill remains independent and unchanged. Python source owns a design's intent; STEP and preview meshes do not carry its parametric history.

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

`package.json` is version-controlled; `package-lock.json` is local and Git-ignored because npm records resolved registry URLs in it. Use normal `npm install` with the machine's configured feed, without forcing a public registry or bypassing required feeds. The local lock can be reused on that machine, but versions permitted by the manifest can differ across machines. Imported dependency locks elsewhere in the workbench remain version-controlled; the provenance registry records their separate metadata-only patches.

The canvas accepts an explicit authorized `projectRoot`, a STEP `file` inside it, and an optional `viewId` for its remembered setup. Without a file it restores that setup, or creates the synthetic demo when none exists. The default project is the workbench checkout. Use Open STEP to import another local snapshot; the source file is not modified and its Python generator is never executed.

A remembered setup includes the active model, camera, hidden/exploded parts and drawing reviews. Reopen its existing panel rather than creating a linked duplicate. Explorer keeps one live panel per setup; independent `viewId` values allow side-by-side setups. Equivalent Windows path spellings resolve to the same owner. An exclusive OS lease also prevents another Explorer process from writing that setup simultaneously; on Windows, ownership is released if the process terminates.

For a standalone browser, capture the workbench path before switching to the intended design directory:

```powershell
$Workbench = $PWD.Path
Push-Location ..\my-design
node "$Workbench\explorer\server\standalone.mjs"
Pop-Location
```

The process prints a loopback URL and stays attached to the launching terminal. It does not submit Copilot messages. `CAD_EXPLORER_VIEW` selects a different remembered setup.

## Model, views and appearance

The viewer loads ordinary STEP/STP parts and assemblies through the workbench's local OCP converter. It preserves repeated occurrences, placements, names and supported part colors. Different surfaces within one part, transparency and source visibility flags are not fully represented; detected limitations appear as import warnings. Missing colors use blue-grey. The demo deliberately has a blue base, green cover and gold spacers.

When the live model has import warnings, a warning button with a count appears in the document header. Normal display cleanup of verified kernel point edges and exactly zero-area triangles is instead summarized as low-priority information, with counts for reusable part geometry rather than repeated placements. Cleanup alone shows a neutral information button; mixed imports keep the real warning count and show cleanup separately in the same panel. No CAD faces are removed by this cleanup. Tessellation tolerances, triangle filtering and selectable nondegenerate edges are unchanged; unflagged zero-length edges remain warnings, and invalid or missing geometry remains an error.

Open the header button to read the scrollable details; close them with the X button, Escape or the header button. Details stay above the bottom controls, so they never cover the explosion slider. Opening them dismisses a transient success notice, not an error. Closing the details does not erase diagnostics: reopen them from the same button. Details start closed for each newly loaded model and are not shown over captured drawing reviews.

Orbit, pan, zoom, fit and six exact axis views are available. Right is +X, left -X, back +Y, front -Y, top +Z and bottom -Z. Z is the source model's up direction, not a manufacturing instruction. The labelled corner indicator follows the camera and its endpoints choose a view. Toolbar buttons have mouse-hover and keyboard-focus tooltips.

Perspective and orthographic (parallel) projection share the same camera direction and target-plane scale when switched. The camera controller owns projection sizing so a window resize or parts-panel toggle does not replace the orthographic scale with pixel dimensions. Resizing may crop a narrower viewport; it must not silently change zoom.

Explosion percentage, direction, fixed-part selection and Reassemble move only the parts, retaining the current camera, pan and zoom. Use Fit assembly if separation moves parts off-screen. Hide/show a specific part also retains the camera. Isolate and Show all retain their existing explicit-action behavior of fitting the resulting visible parts.

Inspect uses a grid and readable outlines. Studio uses local reflection and area lighting, soft-edged shadow lighting and a floor. Plastic, satin metal, polished metal and rubber are visual finishes over the original colors, not measured materials or changes to STEP. Outlines can be switched independently; changing modes starts with them on for Inspect and off for Studio. No remote environment images or conversion services are used.

## Face, edge and part references

Use the Faces, Edges or Parts toolbar buttons to choose what to select. Faces previews and selects a whole CAD face; Edges previews and selects a whole straight or curved CAD edge; Parts selects an occurrence. The parts list also selects an occurrence. Edge picking uses a six-CSS-pixel radius at any zoom, ignores edges behind opaque geometry and follows each part's exploded placement. Edge mode shows the selectable outlines even when Studio's Outlines setting is off. Selected edges have a stronger highlight, with their curve type and exact CAD length in millimeters in the selection panel. These are STEP topology edges, including seams, not triangle boundaries or view-dependent silhouettes.

Auto-copy copies the selected reference inside the user's click gesture; Copy reference also works explicitly. Paste into the desktop's rich composer to create a native file-reference chip. Moving over geometry never changes selection or the clipboard; clicking and copying never insert a draft attachment automatically and never send a message.

Changing the auto-copy preference through a canvas action acknowledges the saved preference without waiting for a render, including while a drawing review pauses the live scene. It still checks a supplied view revision and does not copy anything by itself.

The chip points to a real JSON descriptor containing a `cadproto:v2:` address: exact topology revision, occurrence and face (`fN`), edge (`eN`) or whole part (`part`). A middle dot separates the part and selected entity in the label so native file-chip basename formatting does not drop the part name. Explosion and appearance do not change this address. Raw/plain-text composer modes may intentionally show the markup.

`cad_explorer_inspect` resolves these references. These are not the imported skill's `@cad[...]` ordinals. Cached geometry and source snapshots are validated; missing or changed data is reported rather than guessed. Validated data is reused only while its file identity remains unchanged.

Inspection keeps compact validated face/edge/part/placement facts rather than retaining another copy of mesh or edge-polyline arrays. Its default cache is limited to four entries and 64 MiB of accounted fact data; source-digest entries have a separate bound. These are retained-cache accounting limits, not a bound on transient JSON parsing or total process memory. Unchanged warm selections avoid full mesh parsing/validation and source hashing; changed files invalidate the relevant entry, and source hashing is streamed. Synthetic timing checks do not certify real large-assembly performance.

Clipboard access can be denied by the host; a selected-text/manual-copy path remains available. Browser clipboard checks, native chip presentation, and delivery of the descriptor in the next user message are separate acceptance checks. Do not treat one as proof of the others.

## Drawing reviews

Draw captures the model's current appearance, camera, visibility, selection and exploded pose into a fixed image. Pen, line, arrows, rectangle, ellipse, highlight and erase operate on that image, with undo/redo and reversible clear. Highlight is a filled rectangle, not smart surface fill. Drawing does not orbit the model or copy geometry references.

The live WebGL canvas stays mounted but inactive beneath the drawing layer. Switching modes does not move the viewport or recreate shared geometry. Genuine graphics-context loss is still reported. Captured images retain their aspect ratio when resized; strokes use image-relative coordinates.

Drawing saves are versioned. Recovery must preserve unsaved local marks and other writers' work rather than blindly overwriting a conflicting version. Keep local recovery and exported images distinct from a confirmed server save. Review summaries do not require loading every saved image after each stroke.

A failed or uncertain save can be reconciled with the saved version. Conflicting local marks can be kept as a separate review without replacing the other version; loading the server's version or discarding local changes is explicit. Copy/download the marked image if the service is unavailable. Do not reload or close a tab with unsaved marks before saving, exporting or explicitly discarding them. When opening a review, live rendering pauses before the load starts so cold Studio rendering cannot delay the transition.

Copy marked image and Save marked image include annotations. The saved metadata records the original source revision, pose and visual appearance. A review remains tied to its captured snapshot even after a different STEP is opened. The current limits are 20 reviews per setup, bounded image sizes and bounded stroke/history counts.

## Local data

Saved models, source snapshots, references, view setups, drawing reviews and captures live in `.github/extensions/cad-explorer/.runtime/`. Pasted file-reference chips contain absolute descriptor paths; copy them again after relocating the data.

The runtime directory is local and Git-ignored. It is not a backup of a design project. Preserve useful references, snapshots, drawings and images before deliberately deleting runtime data or moving the checkout to another absolute path.

To relocate a runtime directory within this checkout, stop its Explorer processes and run `node explorer/scripts/relocate-runtime.mjs <source-.runtime-directory>` from the workbench root, then reload the extension. The destination must not exist; the command verifies the copy before removing the source and updates saved snapshot paths. It does not create old-path redirects or rewrite previously pasted chips.

## Validation

The repository-wide entry point is `node tools/check.mjs`, also available as the VS Code **CAD-Pilot: Check all** task. It covers both the workbench and maintained Explorer, not the imported viewer's independent npm package. **Test Python** and **Test Explorer core** provide narrower editor tasks without launching Chromium. Python discovery includes `explorer/tests/test_converter.py`.

Use these commands from the workbench root for narrower checks:

| Scope | Command | Coverage |
| --- | --- | --- |
| Complete Explorer | `npm --prefix explorer test` | Core checks, then a fresh build and the browser suite |
| Non-browser | `npm --prefix explorer run test:core` | Geometry helpers, commands, HTTP, references, persistence, cache compatibility and ownership |
| Browser | `npm --prefix explorer run test:browser` | Build/type-check, real selection/clipboard, camera matrices, Studio, drawing recovery, diagnostics and delayed render reports |
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
| Review conflicts preserve unsaved local marks and other writers' data | `reviews.test.mjs`, `review-recovery-browser.test.mjs` |
| Stale render reports neither write state nor release current waiters; genuine current errors remain visible | `render-reports.test.mjs`, `render-reports-browser.test.mjs` |
| View ownership, file-cache invalidation and runtime relocation | `view-registry.test.mjs`, `inspection-cache.test.mjs`, `runtime-relocation.test.mjs` |
| Test storage/inspection isolation and preference-only action acknowledgement | `runtime-isolation.test.mjs`, `copilot-host.test.mjs` |

The service reports the actual rendered camera and topology revision, not just requested parameters. Browser clipboard behavior, native host chip presentation and delivery to the next user message remain separate acceptance checks. Synthetic scenarios do not certify large-assembly responsiveness, physical fit or manufacturing suitability.

## Maintenance boundaries

`shared/commands.mjs` owns canvas action schemas and revision/render/review policies. The host adapter projects those definitions into SDK actions; server handlers still validate model identity, geometry, cameras and stored data in context. HTTP inputs and canvas schemas are deliberately not interchangeable. Reads and snapshot loads retain their existing revision semantics; explicit draft attachment and camera persistence require a current revision.

`server/model-import.mjs` stages each import privately, validates it, then atomically publishes complete immutable source/cache files with same-filesystem hard links. Existing files, including a concurrent import's winner, are verified rather than overwritten. Conversion/validation failures remove only private staging data. Once published, shared artifacts are retained even if later cleanup or view-metadata persistence fails: another view may already depend on them. The local runtime filesystem must support hard links; unsupported publication fails explicitly. `server.mjs` publishes the live model only after saving its view metadata. If cleanup also fails, the original import error/code/status remains primary and the cleanup diagnostic remains visible.

Frontend lifetimes are feature-specific: `useSelection` handles selection/clipboard feedback, `useViewCapture` coordinates captured-review transitions, and `useRenderReports` scopes queued sends and failures to the active model/view. Its revision bookkeeping is private; `Rig` uses named invalidation and capture-readiness operations instead of mutating report refs. Camera ownership stays in `Rig`/`CameraController`; drawing-save recovery stays in `useReviews`. Do not combine their cancellation counters or remove the model/view/unmount guards merely to share code.

Services default to the durable runtime described above. Internal callers can supply a `runtimeRoot`; all service-owned storage, leases and reference inspection are scoped together. This is a test/service boundary, not a new canvas input or a change to existing saved paths.

## Limits

CAD Explorer loads snapshots; it does not watch source files, simulate disassembly, slice models or control printers. Large-assembly performance is not certified. Native conversion runs trusted local code, not a sandbox, with a 100 MB STEP cap and a two-minute timeout.

See the repository's [ownership and provenance guidance](../README.md#provenance).
