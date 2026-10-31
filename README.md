# CAD-Pilot

Personal workbench for conversational CAD design and 3D-print preparation with an AI agent, such as Claude Code or GitHub Copilot. Python source and parameters own design intent; STEP, STL, 3MF and preview images are generated outputs. Design projects live in their own folders and repositories; this one holds the tools and guidance they use:

- The [cad skill](.agents/skills/cad/SKILL.md), forked from text-to-cad: build123d modeling, STEP generation, geometry inspection and the [print handoff](.agents/skills/cad/references/print.md) to Bambu Studio.
- The [visual-review skill](.agents/skills/visual-review/SKILL.md): showing models, images, meshes and assembly steps, and co-designing with someone who points rather than names.
- The [fdm-design skill](.agents/skills/fdm-design/SKILL.md): designing for FDM printing, orientation, fits and calibration.
- [CAD Explorer](explorer/README.md), the STEP and mesh viewer: the Copilot desktop canvas, and a background viewer that other hosts open and drive from a design project.

## Setup

Prerequisites: Windows or macOS, Git, uv, and Node.js 22.18+ or 24+ (Node's built-in TypeScript support runs the Explorer tests). PowerShell 7 runs the PowerShell examples. The project requires Python 3.12 or newer with compatible CAD dependency builds; uv can provision Python. From the workbench root:

```powershell
uv sync
uv run python -m playwright install chromium
Push-Location explorer
npm install
npm run build
Pop-Location
```

Playwright's Chromium draws the Explorer's views in the background (confirming loads, captures and renders) and runs its browser checks; STEP generation does not need it. Installing and running third-party tools executes code; this is not a sandbox. Dependency locks stay local to each machine (see AGENTS.md).

The CAD integration uses build123d 0.13+ and the OCP 8+ collection, topology-cast and bounding-box APIs. `pyproject.toml` declares minimums without upper caps, and build123d's own constraints select its OCP family. For a dependency update, resolve afresh with `uv sync --upgrade` in a disposable checkout using the configured feeds, then run the checks; minimum versions alone do not certify future releases.

In the Copilot desktop, reload project extensions and open **CAD Explorer**.

## Use the skills in other projects

Claude Code sessions started in this checkout load the skills through `.claude/skills`, which links each one to `.agents/skills`; on Windows without Git symlink support (`core.symlinks`) those links are checked out as text files, and the personal links below take their place. To load the skills in sessions started in any other folder, link your personal skills folder to your main checkout once, from its root:

```text
node tools/install-skills.mjs
```

It links `~/.claude/skills/<name>` (or `$CLAUDE_CONFIG_DIR/skills/<name>`) to `.agents/skills/<name>` for each skill, as a junction on Windows, so updating the checkout updates every project and nothing is copied. It replaces links to any checkout's `.agents/skills/<name>` and refuses to touch anything else; run it again after adding a skill or moving the checkout, and delete the links to remove them. Personal skills take precedence over a checkout's own, so once they are installed every session, including one in another clone or worktree of this repository, uses the installed checkout's skills: to try a skill change from a worktree, run the installer there, and again from the main checkout afterwards. A new session then lists `cad`, `visual-review` and `fdm-design`; from a terminal, the first line of `claude -p "hello" --output-format stream-json --verbose` names the loaded skills under `skills`.

GitHub Copilot reads `.agents/skills` in this checkout; its hosts that also read the personal `~/.claude/skills` folder pick up the same links. In a design project the skills locate the workbench from their own path, as the cad skill's [Finding the workbench](.agents/skills/cad/SKILL.md#finding-the-workbench) describes, or from a path the project's instructions give.

## Start a design

For a new project, copy the contents of `templates/project/` into a new, empty folder outside the workbench, including its `.gitignore`, and replace the sample brief before designing; the sample plate is a tooling test. The template is a proposed layout, not a required one: existing projects keep their own layout and instructions. Copying it does not initialize Git or assign a Git identity.

The agent runs the tools for you, as the skills describe. To try them by hand, start at the workbench root; the example uses a sibling design folder, `../first-part`:

```powershell
$Workbench = $PWD.Path
$Python = if ($IsWindows) { Join-Path $Workbench '.venv/Scripts/python.exe' } else { Join-Path $Workbench '.venv/bin/python' }
$Cad = Join-Path $Workbench '.agents/skills/cad'
Push-Location ../first-part
& $Python "$Cad/scripts/step" source/mounting_plate.py -o outputs/mounting_plate.step --stl mounting_plate.stl --3mf mounting_plate.3mf
& $Python "$Cad/scripts/inspect" refs outputs/mounting_plate.step --facts --planes --positioning
node "$Workbench/explorer/scripts/explorer.mjs" open outputs/mounting_plate.step
& $Python "$Cad/scripts/print" project outputs/mounting_plate.step --slice
Pop-Location
```

These commands execute the Python generator and do not enforce a filesystem sandbox. Check each command's result before continuing. The print step needs a personal print profile in `~/.cad-pilot/`; without one it says so, and the agent asks you for your printer, filament and plate.

## Visual review

In CAD Explorer, choose Faces, Edges, Points or Parts in the toolbar; hovering previews a target and clicking selects it and copies a reference. To ask for a change:

1. Select a face, edge or part and paste its copied reference into chat.
2. Describe what feels wrong in plain language; attach a marked screenshot, sketch or reference picture when easier. Draw and screenshot controls are in the viewer.
3. Say what must stay unchanged, and expect the agent to confirm the region or show rough alternatives before an ambiguous edit.

There is no automatic chat-selection bridge: the agent does not see your live selection or drawing until you send a reference or screenshot. Keep decisions worth reusing in the project's own notes.

## Checks

From the workbench root, one command runs every check: the Python suites (workbench, Explorer converter and all of the cad skill's tests), the Explorer core tests and its isolated browser scenarios, after a type-check and build of the Explorer whenever its sources or installed packages changed:

```text
node tools/check.mjs
```

Independent stages run at the same time, sized from the machine's cores. Each stage's output is printed when it ends, with pytest's slowest tests, then a summary; a failed stage makes the command exit nonzero, skips the stages that need it and lets the others finish. Each stage's output is kept in `.local/check/`. The VS Code **CAD-Pilot: Check all** task runs the same command.

GitHub Actions checks pull requests and pushes to `main` on macOS, Windows and Linux. The locks stay local, so each run resolves the Python dependencies afresh. The Explorer's packages are resolved afresh at most once a day on each system: a later run that day restores the tree an earlier run on `main`, or on the same pull request, installed. Each system runs `node tools/check.mjs --share <i>/<n>` in several jobs (five on macOS, as many macOS jobs as an account may run at once, six on Linux and seven on Windows), each with its share of the Python and Explorer test files (`tools/shares.mjs`), which pytest and the Explorer's runner are given by name. A job runs its two suites side by side, so the files are split by each file's measured time on that system's CI runners to keep every job's slower suite about as quick as another's (`tests/durations.json` and `explorer/tests/durations.json`; `node tools/durations.mjs [<run id>...]` refreshes both from the latest successful run on `main`, or averages the runs given; a new test file counts as the median of its kind until then). A final `checks` job passes only when every other job passed; it is the check branch protection requires.

While working, `node tools/check.mjs --quick` leaves out the browser scenarios; run the full check before a pull request. For one area, `uv run pytest -q -n 4` covers Python (drop the workers for one file), and `npm --prefix explorer run test:core` and `test:browser` cover the Explorer, building it first when it is out of date; see the [Explorer check matrix](explorer/README.md#validation).

Keep new tests cheap:

- Tests run in parallel, so each one creates its own temporary folders and runtime roots and never relies on another test's files or order. The root `conftest.py` runs a unittest class whose own body defines `setUpClass` on one worker, so build an expensive shared fixture there once and run its independent pieces concurrently; every other test goes to whichever worker is free. An inherited `setUpClass`, pytest's `setup_class` and class- or module-scoped fixtures are built again on each worker that runs one of their tests. A worker that crashes has its test reported as crashed and its unfinished tests handed to the others.
- Use the smallest geometry that shows the behaviour; a CAD subprocess costs seconds of imports before any modelling.
- Wait on a condition (state, a locator, a file), never a fixed sleep, and bound work by what it does, such as CPU time or call counts, rather than wall time that other suites share.
- Test a behaviour at the cheapest level that shows it; keep a browser scenario for what only a real page can show.

Print checks that need Bambu Studio skip when it is not installed. Previous passing runs do not establish the state of a new environment, and a clean dependency audit is not a security certification. The workbench slices only as a check; it does not control printers, verify physical fit or certify printability.

## Local data

CAD Explorer keeps its copies of design geometry in the user's local application data, not in the workbench or the design project (its [local data](explorer/README.md#local-data)); a design-project viewer keeps running after `explorer.mjs open` exits until `explorer.mjs stop`. `scripts/inspect` keeps STEP topology indexes in a per-user cache ([inspection](.agents/skills/cad/references/inspection-and-validation.md#tool)), and the print profile lives in `~/.cad-pilot/`. Runtime files under `.local/`, `.venv/` and generated outputs are ignored by Git.

## Provenance

The [skills registry](.agents/skills/README.md) records each skill's source, revision, license and local changes, and the Explorer's README records the code it adapted. First-party tools, templates and guidance are maintained here, with their history in Git. No additional license is granted for original work here; imported notices remain intact, and dependency packages have their own licenses.
