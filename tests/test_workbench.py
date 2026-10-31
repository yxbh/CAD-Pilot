import json
import math
import os
import re
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import trimesh
import yaml
from build123d import GeomType, export_step, export_stl, import_step

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "templates/project/source/mounting_plate.py"


def test_template_geometry_and_round_trip(tmp_path):
    plate = runpy.run_path(str(TEMPLATE))["gen_step"]()
    assert plate.is_valid
    assert len(plate.solids()) == 1
    assert tuple(plate.bounding_box().size) == pytest.approx((60, 40, 4))
    assert plate.volume == pytest.approx(60 * 40 * 4 - 2 * math.pi * 2.5**2 * 4)
    holes = plate.faces().filter_by(GeomType.CYLINDER)
    assert len(holes) == 2
    assert [face.radius for face in holes] == pytest.approx([2.5, 2.5])
    hole_centers = sorted(face.bounding_box().center().X for face in holes)
    assert hole_centers == pytest.approx([-20, 20])
    export_step(plate, tmp_path / "plate.step")
    restored = import_step(tmp_path / "plate.step")
    assert restored.is_valid
    assert restored.volume == pytest.approx(plate.volume)
    export_stl(restored, tmp_path / "plate.stl")
    mesh = trimesh.load_mesh(tmp_path / "plate.stl")
    assert mesh.is_watertight
    assert mesh.extents == pytest.approx([60, 40, 4])


def test_skills_have_metadata_and_provenance():
    collection = ROOT / ".agents/skills"
    skills = list(collection.glob("*/SKILL.md"))
    assert skills
    registry = (collection / "README.md").read_text(encoding="utf-8")
    headings = re.findall(r"^## ([a-z0-9-]+)$", registry, re.MULTILINE)
    assert len(headings) == len(set(headings))
    assert set(headings) == {skill.parent.name for skill in skills}
    for skill in skills:
        metadata = yaml.safe_load(skill.read_text(encoding="utf-8").split("---", 2)[1])
        assert metadata["name"] == skill.parent.name
        assert metadata["description"]
        assert len(metadata["description"]) <= 1024
        entry = registry.split(f"\n## {skill.parent.name}\n", 1)[1].split("\n## ", 1)[0]
        for field in ("- Origin:", "- License:", "- Local changes:", "### Update Procedure"):
            assert field in entry
        origin = re.search(r"^- Origin: (.+)$", entry, re.MULTILINE).group(1)
        if origin.startswith(("imported", "first-party fork")):
            for field in ("- Source repository:", "- Source revision:", "- Source directory:", "- Imported:"):
                assert field in entry
            assert re.search(r"- Source revision: `[0-9a-f]{40}`", entry)
        if origin.startswith("first-party fork"):
            assert "- Forked:" in entry
    cad = registry.split("\n## cad\n", 1)[1].split("\n## ", 1)[0]
    assert "- Origin: first-party fork" in cad
    assert "2dd54cf8e27dc71c92244dc47271dcf10d302e16" in cad
    assert "cedrickchee/text-to-cad" in cad
    assert "Thompson Labs" in cad
    assert "MIT License" in (collection / "cad/LICENSE").read_text(encoding="utf-8")


SKILLS = ROOT / ".agents/skills"
GUIDANCE = [
    ROOT / "AGENTS.md",
    ROOT / "README.md",
    *sorted((ROOT / "templates/project").glob("*.md")),
    *sorted(SKILLS.rglob("*.md")),
]

# Each rule is stated once, in the file that owns it, and linked from the others. The markers are phrases that a
# statement of the rule uses, so they must appear in its home and nowhere else in the guidance. The Explorer's README
# is the viewer's reference manual, not guidance, and may describe the behaviour these rules rely on.
RULE_HOMES = {
    "showing a model": (
        SKILLS / "visual-review/SKILL.md",
        ["`cad-explorer` canvas", "`projectRoot`", "run the same `open` again", "only viewer"],
    ),
    "assembly steps": (SKILLS / "visual-review/SKILL.md", ["gen_assembly()", "explorer/python/assembly.py", "geometric screen"]),
    "reference systems": (SKILLS / "visual-review/SKILL.md", ["cad_explorer_inspect", "never mix", "belongs to the revision"]),
    "finding the workbench": (SKILLS / "cad/SKILL.md", ["three levels above"]),
    "running the tools": (SKILLS / "cad/SKILL.md", ["sys.prefix", "relative to the STEP's folder"]),
    "unknowns": (SKILLS / "cad/SKILL.md", ["unknown until the user confirms"]),
    "feature preservation": (SKILLS / "cad/SKILL.md", ["Never shrink, drop or approximate"]),
    "evidence": (SKILLS / "cad/SKILL.md", ["Keep kinds of evidence apart", "has no verdict"]),
    "approval to print or publish": (SKILLS / "cad/SKILL.md", ["G-code"]),
    "fresh selectors": (SKILLS / "cad/references/inspection-and-validation.md", ["never reuse or translate a saved `@cad` path"]),
    "print handoff": (SKILLS / "cad/references/print.md", ["print-profile.json", "3MF path every time"]),
    "fit rule": (SKILLS / "fdm-design/SKILL.md", ["The model states the fit"]),
    "dependency locks": (ROOT / "AGENTS.md", ["uv.lock", "package-lock.json"]),
}


@pytest.mark.parametrize("rule", RULE_HOMES)
def test_each_rule_is_stated_in_its_home_only(rule):
    home, markers = RULE_HOMES[rule]
    for document in GUIDANCE:
        text = document.read_text(encoding="utf-8")
        for marker in markers:
            if document == home:
                assert marker in text, f"{document}: the {rule} rule no longer says {marker!r}"
            else:
                assert marker not in text, f"{document}: restates the {rule} rule ({marker!r}); link to {home.name}"


def _anchor(heading):
    return re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")


def test_guidance_links_resolve():
    for document in [*GUIDANCE, ROOT / "explorer/README.md"]:
        text = re.sub(r"```.*?```", "", document.read_text(encoding="utf-8"), flags=re.DOTALL)
        for target in re.findall(r"\]\(([^)\s]+)\)", text):
            if re.match(r"[a-z]+:", target):
                continue
            path, _, anchor = target.partition("#")
            linked = (document.parent / path).resolve() if path else document
            assert linked.exists(), f"{document}: broken link {target}"
            if document.parent != SKILLS and document.is_relative_to(SKILLS):
                # A skill loaded through ~/.claude/skills/<name> sees only its sibling skills there.
                assert linked.is_relative_to(SKILLS), f"{document}: {target} leaves the skills folder"
            if anchor and linked.suffix == ".md":
                headings = re.findall(r"^#+ (.+)$", linked.read_text(encoding="utf-8"), re.MULTILINE)
                assert anchor in {_anchor(heading) for heading in headings}, f"{document}: no heading for {target}"


def test_viewer_guidance_keeps_its_boundaries():
    skill = (SKILLS / "visual-review/SKILL.md").read_text(encoding="utf-8")
    for required in ("when it is available", "cadproto:v2", "@cad[", "scripts/inspect", "set_step", "`capture [", "`render <file>"):
        assert required in skill
    assert "do not insert or send chat messages" in skill
    assert "separate VS Code extension" in skill
    cad = SKILLS / "cad"
    assert not (cad / "explorer/package.json").exists()
    assert not (cad / "scripts/render/cli.py").exists()
    assert "visual-review" in (cad / "SKILL.md").read_text(encoding="utf-8")
    for document in [*GUIDANCE, cad / "agents/openai.yaml"]:
        text = document.read_text(encoding="utf-8")
        retired_terms = ("imported browser", "imported viewer", "imported inspector", "ensure-dev", "dev:ensure", "EXPLORER_ROOT_DIR", "127.0.0.1:4178")
        for retired in retired_terms:
            assert retired not in text, f"{document}: still routes to the removed viewer ({retired})"
        if document.is_relative_to(cad):
            for retired in ("scripts/render", "npm --prefix explorer"):
                assert retired not in text, f"{document}: still routes to the removed viewer ({retired})"


def test_dependency_locks_stay_local():
    assert "/uv.lock" in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "/package-lock.json" in (ROOT / "explorer/.gitignore").read_text(encoding="utf-8").splitlines()
    assert (ROOT / "pyproject.toml").is_file() and (ROOT / "explorer/package.json").is_file()
    assert "Git-ignored" in (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    for document in (ROOT / "README.md", ROOT / "explorer/README.md"):
        commands = "\n".join(re.findall(r"```powershell\n(.*?)```", document.read_text(encoding="utf-8"), re.DOTALL))
        assert "npm install" in commands
        assert not re.search(r"^\s*npm ci\s*$", commands, re.MULTILINE)


def _skill_names():
    return sorted(skill.parent.name for skill in SKILLS.glob("*/SKILL.md"))


def test_claude_code_finds_each_skill_through_one_link():
    links = ROOT / ".claude/skills"
    assert sorted(entry.name for entry in links.iterdir()) == _skill_names()
    for name in _skill_names():
        link = links / name
        # A checkout without symlink support writes the link's target as a text file.
        target = os.readlink(link) if os.path.islink(link) else link.read_text(encoding="utf-8")
        assert target.replace("\\", "/") == f"../../.agents/skills/{name}"
        if os.path.islink(link):
            assert (link / "SKILL.md").is_file()


def _link_folder(target, link):
    if os.name == "nt":  # a junction, as the installer makes, needs no symlink privilege
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def _unlink_folder(link):
    os.rmdir(link) if os.name == "nt" else os.unlink(link)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js runs the installer")
def test_install_links_the_personal_skills_folder(tmp_path):
    skills = tmp_path / "skills"

    def install():
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(tmp_path)}
        command = [shutil.which("node"), str(ROOT / "tools/install-skills.mjs")]
        return subprocess.run(command, env=env, capture_output=True, text=True, timeout=60, check=False)

    def linked(name):
        return Path(os.path.realpath(skills / name)) == Path(os.path.realpath(SKILLS / name))

    # A link to another checkout's copy of the skill is replaced, on the first run and the second.
    other_checkout = tmp_path / "other/.agents/skills/cad"
    other_checkout.mkdir(parents=True)
    skills.mkdir()
    _link_folder(other_checkout, skills / "cad")
    for _ in range(2):
        result = install()
        assert result.returncode == 0, result.stderr
        assert all(linked(name) for name in _skill_names())

    # Anything else with a skill's name is refused and kept, and the other skills are still linked.
    own = tmp_path / "my-cad"
    own.mkdir()
    _unlink_folder(skills / "cad")
    _link_folder(own, skills / "cad")
    result = install()
    assert result.returncode == 1 and "not a link to a CAD-Pilot skill" in result.stderr
    assert Path(os.path.realpath(skills / "cad")) == Path(os.path.realpath(own))
    _unlink_folder(skills / "cad")
    (skills / "cad").mkdir()
    (skills / "cad/notes.md").write_text("mine", encoding="utf-8")
    result = install()
    assert result.returncode == 1
    assert (skills / "cad/notes.md").read_text(encoding="utf-8") == "mine"
    assert all(linked(name) for name in _skill_names() if name != "cad")


@pytest.mark.parametrize("output_directory", ["outputs", "artifacts/print files", "."])
def test_cli_exports_reopen(tmp_path, output_directory):
    project = tmp_path / "existing design"
    model_directory = project / "models"
    model_directory.mkdir(parents=True)
    source = model_directory / "plate.py"
    shutil.copy2(TEMPLATE, source)
    original = source.read_bytes()
    destination = project / output_directory
    destination.mkdir(parents=True, exist_ok=True)
    step_path = (Path(output_directory) / "plate.step").as_posix()
    scripts = ROOT / ".agents/skills/cad/scripts"
    env = {**os.environ, "CAD_PILOT_CACHE": str(tmp_path / "cache")}
    built = subprocess.run(
        [
            sys.executable, str(scripts / "step"), "models/plate.py",
            "-o", step_path, "--stl", "plate.stl", "--3mf", "plate.3mf",
        ],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert built.returncode == 0, built.stderr
    inspected = subprocess.run(
        [
            sys.executable, str(scripts / "inspect"), "refs", step_path,
            "--facts", "--planes", "--positioning",
        ],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert inspected.returncode == 0, inspected.stderr
    report = json.loads(inspected.stdout)
    assert report["ok"] is True
    assert report["tokens"][0]["entryFacts"]["size"] == pytest.approx([60, 40, 4])
    restored = import_step(destination / "plate.step")
    assert restored.is_valid
    assert len(restored.solids()) == 1
    for suffix in ("stl", "3mf"):
        mesh = trimesh.load_scene(destination / f"plate.{suffix}").to_mesh()
        assert mesh.is_watertight
        assert mesh.extents == pytest.approx([60, 40, 4])
    assert source.read_bytes() == original
    for unwanted in ("source", "reviews", "AGENTS.md", "brief.md", ".cad-pilot.local.json"):
        assert not (project / unwanted).exists()
    if output_directory != "outputs":
        assert not (project / "outputs").exists()