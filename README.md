# CAD-Pilot

Personal workbench for conversational CAD design and 3D-print preparation with GitHub Copilot in VS Code or Copilot CLI. Python source and parameters own design intent; STEP, STL, 3MF, and preview assets are generated outputs.

## Stack and Setup

The workbench uses build123d, a cad skill forked from text-to-cad, and original visual-review and FDM-design skills. Its maintained first-party [CAD Explorer](explorer/README.md) provides the project-scoped Copilot desktop canvas and a design-project browser viewer that Claude Code and other hosts can open and drive. No MCP server or global skill installation is needed. Python dependencies live in a local environment managed by uv.

Prerequisites: Windows or macOS, Git, uv, and Node.js 22.18+ or 24+. Node's built-in TypeScript support is used by Explorer tests. PowerShell 7 is needed for the PowerShell examples. The project requires Python 3.12 or newer; the selected version also needs compatible CAD dependency builds. uv can provision Python when needed.

```text
uv sync
uv run python -m playwright install chromium
```

Run setup from the workbench root. Playwright Chromium draws the Explorer's views in the background (confirming loads, captures and renders) and runs its browser checks; STEP generation does not need it. Installing/running third-party tools executes code; this is not a sandbox.

Commit `pyproject.toml`; keep `uv.lock` local and Git-ignored. Normal `uv sync` and `uv run` create or reuse the local lock using each machine's configured feeds. Exact Python dependency versions may differ across machines.

The CAD integration uses build123d 0.13+ and the OCP 8+ collection, topology-cast and bounding-box APIs. The dependency manifest declares minimums without workbench-imposed upper caps; build123d's own dependency constraints select its compatible OCP family. The cad skill's CLI carries a provenance-recorded OCP API patch. For dependency updates, resolve afresh with `uv sync --upgrade` in a disposable checkout using the configured feeds, then run `node tools/check.mjs`. Python discovery includes all of the cad skill's tests as well as the maintained converter. New releases must earn compatibility through these checks; minimum versions alone do not certify future releases.

For the first-party CAD Explorer, build its separate package:

```powershell
Push-Location explorer
npm install
npm run build
Pop-Location
```

Commit `explorer/package.json`, but keep its `package-lock.json` local and Git-ignored, like `uv.lock`. Normal `npm install` creates or reuses that machine's lock using its configured registry; do not commit private-feed URLs or override required feeds to make a shared lock. Versions permitted by the manifest can resolve differently across machines.

Prepare source releases from tracked files, such as a Git archive, rather than zipping the working directory. Local locks, runtime data and caches are not release content.

Reload project extensions and open **CAD Explorer**. Its [README](explorer/README.md) owns build/open, viewer behavior and local-data guidance. Preserve useful saved references and drawings before moving or removing runtime data.

Run `node tools/check.mjs` for the workbench and maintained Explorer checks; the VS Code **CAD-Pilot: Check all** task runs the same command. **Test Python** runs `uv`/pytest only, and **Test Explorer core** runs the non-browser Node checks. No default test task is imposed.

`AGENTS.md`, the cad and visual-review skills and the design-project template route viewing to the maintained Explorer (the Copilot canvas, or the design-project viewer in other hosts). The cad skill owns modeling, generation and CLI inspection; the visual-review skill owns choosing, opening and driving the viewer.

## Start a Design

The project template is a proposed convention, not a mandatory structure. Use it for new projects unless another layout is preferred. For existing projects, respect their layout and instructions; do not reorganize them merely to match the template.

To use the starter, copy the contents of `templates/project/` into a new, empty design folder separate from the workbench, including its `.gitignore`. Do not copy it over existing work. Replace the sample brief before designing; the plate is a tooling test, not an approved product. Copying the template does not initialize Git, assign a Git identity, or register shared skills.

Invoke the cad skill's tools with the workbench's Python interpreter, while keeping the current directory at the design root. A design project with its own Python environment that includes build123d, such as a uv project, runs them with its own interpreter instead (`uv run python <workbench>/.agents/skills/cad/scripts/step ...`), so generators can import the project's dependencies; generators can import the project's own modules from its root and `src/` folder either way. Pass the interpreter as an absolute path: Python warns about `sys.prefix` on every run when the path contains `..`. Start the following example at the workbench root. It uses a sibling design folder, `../first-part`; substitute the relative path to your design. Capture the workbench location before switching folders:

```powershell
$Workbench = $PWD.Path
$Python = if ($IsWindows) { Join-Path $Workbench '.venv/Scripts/python.exe' } else { Join-Path $Workbench '.venv/bin/python' }
$Cad = Join-Path $Workbench '.agents/skills/cad'
Push-Location ../first-part
New-Item -ItemType Directory -Path outputs -Force | Out-Null
& $Python "$Cad/scripts/step" source/mounting_plate.py -o outputs/mounting_plate.step --stl mounting_plate.stl --3mf mounting_plate.3mf
& $Python "$Cad/scripts/inspect" refs outputs/mounting_plate.step --facts --planes --positioning
node "$Workbench/explorer/scripts/explorer.mjs" open outputs/mounting_plate.step
Pop-Location
```

Check each command's result before continuing; do not mistake an older artifact for a successful new build. These commands execute the Python generator and do not enforce a filesystem sandbox.

For an existing project, skip the template and use its generator defining `gen_step()`. Choose the STEP destination with `-o`; use a project-relative path with forward slashes, including on Windows. Inspect that same relative path to keep geometry references consistent. STL and 3MF sidecar paths are relative to the STEP's directory, so do not repeat the output directory in those arguments. A hidden `.<name>.step.glb`, which `scripts/inspect` reads for `@cad` references, is generated beside the STEP.

With the same workbench variables, start from the workbench root and substitute the relative path to the existing project:

```powershell
Push-Location ../existing-part
New-Item -ItemType Directory -Path 'artifacts/print files' -Force | Out-Null
& $Python "$Cad/scripts/step" models/part.py -o 'artifacts/print files/part.step' --stl part.stl --3mf part.3mf
& $Python "$Cad/scripts/inspect" refs 'artifacts/print files/part.step' --facts --planes --positioning
node "$Workbench/explorer/scripts/explorer.mjs" open 'artifacts/print files/part.step'
Pop-Location
```

This does not require template instructions, a brief, or local configuration files, and it does not relocate existing source. Tell the agent where your requirements and workbench are, and use your project's existing review location. Match the artifact directory to your project's ignore/retention policy. Prefer matching generator and STEP basenames; use distinct output paths to avoid overwriting another model.

Open the design folder and explicitly provide the workbench path, or add both folders to a multi-root workspace. Start a fresh chat for each project and explicitly name the active project. Ask the agent to read the project instructions and load the shared skills. Existing `.cad-pilot.local.json` or `.cad-pilot.code-workspace` files can still locate the toolkit, but are not required or generated by this workflow. External paths do not automatically register skills. Verify loaded customizations in the selected agent host rather than assuming cross-folder discovery.

For Copilot CLI, start in the design folder, allow access to the workbench when prompted (or use `/add-dir`), and ask it to read the project instructions. Local workspace and path files are ignored. The dependency declaration and skills registry describe the workbench's dependencies; the local Python lock records that machine's resolution. Record the relevant workbench revision and actual dependency versions with a project only when reproduction requires them.

## Visual Review

The maintained Explorer, as the Copilot canvas or the design-project viewer that `explorer/scripts/explorer.mjs open` starts and reuses, opens ordinary STEP snapshots, supports exploded views, assembly steps, section views, exact face, edge and part references, Studio appearance and saved drawing reviews. Choose Faces, Edges or Parts in its toolbar; hovering previews the target and clicking selects it. Its `cadproto:v2` references are separate from the `@cad` addresses that `scripts/inspect` reports. Section view looks inside an assembly: choose an X, Y or Z cutting plane, adjust its position and flip the visible side. This is a display-only cutaway, not a change to the STEP or print geometry. Cut surfaces are visual aids, not newly created CAD faces or evidence of measured clearance. Use geometric inspection for dimensions, and include the section settings when discussing a captured gap or internal feature.

1. Select a face, edge or part and paste its copied reference into chat.
2. Describe what feels wrong in plain language; attach a marked screenshot, sketch, or reference picture when easier. Draw and screenshot controls are available in the viewer.
3. Ask the agent to confirm the region or show rough alternatives before an ambiguous edit. State what must remain unchanged.
4. Keep useful decisions and feedback with the project's existing notes. Include the model revision and relevant screenshot/reference so a later session can interpret them. No separate review form is required; re-resolve selections after geometry changes.

Regenerating STEP and sidecars with a different exporter or CAD kernel can change assembly hierarchy and `@cad` occurrence selectors even when physical geometry remains equivalent. Keep the artifact revision with a copied reference and re-inspect the regenerated artifact; do not translate old selector paths by adding or removing an assumed hierarchy level.

There is no automatic chat-selection bridge. Your live browser selection or drawing is not visible to the agent until you send a reference or screenshot. Check that annotations appear in the shared image. Confirm printer, nozzle, material, loads, and fit allowances when they affect the design.

## FDM Design Guidance

The [FDM-design skill](.agents/skills/fdm-design/SKILL.md) covers layer-aware strength and orientation, walls and fine features, overhangs/bridges/support access, fits and tolerance budgets, first layers, inserts, snap-fits, and material/process selection. It complements modeling and visual review; it is not an automated printability validator.

Existing community skills were evaluated first. The resulting guidance is an original, engine-independent synthesis with manufacturer references, not a wholesale OpenSCAD import. See the [central provenance registry](.agents/skills/README.md#fdm-design) for the reviewed revisions and scope. Imported documentation remains unchanged.

Start with known equipment and materials. Add useful fit measurements and print results to the project's existing notes as they happen, including the relevant configuration. No formal profile or calibration exercise is required to start designing. Assumptions are not measurements, and results from a different configuration need review before reuse.

## Print Handoff

The cad skill's `scripts/print` turns STEP or STL parts into one Bambu Studio project 3MF with named plates, checks each part in its print orientation, and slices the project with the installed Bambu Studio's command line. Printer, process, build plate, filaments and supports come from a personal print profile in `~/.cad-pilot/print-profile.json`, which each project's print job can override. Its [reference](.agents/skills/cad/references/print.md) owns the profile, job format and checks. With the variables from Start a Design, from the design root:

```powershell
& $Python "$Cad/scripts/print" profile
& $Python "$Cad/scripts/print" project prints/part.print.json --slice
& $Python "$Cad/scripts/print" project outputs/part.step --rotate 180 0 0 --slice --open
```

The last line of each project report is the 3MF path. `--open` opens the project in Bambu Studio; nothing is sent to a printer.

## Provenance

The workbench-owned [.agents/skills/README.md](.agents/skills/README.md) contains one provenance entry per skill: source URL/path, pinned revision, import date, license/attribution, scope, local patches, and update checks. Keep upstream READMEs and licenses intact. The cad skill is a first-party fork: its entry keeps the source revision, license and attribution, and its text and scripts are maintained here. Use the same parent-collection README convention for future instructions, prompts, and agent imports.

First-party tools, templates, and guidance are maintained in this repository; their revisions are recorded in Git. No additional license is granted for original work here. Imported notices remain intact, and dependency packages have their own licenses.

Keep workbench content evergreen: document supported workflows, current limitations, and repeatable checks rather than session reports or historical pass counts. Add structure only for a demonstrated need. Keep project-specific decisions and print results with the project; preserve immutable source revisions, import dates, and imported dependency locks rather than automatically refreshing imports. The Python lock remains machine-local.

## Validation and Limits

From the workbench root, one command runs every check: the Python suites (workbench, Explorer converter and all of the cad skill's tests), Explorer core tests and isolated browser scenarios, after a type-check and build of the Explorer whenever its sources or installed packages changed:

```text
node tools/check.mjs
```

Independent stages run at the same time, sized from the machine's cores: pytest on up to four workers, Explorer core tests, and a few browser scenarios at once. Each stage's output is printed when it ends, with pytest's slowest tests, followed by a summary; a failed stage makes the command exit nonzero, skips the stages that need it and lets the others finish. Each stage's output is also kept in `.local/check/`.

GitHub Actions checks pull requests and pushes to `main` on macOS, Windows and Linux, resolving dependencies afresh because the locks stay local. Each system runs `node tools/check.mjs --python` in one job and `--explorer <i>/4` in four more, which split the Explorer core suite and browser files by their measured CI time (the table in `explorer/scripts/test.mjs`). A final `checks` job passes only when every other job passed; it is the check branch protection requires.

While working, `node tools/check.mjs --quick` leaves out the browser scenarios; run the full check before a pull request. For a single area, `uv run pytest -q -n 4` covers Python (drop the workers for one file), `npm --prefix explorer run test:core` covers non-browser Explorer checks, and `npm --prefix explorer run test:browser` exercises the maintained UI; both Explorer commands build it first when it is out of date. See the [Explorer check matrix](explorer/README.md#validation) for targeted regressions and limitations.

Keep new tests cheap:

- Tests run in parallel, so each one creates its own temporary folders and runtime roots and never relies on another test's files or order. The root `conftest.py` runs a unittest class whose own body defines `setUpClass` on one worker, so build an expensive shared fixture there once and run its independent pieces concurrently, as the solid-check and mesh tests do; every other test goes to whichever worker is free, so tests that set up only for themselves spread out even within one class. An inherited `setUpClass`, pytest's `setup_class` and class- or module-scoped fixtures are built again on each worker that runs one of their tests. A worker that crashes has its test reported as crashed and its unfinished tests handed to the others.
- Use the smallest geometry that shows the behaviour; a CAD subprocess costs seconds of imports before any modelling.
- Wait on a condition (state, a locator, a file), never a fixed sleep, and bound work by what it does, such as CPU time or call counts, rather than wall time that other suites share.
- Test a behaviour at the cheapest level that shows it; keep a browser scenario for what only a real page can show.

Python checks cover sample geometry, direct cad CLI generation/inspection, STEP/STL/3MF round trips, output paths with spaces, skill provenance, the cad skill's common/export behavior and CLIs, the print handoff and the maintained STEP converter. Print checks that need Bambu Studio skip when it is not installed. Previous passing runs do not establish the state of a new environment. Audit Explorer dependencies when reviewing updates; a clean audit is not a security certification.

The workbench slices only as a check, through an installed Bambu Studio's command line. It does not control printers, verify physical fit, or certify printability; its thin-wall check samples layer outlines.

The maintained design-project viewer keeps running after `explorer.mjs open` exits; stop it from its project with `explorer.mjs stop`. It keeps its copies of design geometry in the user's local application data, not in the workbench or the design project; see the Explorer's [local data](explorer/README.md#local-data). Runtime files under `.local/`, `.venv/`, and generated outputs are ignored by Git.
