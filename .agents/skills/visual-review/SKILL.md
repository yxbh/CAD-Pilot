---
name: visual-review
description: 'Choose and open a STEP viewer and co-design CAD with a non-CAD user. Use for viewing models, CAD Explorer, unclear shape preferences, pointing at an edge or surface, annotated screenshots, geometry references, before/after comparisons, or difficulty describing a design change.'
---

# Visual Co-Design

## Choose the Viewer

Prefer the maintained CAD Explorer whenever it can run, even when the imported cad skill describes starting its browser viewer. Keep using that skill for build123d generation and the appropriate geometric inspection; choosing our viewer does not replace the modeling skill.

In the Copilot desktop, use the `cad-explorer` canvas: check the available canvas types, inspect its capabilities, and pass the selected design directory as `projectRoot` and its actual STEP as `file`. Reuse an existing panel for the same setup.

In other hosts that can show a local web page, such as Claude Code, run `node <workbench>/explorer/scripts/explorer.mjs open <project-relative STEP>` from the design project's root. Show the returned URL to the user; in the Claude desktop app, open it in the built-in browser pane and keep reusing that tab. After regenerating, run the same `open` again: it reloads the running viewer and keeps its URL and camera. Do not start, kill or restart viewers yourself, and do not hand out a new link while the old one works; the viewer outlives the chat session, and `stop` is only for when the user is finished. Drive the view with `do <action> key=value ...`, for example `do set_view preset=top` (list actions with `actions`), and use `capture <project-relative .png>` while the page is open when you need an image.

Do not omit the file and accidentally show the demo, move the model into the workbench, or regenerate geometry merely to view an existing STEP. Build the Explorer (and reload the Copilot extension) when needed using the [Explorer instructions](../../../explorer/README.md); a failed build, start or connection is an explicit error, not a reason to silently show another viewer.

Use the imported browser viewer and CLI workflow described by the cad skill only when the user asks for it or the maintained Explorer cannot run. Access to an external workbench path does not register its Copilot project extension. Do not imply a separate VS Code extension exists or that Copilot's native reference chips work in another chat host.

## Co-Design Workflow

1. Open the actual project's model using the viewer choice above, not an unrelated prior artifact. Report the model path and revision. Preserve the camera across comparisons whenever possible.
2. Use plain words: opening, rim, rounded edge, wall, attachment point. The user does not need to learn CAD terminology to express a preference.
3. Accept a native CAD reference chip/JSON descriptor, a `cadproto:v2` or imported `@cad[...]` reference, a circled screenshot, a sketch, a reference photo, or prose. A screen location is not a world coordinate, and a photo does not establish real-world dimensions without a scale reference.
4. Before an ambiguous edit, show the selected region or a labeled screenshot and ask whether it is the intended target. If the user is unsure about the shape, offer two rough alternatives instead of demanding a technical name.
5. For feedback worth keeping across sessions, save the relevant screenshot/reference, model revision, intended change, and what must stay fixed in the project's existing notes. Include the camera/view when needed to interpret a mark. Do not require a separate review form or log every interaction. Preserve existing layouts; do not invent selections or claim you saw an uninspected view.
6. Edit the smallest responsible source feature. Regenerate, inspect geometry, and show before/after views. Re-resolve geometry references after regeneration; face/edge numbers and even semantic selectors can change or become ambiguous.
7. Ask for approval of the overall shape before finishing cosmetic details. Keep aesthetic approval separate from dimensional, print, and safety checks.

## References and Tool Boundaries

Maintained-viewer references use `cadproto:v2` topology/occurrence/face, edge or whole-part identities. Use Faces, Edges or Parts in the toolbar; edge references identify actual STEP edges, not tessellation outlines. Resolve a pasted reference with `cad_explorer_inspect` or the canvas's `inspect_reference` action in Copilot, or with `explorer.mjs inspect '<pasted text>'` elsewhere. Outside Copilot, a copied reference is a readable summary line followed by its `cadproto:v2` address. Do not feed these IDs into the imported inspector. Imported `@cad[...]` references belong to that viewer's CLI inspection workflow and must be resolved there.

The maintained Explorer exposes explicit state, selection, view, explosion, section and capture actions: canvas actions in Copilot, and `explorer.mjs` commands elsewhere. Read their returned state before claiming to know what is selected or visible. User clicks can copy references to the clipboard, but do not insert or send chat messages. The imported browser viewer does not gain these canvas actions merely because both viewers are called CAD Explorer.

Use the maintained Explorer's section view when a bridge, cover or surrounding body hides a feature the user wants to inspect. A cutting plane changes the display only; it does not cut the source STEP. Preserve the view direction and record the axis, plane position, visible side and any exploded placement with feedback. Artificial cut surfaces are not selectable native CAD faces or edges. A visible gap is useful context, but dimensional clearance still requires geometry measurement and printed fit still requires physical evidence.

Drawings are bound to their captured image and model revision. Use a returned capture or an image shared by the user, and verify the marks are present before interpreting them. Do not mistake a live model capture for an annotated saved review. Keep useful review images and decisions in the selected project's existing review location; runtime captures are not automatically project deliverables.