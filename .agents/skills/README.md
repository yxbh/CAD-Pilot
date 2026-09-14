# Workbench Skills

This workbench-owned README is the provenance registry for skills in this folder. Keep one entry per skill here, outside the imported skill's own files. Preserve upstream READMEs and licenses; do not replace or append provenance to them.

For imported instructions, prompts, and agent definitions, use the README at the corresponding collection folder, following the same convention. Record:

- Source repository URL and source path.
- Immutable commit or release revision and import date.
- License and preserved attribution/license-file location.
- Imported scope and a list of local modifications.
- A review and validation procedure for future updates.

Do not import unlicensed content, strip notices, copy an entire unrelated skill collection, or silently refresh from a moving branch. Record original authorship instead of a third-party source for customizations written in this repository.

The workbench's skills are discoverable here. External design projects need an explicit installation of the selected skills or another supported discovery mechanism; merely mentioning a path does not register a skill with an agent host.

## cad

- Origin: imported, not authored by CAD-Pilot.
- Entry point: [cad/SKILL.md](./cad/SKILL.md).
- Source repository: https://github.com/cedrickchee/text-to-cad
- Source revision: `2dd54cf8e27dc71c92244dc47271dcf10d302e16`
- Source directory: `.agents/skills/cad/`
- Imported: 2026-09-14.
- License: MIT; original notice retained in [cad/LICENSE](./cad/LICENSE).
- Upstream attribution: Thompson Labs. The source repository README identifies `earthtojake/text-to-cad` and `earthtojake/cad-skill` as upstream projects; this import is specifically from the available cedrickchee fork above.
- Scope: the CAD skill, supporting CLI packages, reference material, agent metadata, and CAD Explorer. Other top-level skills were not imported.
- Local changes: compatible security updates to `cad/explorer/package-lock.json` via `npm audit fix` on 2026-09-14; removal of the unsupported `--experimental-default-type=module` flag in `cad/explorer/package.json` for Node 24.12.0 compatibility. No upstream READMEs were modified. Python runtime dependencies are declared in CAD-Pilot's `pyproject.toml` and resolved separately in each machine's Git-ignored `uv.lock` using its configured feeds; exact Python dependency versions are not pinned across machines.

### Update Procedure

Review an explicit upstream commit, its license, and its diff against the pinned revision before updating. Preserve upstream documentation and notices. Record local patches in this entry, update revision/date, and regenerate dependency locks only as needed. Run workbench tests, upstream viewer tests/build, and a viewer smoke test. Upstream print defaults are not measured calibration or manufacturing certification.

## visual-review

- Origin: authored for CAD-Pilot, not imported.
- Entry point: [visual-review/SKILL.md](./visual-review/SKILL.md).
- Repository: https://github.com/yxbh/CAD-Pilot
- Created: 2026-09-14.
- Basis: the owner's difficulty describing CAD shapes and communicating by pointing, plus the documented CAD Explorer reference workflow.
- Reference: https://github.com/cedrickchee/text-to-cad at `2dd54cf8e27dc71c92244dc47271dcf10d302e16`.
- Third-party text/code copied into this skill: none.
- License: no additional license granted here; follows the repository's policy.
- Local changes: original visual-feedback workflow using existing project notes rather than a required review form. No third-party source modifications; record future imported material explicitly.

### Update Procedure

Validate changes using a real model, a selected reference or marked screenshot, and an ambiguous follow-up request. Distinguish documented viewer capabilities from interactions actually tested with the chosen agent host.

## fdm-design

- Origin: authored for CAD-Pilot, not imported.
- Entry point: [fdm-design/SKILL.md](./fdm-design/SKILL.md).
- Repository: https://github.com/yxbh/CAD-Pilot
- Created: 2026-09-14.
- Basis: engine-independent FDM/FFF design review and calibration discipline, informed by Prusa manufacturer guidance and evaluation of existing community skills.
- Sources: [Prusa modeling guidance](https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135), [Prusa first-layer compensation](https://help.prusa3d.com/article/elephant-foot-compensation_114487), [Prusa PETG guidance](https://help.prusa3d.com/article/petg_2059), [SPIROL inserts](https://www.spirol.com/product/threaded-inserts-for-plastics/), and [Formlabs snap-fits](https://formlabs.com/blog/designing-3d-printed-snap-fit-enclosures/), reviewed 2026-09-14. These mutable manufacturer pages are linked, not vendored. Applicability and limitations are recorded in the skill.
- Existing skills reviewed, not imported: [swh/openscad-skill](https://github.com/swh/openscad-skill/blob/8c6313f44ffcad340c818a50347ab464eb2f59d7/openscad-bosl2/SKILL.md), revision `8c6313f44ffcad340c818a50347ab464eb2f59d7`, path `openscad-bosl2/SKILL.md`; [andreahaku/openscad_claude_skill](https://github.com/andreahaku/openscad_claude_skill/blob/c47ef2359a3329da45c3c2e6caa3c286133c2844/SKILL.md), revision `c47ef2359a3329da45c3c2e6caa3c286133c2844`, path `SKILL.md`. Reviewed 2026-09-14; rejected as whole imports because of engine/platform coupling and fixed workflow/numeric defaults. Their licenses were not relied upon to redistribute anything; verify licensing before any future copy.
- Scope: original FDM guidance with source links. Uses existing equipment and project notes; no profile schema, calibration database, or agent-evaluation framework.
- Third-party text/code copied into this skill: none; original synthesis with links, not redistribution of vendor documents or community skill files.
- License: no additional license granted here; follows the repository's policy. Linked sources retain their own licenses/terms.
- Local changes: original synthesis with supplier references and lightweight print-result guidance. No third-party source modifications; no CAD engine, slicer, or printer-control integration added.

### Update Procedure

Check source applicability and dates before revising guidance. Preserve unknown versus provisional versus measured values, and never promote rules of thumb to universal limits. Run the skill metadata/provenance checks; use actual design and print feedback to identify guidance worth improving or removing. Static checks do not prove agent compliance or manufacturing results. Record any future imported text/code with an immutable revision and its license before copying it.