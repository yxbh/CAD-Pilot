---
name: visual-review
description: 'Show, capture and talk through 3D models with someone who is not a CAD user, in CAD-Pilot''s CAD Explorer viewer. Use whenever a STEP or mesh (STL, OBJ, 3MF, PLY, GLB, scans, other people''s models) should be opened, shown, rendered to an image, compared before/after or against a scan, sectioned or measured as a mesh; when the user points at an edge, surface or spot, pastes a viewer reference or marks up a screenshot; when they cannot name the shape they want; or to show how parts go together or come apart (assembly steps).'
---

# Visual Co-Design

The cad skill builds and measures geometry; this skill shows it. `<workbench>` below is the CAD-Pilot checkout this skill belongs to; the cad skill's [Finding the workbench](../cad/SKILL.md#finding-the-workbench) says how to locate it. `<workbench>/explorer/README.md`, the Explorer's manual, covers every command and format named here.

## Showing a Model

CAD Explorer is the only viewer. Open the project's actual STEP or mesh, never the demo or a copy moved into the workbench, and do not regenerate geometry merely to view an existing file.

In the Copilot desktop, use the `cad-explorer` canvas when it is available: check the canvas types, inspect its capabilities, and pass the design directory as `projectRoot` and the file as `file`. Reuse the existing panel for the same setup. Access to the workbench's files does not register its Copilot project extension, there is no separate VS Code extension, and Copilot's reference chips do not work in other chat hosts.

In other hosts, such as Claude Code, run `node <workbench>/explorer/scripts/explorer.mjs open <project-relative file>` from the design project's root and show the returned URL; in the Claude desktop app, open it in the built-in browser pane and keep reusing that tab. After regenerating, run the same `open` again: it reloads the running viewer at the same URL and, for the same file with the same part names, keeps the user's camera, section, explosion, step and hidden parts. Do not start, kill or restart viewers yourself or hand out a new link while the old one works; the viewer outlives the chat, and `stop` is for when the user is finished. Drive the view with `do <action> key=value ...`, such as `do set_view preset=top` (`actions` lists them).

`open`, `state` and `do` answer with a short summary (`state --full` and `do --full` add parts and references; `detail=full` for the canvas's `get_state`). Its revision and generated time match the `rev` in the viewer's header: tell the user which revision to expect. When `note` says no page is open or the open page has not drawn the current revision, say so instead of assuming the user sees it; when it names an added file that was left out, tell the user, and ask before adding anything back when it says the file has changed or is gone. `changedOnDisk` means the file was regenerated after loading: run `open` again.

For an image, `capture [<project-relative .png>]` saves the current view, drawn in the background at 1280x800 (`--size WxH`), whether or not the user's page is open; set the view first with `do`. `render <file> <out.png>` draws a file without opening or changing any viewer, for documentation images. Keep saved images inside the design project.

If the Explorer cannot build, start or connect, report that as an error, never silently substitute another viewer, and rely on the cad skill's CLI inspection for geometry. `open` prints the build command when the Explorer is not built.

## Co-Design Workflow

1. Open the project's model as above. Report the model path and revision, and keep the camera across comparisons where possible.
2. Use plain words: opening, rim, rounded edge, wall, attachment point. The user does not need CAD terminology to express a preference.
3. Accept a viewer reference, an `@cad[...]` reference, a circled screenshot, a sketch, a reference photo or prose. A screen location is not a world coordinate, and a photo does not give real-world dimensions without a scale reference.
4. Before an ambiguous edit, show the selected region or a labelled screenshot and ask whether it is the intended target. If the user is unsure about the shape, offer two rough alternatives instead of asking for a technical name.
5. Keep feedback worth reusing (screenshot or reference, model revision, intended change, what must stay fixed, and the view when a mark needs it) in the project's existing notes; no separate review form. Do not invent selections or claim you saw a view you did not inspect.
6. Edit the smallest responsible source feature, regenerate, inspect, and show before/after views. Capture and look at the change yourself before asking the user to, as the cad skill's [self-review](../cad/references/self-review.md) describes.
7. Ask for approval of the overall shape before cosmetic details. Keep aesthetic approval separate from dimensional, print and safety checks.

## Meshes, Scans and Comparisons

Mesh files open directly, as they are. Do not convert a mesh to STEP to view, section or measure it, or write throwaway converters for that: open it and read the summary's `frame` (`model.frame`, or each of `view.files`) for the units and up axis used and why. If the size or orientation is wrong, `open` it again with `--units` (`mm`, `cm`, `m`, `in`, `ft`, `um`) and `--up` (`z` or `y`). When a scan's scale is uncertain, ask the user for one real measurement rather than assuming a unit. Viewer limits are not print limits; say which is which.

To compare, open the design and `do add_file file=<other>`: added files are see-through ghosts in their own frames. `do set_layout mode=side` puts them side by side, and `do set_file id=ref1 style=solid` or `offset=[x,y,z] rotate=[rx,ry,rz]` (degrees) lines one up, all under one camera; placement is display only, and `open` after regenerating keeps the added files. Show mesh faults with `do set_faults visible=true` and describe them plainly: holes, edges shared by too many triangles, flipped patches, zero-area slivers. To look at the triangles themselves, on a STEP or a mesh, use the manual's analysis views (`do set_analysis`, or `render`/`capture` options): triangle edges, back faces, overhangs toward the direction the part will print, wall thickness, curvature, zebra stripes and normals, each with a legend in the image. Set the build direction and minimum wall from the print plan rather than the defaults, and present colours as places to look, not verdicts.

Measure meshes with `<workbench>/explorer/python/measure.py`, as the Explorer manual's Measuring meshes describes; for a hole or slot, cut a section through it and read the circle or slot fit with its residuals. Report mesh measurements as of the file's triangles, separate from the design's parameters and from physical checks.

## Assembly Steps

Use assembly steps when the user wants to see how parts go together or come apart, needs step-by-step images, or asks whether an order works. The STEP needs labelled parts. The Explorer manual's Assembly steps defines the sequence format, part matching and the check.

1. Agree the order in plain words first, including which part stays put and anything done by hand, such as squeezing a clip. Ask rather than invent an order for a mechanism you have not understood.
2. Write the sequence in the design's Python source as `gen_assembly()` beside `gen_step()`, returning `{"steps": [...]}`; each step has a `title`, `parts` (names as the cad skill's `inspect parts` lists them, with `*`/`?`), `from` (the millimetre offset the parts arrive from) and an optional `note`. Derive offsets from named parameters where they matter, and give later steps on the same axis larger offsets so waiting parts do not seem to pass through each other. In an existing project, ask before adding the function.
3. After generating the STEP, run `<workbench>/explorer/python/assembly.py <source.py> --step <project-relative STEP> --check` from the design root with the same interpreter as the cad tools. It writes `<name>.assembly.json` beside the STEP and never changes the STEP. Then run `open` again (or reload the canvas) so the viewer reads it.
4. Report the check per step: clear, blocked (first blocking part and distance) or interferes (overlapping when installed). It is a rigid straight-line sweep, so a flexing snap part is expected to block; supply `check_shapes` only with a deflected illustration the source already models, and say the check used it. A clear result is a geometric screen, not proof that the parts assemble or that a print will fit.
5. Show the steps with `do set_step step=<n>` (0 lays every sequenced part out; the last step is assembled), `mode=buildup` to hide parts until their step, and `step=null` to leave the sequence. Fit the view once, then set and `capture` each step; captures wait for a step to finish moving. Check `state` for unmatched labels or a stale sequence before trusting a capture.
6. Keep step images worth reusing with the project's notes or deliverables, with the model revision.

## References and Tool Boundaries

The viewer's references are `cadproto:v2` face, edge, picked-point or whole-part identities, chosen with Faces, Edges, Points or Parts in its toolbar; meshes have only parts and points. Resolve a pasted one with `cad_explorer_inspect` or the canvas's `inspect_reference` action in Copilot, or `explorer.mjs inspect '<pasted text>'` elsewhere; a point reference is in its part's own frame, and `inspect` adds its world position. `@cad[...]` references come from the cad skill's `scripts/inspect` and are resolved only there. The two numbering systems never mix: do not feed one tool's IDs to the other. A reference, like a screenshot, belongs to the revision it was taken from, and `inspect` still resolves an old one against that revision's geometry: after regenerating, check it against the current `rev` and ask the user to select again.

Read the returned state before claiming to know what is selected or visible. User clicks can copy references to the clipboard, but do not insert or send chat messages.

Use section view when a cover or surrounding body hides a feature. It is display only: it does not cut the file, its cut faces cannot be selected and are not CAD faces, and a visible gap is context, not a measured clearance or a printed fit. Record the axis, position, visible side and any explosion with feedback that depends on it.

Drawings are bound to their captured image and model revision. Use a returned capture or an image the user shared, verify the marks are present before interpreting them, and do not mistake a live capture for an annotated saved review. Runtime captures are not project deliverables until saved into the project.
