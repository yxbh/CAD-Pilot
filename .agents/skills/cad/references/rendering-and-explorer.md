# Viewing and CAD Explorer review

Read this file when a model should be shown to the user, when the user asks for screenshots, previews or sections, or when programmatic facts need visual confirmation.

## Policy

Show relevant STEP/STP artifacts in the maintained CAD Explorer whenever the host can display it. Viewing belongs to the workbench's visual-review skill: load it to choose between the Copilot `cad-explorer` canvas and `explorer/scripts/explorer.mjs`, open the model, drive the view and capture images. This skill does not start, stop or bundle a viewer.

Do not always capture images. Capture only when:

- the user explicitly asks for an image, screenshot, preview or section
- the agent needs visual evidence to resolve ambiguity
- hidden/internal features need a section view
- programmatic facts cannot confirm shape intent
- a complex assembly needs a quick visual sanity check

Do not use images as the sole validation mechanism for dimensions, topology, labels, clearances, or mating checks.

## Opening a model

In hosts without the Copilot canvas, run the workbench's Explorer command from the design project's root, with the same project-relative STEP path that `scripts/step -o` wrote and `scripts/inspect` read:

```bash
node <workbench>/explorer/scripts/explorer.mjs open path/to/model.step
```

It prints the viewer URL as JSON. Show that URL to the user and keep reusing it. After regenerating, run the same `open` again: it reloads the running viewer and returns the same URL. Do not invent URL parameters or start another viewer. If `open` reports that the Explorer is not built, follow the build command it prints or report the failure.

In the Copilot desktop, open the `cad-explorer` canvas with the design directory as `projectRoot` and the STEP as `file` instead. The visual-review skill owns the details for both hosts.

## Images

With the viewer page open, set up the view and capture it:

```bash
node <workbench>/explorer/scripts/explorer.mjs do set_view preset=iso
node <workbench>/explorer/scripts/explorer.mjs do set_section enabled=true axis=x position=0
node <workbench>/explorer/scripts/explorer.mjs capture path/to/model_section.png
```

List the available view actions with `explorer.mjs actions`. A capture waits until an open page has drawn the current view; with no page open it reports the URL to open. There is no headless renderer, so open the URL (in the Claude desktop app, in the built-in browser pane) before capturing. Keep capture paths inside the design project, not in this skill directory.

Section view is a display-only cutaway: it does not cut the STEP, and its cut surfaces are not CAD faces or evidence of clearance.

## References

`@cad[...]` refs come from `scripts/inspect` and are resolved there. The Explorer copies its own `cadproto:v2` references, which `explorer.mjs inspect` resolves. Never feed one kind to the other tool.

If an inspected selector matters, include its textual ref next to the Explorer URL:

```text
Explorer: <URL printed by explorer.mjs open>
Key ref: @cad[models/mounting_plate.step#<selector>]
```

## Reporting visual review

Report visual review honestly:

```text
Visual review: opened models/mounting_plate.step in CAD Explorer; no capture taken because geometric validation passed and no visual ambiguity was present.
```

or:

```text
Visual review: CAD Explorer could not start (<reported error>); validation relies on CLI inspection.
```

or:

```text
Visual review: section capture (X = 0) taken to confirm the internal bore and lid/base overlap.
```
