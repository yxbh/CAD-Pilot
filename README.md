# CAD-Pilot

Personal workbench for conversational CAD design and 3D-print preparation with GitHub Copilot in VS Code or Copilot CLI. Python source and parameters own design intent; STEP, STL, 3MF, and preview assets are generated outputs.

## Stack and Setup

The starter uses build123d, the pinned text-to-cad skill and CAD Explorer, and original visual-review and FDM-design skills. It is CLI-first; no MCP server or global skill installation is needed. Dependencies live in a local Python environment managed by uv.

Prerequisites: Windows, Git, PowerShell 7, uv, and Node.js 22.12+ or 24. The project requires Python 3.12 or newer; the selected version also needs compatible CAD dependency builds. uv can provision Python when needed.

```powershell
uv sync
npm --prefix .agents/skills/cad/explorer ci
./.venv/Scripts/python.exe -m playwright install chromium
uv run pytest -q
```

Run setup from the workbench root. Playwright Chromium is needed for browser checks and the imported render commands, not for STEP generation. A VS Code task is available for tests. Installing/running third-party tools executes code; this is not a sandbox.

Commit `pyproject.toml`; keep `uv.lock` local and Git-ignored. Normal `uv sync` and `uv run` create or reuse the local lock using each machine's configured feeds. Exact Python dependency versions may differ across machines. The imported viewer's npm lockfile remains version-controlled.

## Start a Design

The project template is a proposed convention, not a mandatory structure. Use it for new projects unless another layout is preferred. For existing projects, respect their layout and instructions; do not reorganize them merely to match the template.

To use the starter, copy the contents of `templates/project/` into a new, empty design folder separate from the workbench, including its `.gitignore`. Do not copy it over existing work. Replace the sample brief before designing; the plate is a tooling test, not an approved product. Copying the template does not initialize Git, assign a Git identity, or register shared skills.

Invoke the imported tools with the workbench's Python interpreter, while keeping the current directory at the design root. Start the following example at the workbench root. It uses a sibling design folder, `../first-part`; substitute the relative path to your design. Capture the workbench location before switching folders:

```powershell
$Workbench = $PWD.Path
$Python = Join-Path $Workbench '.venv/Scripts/python.exe'
$Cad = Join-Path $Workbench '.agents/skills/cad'
Push-Location ../first-part
New-Item -ItemType Directory -Path outputs -Force | Out-Null
& $Python "$Cad/scripts/step" source/mounting_plate.py -o outputs/mounting_plate.step --stl mounting_plate.stl --3mf mounting_plate.3mf
& $Python "$Cad/scripts/inspect" refs outputs/mounting_plate.step --facts --planes --positioning
node "$Cad/explorer/scripts/ensure-dev.mjs" --workspace-root "$PWD" --root-dir "$PWD" --file outputs/mounting_plate.step --json
Pop-Location
```

Check each command's result before continuing; do not mistake an older artifact for a successful new build. These commands execute the Python generator and do not enforce a filesystem sandbox.

For an existing project, skip the template and use its generator defining `gen_step()`. Choose the STEP destination with `-o`; use a project-relative path with forward slashes, including on Windows. Inspect that same relative path to keep geometry references consistent. STL and 3MF sidecar paths are relative to the STEP's directory, so do not repeat the output directory in those arguments. Hidden viewer assets are generated beside the STEP.

With the same workbench variables, start from the workbench root and substitute the relative path to the existing project:

```powershell
Push-Location ../existing-part
New-Item -ItemType Directory -Path 'artifacts/print files' -Force | Out-Null
& $Python "$Cad/scripts/step" models/part.py -o 'artifacts/print files/part.step' --stl part.stl --3mf part.3mf
& $Python "$Cad/scripts/inspect" refs 'artifacts/print files/part.step' --facts --planes --positioning
node "$Cad/explorer/scripts/ensure-dev.mjs" --workspace-root "$PWD" --root-dir "$PWD" --file 'artifacts/print files/part.step' --json
Pop-Location
```

This does not require template instructions, a brief, or local configuration files, and it does not relocate existing source. Tell the agent where your requirements and workbench are, and use your project's existing review location. Match the artifact directory to your project's ignore/retention policy. Prefer matching generator and STEP basenames; use distinct output paths to avoid overwriting another model.

Open the design folder and explicitly provide the workbench path, or add both folders to a multi-root workspace. Start a fresh chat for each project and explicitly name the active project. Ask the agent to read the project instructions and load the shared skills. Existing `.cad-pilot.local.json` or `.cad-pilot.code-workspace` files can still locate the toolkit, but are not required or generated by this workflow. External paths do not automatically register skills. Verify loaded customizations in the selected agent host rather than assuming cross-folder discovery.

For Copilot CLI, start in the design folder, allow access to the workbench when prompted (or use `/add-dir`), and ask it to read the project instructions. Local workspace and path files are ignored. The dependency declaration and skills registry describe the workbench's dependencies; the local Python lock records that machine's resolution. Record the relevant workbench revision and actual dependency versions with a project only when reproduction requires them.

## Visual Review

The imported `ensure-dev.mjs` command prints a loopback URL scoped to the selected project. It reuses a matching viewer or chooses a free port in 4178-4198; open the printed URL in your browser. Keep it open while regenerating. No global viewer configuration is changed.

1. Select a face or edge and paste its copied `@cad[...]` reference into chat.
2. Describe what feels wrong in plain language; attach a marked screenshot, sketch, or reference picture when easier. Draw and screenshot controls are available in the viewer.
3. Ask the agent to confirm the region or show rough alternatives before an ambiguous edit. State what must remain unchanged.
4. Keep useful decisions and feedback with the project's existing notes. Include the model revision and relevant screenshot/reference so a later session can interpret them. No separate review form is required; re-resolve selections after geometry changes.

There is no automatic chat-selection bridge. Your live browser selection or drawing is not visible to the agent until you send a reference or screenshot. Check that annotations appear in the shared image. Confirm printer, nozzle, material, loads, and fit allowances when they affect the design.

## FDM Design Guidance

The [FDM-design skill](.agents/skills/fdm-design/SKILL.md) covers layer-aware strength and orientation, walls and fine features, overhangs/bridges/support access, fits and tolerance budgets, first layers, inserts, snap-fits, and material/process selection. It complements modeling and visual review; it is not an automated printability validator or slicer integration.

Existing community skills were evaluated first. The resulting guidance is an original, engine-independent synthesis with manufacturer references, not a wholesale OpenSCAD import. See the [central provenance registry](.agents/skills/README.md#fdm-design) for the reviewed revisions and scope. Imported documentation remains unchanged.

Start with known equipment and materials. Add useful fit measurements and print results to the project's existing notes as they happen, including the relevant configuration. No formal profile or calibration exercise is required to start designing. Assumptions are not measurements, and results from a different configuration need review before reuse.

## Provenance

The workbench-owned [.agents/skills/README.md](.agents/skills/README.md) contains one provenance entry per skill: source URL/path, pinned revision, import date, license/attribution, scope, local patches, and update checks. Keep upstream READMEs and licenses intact. Use the same parent-collection README convention for future instructions, prompts, and agent imports.

First-party tools, templates, and guidance are maintained in this repository; their revisions are recorded in Git. No additional license is granted for original work here. Imported notices remain intact, and dependency packages have their own licenses.

Keep workbench content evergreen: document supported workflows, current limitations, and repeatable checks rather than session reports or historical pass counts. Add structure only for a demonstrated need. Keep project-specific decisions and print results with the project; preserve immutable source revisions, import dates, and imported dependency locks rather than automatically refreshing imports. The Python lock remains machine-local.

## Validation and Limits

```powershell
uv run pytest -q
npm --prefix .agents/skills/cad/explorer test
npm --prefix .agents/skills/cad/explorer run build
./.venv/Scripts/python.exe tools/check_viewer.py --url 'http://127.0.0.1:4178/?file=outputs/mounting_plate.step' --output .local/viewer-check
```

The browser check requires the sample plate to be generated and served; use the URL printed by `ensure-dev.mjs`. It captures desktop/mobile screenshots and checks canvas pixels, camera changes, face-reference copying, and entry into draw mode.

The workbench tests cover sample geometry, direct imported CLI generation/inspection, STEP/STL/3MF round trips, output paths with spaces, and skill provenance. Run them after relevant changes; previous passing runs do not establish the state of a new environment. Audit viewer dependencies when reviewing updates; a clean audit is not a security certification.

For the pinned viewer, prefer desktop: resizing to mobile can retain excessive zoom, and the isometric reset control can overlap the top-view control (keyboard activation is available). Recheck these limitations when updating the viewer. The workbench does not perform slicing, control printers, verify physical fit, or certify minimum wall thickness.

The viewer remains running after `ensure-dev.mjs` exits. Its JSON response includes its process ID; verify that process before stopping it with `Stop-Process -Id <pid>`. Do not stop unrelated Node processes. Runtime files under `.local/`, `.venv/`, and generated outputs are ignored by Git.
