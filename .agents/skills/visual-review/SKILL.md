---
name: visual-review
description: 'Choose and open a STEP viewer and co-design CAD with a non-CAD user. Use for viewing models, CAD Explorer, unclear shape preferences, pointing at an edge or surface, annotated screenshots, geometry references, before/after comparisons, showing how parts go together or come apart (assembly steps), or difficulty describing a design change.'
---

# Visual Co-Design

## Choose the Viewer

Show models in the maintained CAD Explorer. The cad skill owns build123d generation and geometric inspection; this skill owns choosing, opening and driving the viewer.

In the Copilot desktop, use the `cad-explorer` canvas: check the available canvas types, inspect its capabilities, and pass the selected design directory as `projectRoot` and its actual STEP as `file`. Reuse an existing panel for the same setup.

In other hosts that can show a local web page, such as Claude Code, run `node <workbench>/explorer/scripts/explorer.mjs open <project-relative STEP>` from the design project's root. Show the returned URL to the user; in the Claude desktop app, open it in the built-in browser pane and keep reusing that tab. After regenerating, run the same `open` again: it reloads the running viewer, keeps its URL, and, for the same file with the same part names, keeps a camera the user moved, the cutaway, explosion, step and hidden parts. Do not start, kill or restart viewers yourself, and do not hand out a new link while the old one works; the viewer outlives the chat session, and `stop` is only for when the user is finished. Drive the view with `do <action> key=value ...`, for example `do set_view preset=top` (list actions with `actions`), and use `capture <project-relative .png>` when you need an image; captures are drawn in the background, so the user's page need not be open or in front.

`open`, `state` and `do` answer with a short summary (add `--full` for parts and references); in Copilot, `get_state` takes `detail=full`. The summary's model revision and generated time match the `rev` shown in the viewer's header: tell the user which revision to expect. Its `shown` block says whether the user's page has drawn the current revision; if `note` says no page is open, or that the open page has not drawn it (a hidden or background tab), say so instead of assuming they see it. `changedOnDisk` means the STEP was regenerated after it was loaded: run `open` again.

Do not omit the file and accidentally show the demo, move the model into the workbench, or regenerate geometry merely to view an existing STEP. Build the Explorer (and reload the Copilot extension) when needed using the [Explorer instructions](../../../explorer/README.md); a failed build, start or connection is an explicit error, not a reason to silently show another viewer.

The maintained Explorer is the only viewer. If it cannot build, start or connect, say so and rely on the cad skill's CLI inspection for geometry. Access to an external workbench path does not register its Copilot project extension. Do not imply a separate VS Code extension exists or that Copilot's native reference chips work in another chat host.

## Co-Design Workflow

1. Open the actual project's model using the viewer choice above, not an unrelated prior artifact. Report the model path and revision. Preserve the camera across comparisons whenever possible.
2. Use plain words: opening, rim, rounded edge, wall, attachment point. The user does not need to learn CAD terminology to express a preference.
3. Accept a native CAD reference chip/JSON descriptor, a `cadproto:v2` reference, an `@cad[...]` reference from the cad skill's `scripts/inspect`, a circled screenshot, a sketch, a reference photo, or prose. A screen location is not a world coordinate, and a photo does not establish real-world dimensions without a scale reference.
4. Before an ambiguous edit, show the selected region or a labeled screenshot and ask whether it is the intended target. If the user is unsure about the shape, offer two rough alternatives instead of demanding a technical name.
5. For feedback worth keeping across sessions, save the relevant screenshot/reference, model revision, intended change, and what must stay fixed in the project's existing notes. Include the camera/view when needed to interpret a mark. Do not require a separate review form or log every interaction. Preserve existing layouts; do not invent selections or claim you saw an uninspected view.
6. Edit the smallest responsible source feature. Regenerate, inspect geometry, and show before/after views. Before asking the user to look, capture the changed model and look at it yourself, as the cad skill's [self-review](../cad/references/rendering-and-explorer.md#self-review) describes. Re-resolve geometry references after regeneration; face/edge numbers and even semantic selectors can change or become ambiguous.
7. Ask for approval of the overall shape before finishing cosmetic details. Keep aesthetic approval separate from dimensional, print, and safety checks.

## Assembly Steps

Use assembly steps when the user wants to see how parts go together or come apart, needs step-by-step images, or asks whether an order works. The STEP needs labelled parts.

1. Agree the order in plain words first, including which part stays put and anything done by hand, such as squeezing a clip or holding a part level. Ask rather than invent an order for a mechanism you have not understood.
2. Write the sequence in the design's Python source: `gen_assembly()` beside `gen_step()`, returning `{"steps": [...]}`. Each step has a `title`, `parts` (labels, with `*`/`?` wildcards; a group label covers its parts), `from` (the millimetre offset the parts arrive from, relative to where they sit when assembled) and an optional `note`. Parts no step names stay in place. Naming a part again in a later step carries it along. Derive offsets from named parameters where they matter, and give later steps on the same axis larger offsets so waiting parts do not appear to pass through each other. In an existing project, ask before adding the function to its source.
3. After generating the STEP, run the workbench's `explorer/python/assembly.py <source.py> --step <project-relative STEP> --check` with the workbench's Python interpreter from the design root. It writes `<name>.assembly.json` beside the STEP and never changes the STEP. Then run `open` again (or load the file again in the canvas) so the viewer reads it.
4. Report the check per step: clear, blocked (the first blocking part and distance) or interferes (overlapping when installed). It is a rigid straight-line sweep sampled every 0.5 mm and does not model flexing, threads, gravity, tool access or friction, so a flexing snap part is expected to block. Supply `check_shapes` only with a deflected or squeezed illustration the source already models, and say that the check used it. A clear result is a geometric screen, not proof that the parts assemble or that a print will fit.
5. Show the steps with `do set_step step=<n>`: 0 lays every sequenced part out, and the last step is fully assembled. `do set_step mode=buildup` hides parts until their step, and `do set_step step=null` leaves the sequence. Fit the view once, then set and `capture` each step for instruction images; captures wait for a step to finish moving. Check `state` for unmatched labels or a stale sequence before trusting what a capture shows.
6. Keep step images worth reusing with the project's existing notes or deliverables, together with the model revision.

## References and Tool Boundaries

Maintained-viewer references use `cadproto:v2` topology/occurrence/face, edge or whole-part identities. Use Faces, Edges or Parts in the toolbar; edge references identify actual STEP edges, not tessellation outlines. Resolve a pasted reference with `cad_explorer_inspect` or the canvas's `inspect_reference` action in Copilot, or with `explorer.mjs inspect '<pasted text>'` elsewhere. Outside Copilot, a copied reference is a readable summary line followed by its `cadproto:v2` address. Do not feed these IDs into the cad skill's `scripts/inspect`. `@cad[...]` references come from that inspector's output and must be resolved there; the Explorer neither copies nor resolves them.

The maintained Explorer exposes explicit state, selection, view, explosion, assembly-step, section and capture actions: canvas actions in Copilot, and `explorer.mjs` commands elsewhere. Read their returned state before claiming to know what is selected or visible. User clicks can copy references to the clipboard, but do not insert or send chat messages.

Use the maintained Explorer's section view when a bridge, cover or surrounding body hides a feature the user wants to inspect. A cutting plane changes the display only; it does not cut the source STEP. Preserve the view direction and record the axis, plane position, visible side and any exploded placement with feedback. Artificial cut surfaces are not selectable native CAD faces or edges. A visible gap is useful context, but dimensional clearance still requires geometry measurement and printed fit still requires physical evidence.

Drawings are bound to their captured image and model revision. Use a returned capture or an image shared by the user, and verify the marks are present before interpreting them. Do not mistake a live model capture for an annotated saved review. Keep useful review images and decisions in the selected project's existing review location; runtime captures are not automatically project deliverables.