import json
import math
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
        if "- Origin: imported" in entry:
            for field in ("- Source repository:", "- Source revision:", "- Source directory:", "- Imported:"):
                assert field in entry
            assert re.search(r"- Source revision: `[0-9a-f]{40}`", entry)
    imported = collection / "cad"
    assert "2dd54cf8e27dc71c92244dc47271dcf10d302e16" in registry
    assert "cedrickchee/text-to-cad" in registry
    assert "MIT License" in (imported / "LICENSE").read_text(encoding="utf-8")


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
    built = subprocess.run(
        [
            sys.executable, str(scripts / "step"), "models/plate.py",
            "-o", step_path, "--stl", "plate.stl", "--3mf", "plate.3mf",
        ],
        cwd=project,
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