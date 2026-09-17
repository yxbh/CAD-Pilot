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

A remembered setup includes the active model, camera, hidden/exploded parts and drawing reviews. Reopen its existing panel rather than creating a linked duplicate. V1 keeps one live panel per setup; independent `viewId` values allow side-by-side setups. Equivalent Windows path spellings resolve to the same owner. An exclusive OS lease also prevents another Explorer process from writing that setup simultaneously; on Windows, ownership is released if the process terminates.

For a standalone browser, capture the workbench path before switching to the intended design directory:

```powershell
$Workbench = $PWD.Path
Push-Location ..\my-design
node "$Workbench\explorer\server\standalone.mjs"
Pop-Location
```

The process prints a loopback URL and stays attached to the launching terminal. It does not submit Copilot messages. `CAD_EXPLORER_VIEW` can select a different remembered setup; the previous `CAD_PROTOTYPE_VIEW` variable remains a compatibility fallback.

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

The chip points to a real JSON descriptor containing a `cadproto:v2:` address: exact topology revision, occurrence and face (`fN`), edge (`eN`) or whole part (`part`). A middle dot separates the part and selected entity in the label so native file-chip basename formatting does not drop the part name. Explosion and appearance do not change this address. Raw/plain-text composer modes may intentionally show the markup.

`cad_explorer_inspect` resolves these references. `cad_explorer_prototype_inspect` remains a supported alias for existing descriptors and conversations. These are not the imported skill's `@cad[...]` ordinals. Cached geometry and source snapshots are validated; missing or changed data is reported rather than guessed. Validated data is reused only while its file identity remains unchanged.

Inspection keeps compact validated face/edge/part/placement facts rather than retaining another copy of mesh or edge-polyline arrays. Its default cache is limited to four entries and 64 MiB of accounted fact data; source-digest entries have a separate bound. These are retained-cache accounting limits, not a bound on transient JSON parsing or total process memory. Unchanged warm selections avoid full mesh parsing/validation and source hashing; changed files invalidate the relevant entry, and source hashing is streamed. Synthetic timing checks do not certify real large-assembly performance.

Clipboard access can be denied by the host; a selected-text/manual-copy path remains available. Browser clipboard checks, native chip presentation, and delivery of the descriptor in the next user message are separate acceptance checks. Do not treat one as proof of the others.

## Drawing reviews

Draw captures the model's current appearance, camera, visibility, selection and exploded pose into a fixed image. Pen, line, arrows, rectangle, ellipse, highlight and erase operate on that image, with undo/redo and reversible clear. Highlight is a filled rectangle, not smart surface fill. Drawing does not orbit the model or copy geometry references.

The live WebGL canvas stays mounted but inactive beneath the drawing layer. Switching modes does not move the viewport or recreate shared geometry. Genuine graphics-context loss is still reported. Captured images retain their aspect ratio when resized; strokes use image-relative coordinates.

Drawing saves are versioned. Recovery must preserve unsaved local marks and other writers' work rather than blindly overwriting a conflicting version. Keep local recovery and exported images distinct from a confirmed server save. Review summaries do not require loading every saved image after each stroke.

A failed or uncertain save can be reconciled with the saved version. Conflicting local marks can be kept as a separate review without replacing the other version; loading the server's version or discarding local changes is explicit. Copy/download the marked image if the service is unavailable. Do not reload or close a tab with unsaved marks before saving, exporting or explicitly discarding them. When opening a review, live rendering pauses before the load starts so cold Studio rendering cannot delay the transition.

Copy marked image and Save marked image include annotations. The saved metadata records the original source revision, pose and visual appearance. A review remains tied to its captured snapshot even after a different STEP is opened. The current limits are 20 reviews per setup, bounded image sizes and bounded stroke/history counts.

## Retained data and prototype migration

Maintained code lives in `explorer\`; retained data deliberately stays under `.github\extensions\cad-explorer-prototype\.runtime`. Existing pasted chips contain absolute descriptor paths there. Moving or deleting those files would break references already present in conversations.

Keep `models`, `inputs`, `references`, `views`, `reviews` and captures at that retained location. Do not remove the old-named directory merely because the running extension is now `cad-explorer`. Existing v1 geometry caches, perspective-only camera records and saved reviews retain their compatibility paths. Live models converted before edge support are reconverted from their source snapshot into a new topology revision; old cached face/part references remain resolvable against their original revision. Source-file cleanup is separate from data deletion.

The runtime directory is local and Git-ignored. It is not a backup of a design project. Preserve useful references, snapshots, drawings and images before deliberately deleting runtime data or moving the checkout to another absolute path.

## Validation

From the workbench root:

```text
npm --prefix explorer test
npm --prefix explorer run build
uv run pytest explorer/tests/test_converter.py -q
```

Browser checks run against an isolated standalone/test view using the workbench's Python interpreter. `browser_smoke.py` checks the actual reference clipboard and picking workflow; `v2_browser.py` checks drawing/image parity and recovery; `studio_views.py` checks projection, appearance and capture; `draw_transition.py` measures fixed-layout transitions and genuine context-loss reporting; `explode_camera.py` exercises camera-preserving explosion from an orbited, panned and zoomed view. Run context-loss tests only on disposable test views.

`npm test` includes the review-recovery browser checks and requires the workbench's Playwright Chromium setup. The extended live camera check is opt-in: from `explorer`, set `$env:EXPLORER_BROWSER_TESTS='1'` and run `node --test tests\camera-browser.test.mjs`. It checks R3F camera matrices and scale across panel, viewport and device-pixel-ratio changes, not just toolbar layout.

`node --test tests/import-warnings.test.mjs` checks neutral cleanup information from a native rounded STEP import, mixed real warnings, legacy unknown counts, dismissal/reopening, saved review and edge-reference continuity, invalid-import errors, and pointer/keyboard access to the explosion slider on desktop, narrow and short windows. Synthetic long warnings and legacy-normalized diagnostics are injected only into the isolated browser response, not into retained CAD data. Converter tests compare native face/edge retention and final triangle indices, exercise more than 100 legitimate degenerate edges, and retain strict failure and resource-limit checks. `diagnostics.test.mjs` and `cache-migration.test.mjs` cover bounded counters and immutable legacy-cache compatibility. `cleanup-persistence.test.mjs` checks fresh reimport over a legacy cache, provider/browser restart, failed imports, camera saves, view isolation and stale/malformed saved measurement guards.

`node --test tests/edge-picking.test.ts tests/edge-browser.test.mjs` checks screen-space hit tolerance, occlusion, whole-edge highlighting, real pointer picking of straight and curved edges, native-reference copying, repeated and exploded occurrences, mode switching, saved selection, drawing capture and narrow/high-DPI windows. Build first. The browser test uses the isolated synthetic STEP assembly, not a user's design. Converter tests separately check exact topology and CAD edge lengths; display polylines approximate curves and do not replace exact geometry.

The service reports the actual rendered camera and topology revision, not just the last requested parameters. Preserve targeted checks for camera resize, service ownership, inspection cache invalidation and drawing conflicts as these surfaces change. A small synthetic demo is not evidence of large-assembly responsiveness or certification.

## Limits

CAD Explorer loads snapshots; it does not watch source files, simulate disassembly, slice models or control printers. Large-assembly performance is not certified. Native conversion runs trusted local code, not a sandbox, with a 100 MB STEP cap and a two-minute timeout.

See the repository's [ownership and provenance guidance](../README.md#provenance).
