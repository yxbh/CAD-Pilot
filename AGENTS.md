# CAD-Pilot Workbench

This repository owns reusable tooling and guidance: the cad, visual-review and fdm-design skills in `.agents/skills/` and CAD Explorer in `explorer/`. It does not hold design projects. README.md has the setup and commands.

## Design work

- Design work, here or in any project, follows the skills: cad for modeling, generation, inspection and the print handoff; visual-review for showing models, images and co-design; fdm-design for anything that will be printed. Their rules are stated there and not repeated here.
- Work on the explicitly selected project and never write design output into this checkout. Respect an existing project's layout and instructions, and locate its requirements, source, outputs and review history before editing. `templates/project/` is a proposed starting layout for new projects only.

## Maintaining the workbench

- Do not hard-wrap prose to a fixed column width in our own READMEs or instruction files. Keep each paragraph or list item on one source line and let the editor wrap visually. Preserve code blocks and upstream formatting.
- Use relative paths in reusable documentation and examples. Derive the workbench location from the current checkout when needed; do not embed machine-specific drive letters or user directories.
- Keep first-party workbench content evergreen: describe maintained behavior and how to verify it, not session progress, one-off test counts, dated success claims or notes about what was removed. Keep personal context in memory and project results with the project. Preserve provenance dates/revisions, licenses, and imported dependency locks; evergreen does not mean auto-updating imports.
- State each rule once, in the file that owns it, and link to it from elsewhere.
- Apply YAGNI to additions: solve an observed workflow need before adding schemas, templates, integrations, or tracking machinery. At natural project handoffs, note useful outcomes or friction in existing project notes; revisit tooling when evidence warrants it. Lack of a usage record is not proof of non-use. Preserve user work when simplifying.
- Before importing any skill, instruction, prompt, or agent definition, add a provenance entry in the parent collection's README.md (skills: `.agents/skills/README.md`, which defines the fields). Keep upstream READMEs and notices untouched, and do not place workbench provenance files inside imported skill folders. A skill that entry records as a first-party fork, such as cad, is maintained here like our own code: change it directly and keep its license file and attribution.
- `.agents/skills/<name>` is the one copy of each skill. `.claude/skills/<name>` is a relative link to it, one per skill, and `node tools/install-skills.mjs` links the user's personal skills folder to this checkout; nothing copies a skill.
- Keep dependency manifests (`pyproject.toml`, `explorer/package.json`) in version control and their locks (`uv.lock`, `explorer/package-lock.json`) local and Git-ignored, because they capture each machine's configured feeds. Use normal `uv sync`, `uv run` and `npm install` with those feeds; do not commit a lock, force a public registry or bypass required feeds. Versions allowed by the manifests can differ across machines. If a future import brings its own npm lock, keep that lock version-controlled with its versions and integrity hashes, and record any registry-metadata sanitization in its provenance entry as a local patch.
- Prepare source releases from tracked files, not an archive of the whole working directory. Local locks, caches and runtime data may contain machine-specific feeds or private project data.
- Run `node tools/check.mjs` before a pull request; README.md describes the stages and how to keep new tests cheap.
- Do not change global Git identity, switch GitHub accounts, commit, or push unless requested. This checkout uses a repository-local personal identity.
