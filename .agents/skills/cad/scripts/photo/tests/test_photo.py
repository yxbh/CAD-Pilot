import json
import os
from pathlib import Path

import numpy as np
import pytest
import trimesh
from PIL import Image

from photo.cli import BLENDER_ENV, RENDERED, BlenderError, locate_blender, main, stage
from photo.scene import PartSpec, SceneError, load_scene, parse_scene, posed, print_direction
from print.meshes import load_mesh


def _scene(data, tmp_path):
    return parse_scene(data, base=tmp_path, default_output=tmp_path / "scene.png")


def _box(path: Path, size=(30.0, 20.0, 10.0)) -> Path:
    trimesh.creation.box(extents=size).export(path)
    return path


def test_layers_stack_along_the_beds_z_as_the_part_was_printed_then_posed():
    # Printed as modelled, standing as modelled: layers stack straight up.
    assert print_direction(PartSpec(Path("a.stl"), "a", "#FFFFFF")) == pytest.approx([0, 0, 1])
    # Printed leaned 45 degrees about Y: the bed's Z is the model's (-sin 45, 0, cos 45).
    leaned = PartSpec(Path("a.stl"), "a", "#FFFFFF", printed=(0, 45, 0))
    assert print_direction(leaned) == pytest.approx([-(0.5**0.5), 0, 0.5**0.5])
    # A turn about Z on the bed does not change which way the layers stack in the part.
    assert print_direction(PartSpec(Path("a.stl"), "a", "#FFFFFF", printed=(0, 45, 140))) == pytest.approx(print_direction(leaned))
    # Shown upside down, the layers turn over with the part.
    assert print_direction(PartSpec(Path("a.stl"), "a", "#FFFFFF", printed=(0, 45, 0), rotate=(180, 0, 0))) == pytest.approx([-(0.5**0.5), 0, -(0.5**0.5)])
    # Shown the way it was printed, they stack straight up again.
    assert print_direction(PartSpec(Path("a.stl"), "a", "#FFFFFF", printed=(90, 0, 30), rotate=(90, 0, 30))) == pytest.approx([0, 0, 1])


def test_a_part_stands_on_the_floor_unless_the_scene_gives_its_height():
    corners = np.array([[-15.0, -10.0, -5.0], [15.0, 10.0, 5.0]])
    on_floor = posed(corners, PartSpec(Path("a.stl"), "a", "#FFFFFF", at=(100.0, 50.0)))
    assert on_floor.min(axis=0) == pytest.approx([85, 40, 0])
    held = posed(corners, PartSpec(Path("a.stl"), "a", "#FFFFFF", rotate=(0, 0, 90), at=(100.0, 50.0, 20.0)))
    assert held.min(axis=0) == pytest.approx([90, 35, 15]) and held.max(axis=0) == pytest.approx([110, 65, 25])


def test_a_scene_reads_its_parts_and_settings(tmp_path):
    scene = _scene(
        {"output": "out/cover.png", "view": [40, 30], "size": [800, 600], "samples": 32, "backdrop": "#2b333f", "layer_height": 0.24, "fill": 0.5,
         "parts": [{"file": "parts\\elbow.step", "colour": "#688197", "printed": [0, 45, 0], "rotate": [180, 0, 0], "at": [10, 20]}, {"file": "base.STL"}]},
        tmp_path,
    )
    elbow, base = scene.parts
    assert elbow.file == (tmp_path / "parts" / "elbow.step").resolve() and elbow.name == "elbow" and elbow.at == (10.0, 20.0)
    assert (base.colour, base.printed, base.rotate, base.at) == ("#70757A", (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 0.0))
    assert scene.output == (tmp_path / "out" / "cover.png").resolve()
    assert (scene.view, scene.size, scene.samples, scene.backdrop, scene.layer_height, scene.fill) == ((40.0, 30.0), (800, 600), 32, "#2B333F", 0.24, 0.5)
    assert _scene({"parts": [{"file": "a.stl"}]}, tmp_path).output == tmp_path / "scene.png"


@pytest.mark.parametrize(
    "data, message",
    [
        ({"parts": []}, "non-empty list"),
        ({"parts": [{"file": "a.obj"}]}, "STEP, STP or STL"),
        ({"parts": [{"file": "/abs/a.step"}]}, "relative to the scene file"),
        ({"parts": [{"file": "a.step", "colour": "blue"}]}, "colour must be #RRGGBB"),
        ({"parts": [{"file": "a.step", "printed": [0, 45]}]}, "printed must be the print job's rotate"),
        ({"parts": [{"file": "a.step", "at": [1]}]}, r"at must be \[x, y\] to stand the part on the floor"),
        ({"parts": [{"file": "a.step", "orientation": "up"}]}, "unknown key"),
        ({"parts": [{"file": "a.step"}], "output": "a.jpg"}, ".png"),
        ({"parts": [{"file": "a.step"}], "size": [0, 600]}, r"size must be \[width, height\]"),
        ({"parts": [{"file": "a.step"}], "view": [28, -20]}, "the elevation from 0"),
        ({"parts": [{"file": "a.step", "at": [float("nan"), 0]}]}, "at must be"),
        ({"parts": [{"file": "a.step", "rotate": [float("inf"), 0, 0]}]}, "rotate must be"),
        ({"parts": [{"file": "a.step"}], "samples": 0}, "samples"),
        ({"parts": [{"file": "a.step"}], "layer_height": 2}, "layer_height must be the print's layer height"),
        ({"parts": [{"file": "a.step"}], "lens": 50}, "unknown key"),
    ],
)
def test_scene_errors_name_the_problem(tmp_path, data, message):
    with pytest.raises(SceneError, match=message):
        _scene(data, tmp_path)


def test_staging_writes_each_part_posed_with_its_layer_direction(tmp_path):
    _box(tmp_path / "block.stl")
    scene = _scene({"parts": [{"file": "block.stl", "name": "Block", "colour": "#ff671f", "printed": [90, 0, 0], "at": [100, 0]}]}, tmp_path)
    folder = tmp_path / "staged"
    folder.mkdir()
    description = json.loads(stage(scene, folder).read_text())
    (part,) = description["parts"]
    assert (part["name"], part["colour"]) == ("Block", "#FF671F") and part["print_direction"] == pytest.approx([0, 1, 0])
    mesh = trimesh.load_mesh(folder / part["mesh"])
    assert mesh.bounds[0] == pytest.approx([85, -10, 0]) and mesh.bounds[1] == pytest.approx([115, 10, 10])
    # Blender renders into the staging folder; the scene's own output path never reaches it.
    assert description["output"] == str(folder / RENDERED) and description["layer_height"] == 0.2


def test_blender_is_found_where_it_is_configured_or_reported_missing(tmp_path, monkeypatch):
    program = tmp_path / "blender"
    program.write_text("")
    monkeypatch.setenv(BLENDER_ENV, str(program))
    assert locate_blender() == program.resolve()
    app = tmp_path / "Blender.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "MacOS" / "Blender").write_text("")
    monkeypatch.setenv(BLENDER_ENV, str(app))
    assert locate_blender() == (app / "Contents" / "MacOS" / "Blender").resolve()
    monkeypatch.setenv(BLENDER_ENV, str(tmp_path / "nowhere"))
    with pytest.raises(BlenderError, match=f"Blender not found .*set the {BLENDER_ENV} environment variable"):
        locate_blender()


def _stand_in(folder: Path) -> Path:
    """A program in Blender's place that says it failed and writes no picture, on any system."""
    if os.name == "nt":
        program = folder / "blender.cmd"
        program.write_text("@echo Error: no picture today\r\n@exit /b 0\r\n")
    else:
        program = folder / "blender"
        program.write_text("#!/bin/sh\necho Error: no picture today\nexit 0\n")
        program.chmod(0o755)
    return program


def test_a_scene_file_names_its_picture_and_the_command_line_overrides_it(tmp_path, monkeypatch, capsys):
    _box(tmp_path / "block.stl")
    (tmp_path / "cover.photo.json").write_text(json.dumps({"parts": [{"file": "block.stl"}]}))
    assert load_scene(tmp_path / "cover.photo.json").output == tmp_path / "cover.png"
    # A stand-in for Blender that renders nothing: the run is reported as failed, and nothing is written.
    monkeypatch.setenv(BLENDER_ENV, str(_stand_in(tmp_path)))
    assert main([str(tmp_path / "cover.photo.json"), "-o", str(tmp_path / "drafts" / "small.png"), "--size", "320x240", "--samples", "4", "--view", "40:20"]) == 2
    assert "error: Blender did not render the picture:\nError: no picture today" in capsys.readouterr().err
    assert not (tmp_path / "drafts" / "small.png").exists() and not (tmp_path / "cover.png").exists()
    for flags, message in ((["--size", "0x0"], "size must be"), (["--view", "28:-20"], "the elevation from 0"), (["--samples", "0"], "samples must be"), (["-o", "a.jpg"], "must be a .png")):
        assert main([str(tmp_path / "cover.photo.json"), *flags]) == 2
        assert message in capsys.readouterr().err


def test_a_step_part_is_staged_from_its_solids(tmp_path):
    from build123d import Box, export_step

    export_step(Box(30, 20, 10), str(tmp_path / "block.step"))
    scene = _scene({"parts": [{"file": "block.step", "rotate": [0, 0, 90]}]}, tmp_path)
    folder = tmp_path / "staged"
    folder.mkdir()
    (part,) = json.loads(stage(scene, folder).read_text())["parts"]
    bounds = trimesh.load_mesh(folder / part["mesh"]).bounds
    assert bounds[0] == pytest.approx([-10, -15, 0], abs=1e-6) and bounds[1] == pytest.approx([10, 15, 10], abs=1e-6)
    assert len(load_mesh(tmp_path / "block.step").faces) == 12


def test_the_reference_example_is_a_scene(tmp_path):
    reference = (Path(__file__).resolve().parents[3] / "references" / "photo.md").read_text(encoding="utf-8")
    example = reference.split("```json")[1].split("```")[0]
    scene = _scene(json.loads(example), tmp_path)
    assert [part.name for part in scene.parts] == ["frame", "bracket", "Post, seated"] and scene.parts[2].at == (0.0, 0.0, 12.0)


def _installed() -> bool:
    try:
        locate_blender()
    except BlenderError:
        return False
    return True


@pytest.mark.skipif(not _installed(), reason="Blender is not installed")
@pytest.mark.parametrize("size", [(60.0, 40.0, 30.0), (10.0, 10.0, 120.0)])
def test_a_scene_renders_to_a_picture_of_the_part_in_its_colour(tmp_path, capsys, size):
    _box(tmp_path / "block.stl", size)
    # A folder name Blender would read as a path template, were it given the output's path.
    scene = {"output": "out {x}/block.png", "size": [160, 120], "samples": 8, "parts": [{"file": "block.stl", "colour": "#D6001C"}]}
    (tmp_path / "block.photo.json").write_text(json.dumps(scene))
    assert main([str(tmp_path / "block.photo.json")]) == 0
    output = tmp_path / "out {x}" / "block.png"
    assert f"Photo: {output}" in capsys.readouterr().out
    picture = np.asarray(Image.open(output).convert("RGB")).astype(int)
    assert picture.shape == (120, 160, 3)
    red = (picture[..., 0] > picture[..., 1] + 60) & (picture[..., 0] > picture[..., 2] + 60)
    rows, columns = np.where(red.any(axis=1))[0], np.where(red.any(axis=0))[0]
    # The whole part is in the frame, taking most of its height (fill 0.8), on a neutral backdrop lit to its edges.
    assert 4 <= rows.min() and rows.max() <= 115 and 4 <= columns.min() and columns.max() <= 155
    assert 60 <= rows.max() - rows.min() <= 105
    corners = picture[[2, 2, -3, -3], [2, -3, 2, -3]]
    assert corners.min() > 90 and (corners.max(axis=1) - corners.min(axis=1)).max() < 25


def test_a_missing_part_is_an_error_not_a_crash(tmp_path, capsys, monkeypatch):
    # Reported whether or not Blender is installed.
    monkeypatch.setenv(BLENDER_ENV, str(tmp_path / "nowhere"))
    (tmp_path / "s.photo.json").write_text(json.dumps({"parts": [{"file": "gone.stl"}]}))
    assert main([str(tmp_path / "s.photo.json")]) == 2
    assert "error: Part file not found" in capsys.readouterr().err
