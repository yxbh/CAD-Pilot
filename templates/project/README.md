# CAD-Pilot Design Project

This starter contains a small mounting plate to verify generation and viewing. Replace the sample after discussing your own design in brief.md.

The template layout is a proposed convention, not a mandatory structure. For existing projects, preserve their layout and instructions instead of reorganizing them. The starter's brief.md, source/, outputs/, and reviews/ are defaults that can be adapted.

Open this folder and explicitly provide the shared workbench path, or add both folders to a multi-root workspace. Existing `.cad-pilot.local.json` and `.cad-pilot.code-workspace` files can still locate the toolkit, but are optional. No global skills or settings are installed.

Use the workbench's Python interpreter to invoke the imported `scripts/step` and `scripts/inspect` launchers from this project's root, following the direct commands in the workbench README.md. Choose the STEP destination with `-o`, using the same project-relative forward-slash path when inspecting it. Mesh sidecar paths are relative to the STEP directory. Keep review screenshots and decisions in the project's chosen review location; create `outputs/` or `reviews/` only when needed.

For viewing, the shared visual-review skill prefers the maintained `cad-explorer` canvas when the current host provides it, with this project as the explicit root. Otherwise it uses the imported browser/CLI workflow. Providing a workbench path alone does not register its project-scoped extension, and the two viewers' reference formats are not interchangeable.

## Instruction Provenance

AGENTS.md and this template originate in https://github.com/yxbh/CAD-Pilot, not a third-party import. The source repository's Git history records their revisions. No additional license is granted by this template. Keep this origin record when adapting the instructions.