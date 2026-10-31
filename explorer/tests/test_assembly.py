"""Assembly-sequence exporter checks on a disposable peg-in-hole design."""

import hashlib
import importlib.util
import json
from pathlib import Path
import textwrap

import pytest

PYTHON_DIR = Path(__file__).resolve().parents[1] / "python"
spec = importlib.util.spec_from_file_location("prototype_assembly", PYTHON_DIR / "assembly.py")
assembly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembly)

from common.generator_module import load_generator  # noqa: E402  (the exporter put the cad skill on the path)
from common.geometry import GeometryError  # noqa: E402
from common.step_export import export_build123d_step_scene  # noqa: E402
from common.step_parts import load_step_parts  # noqa: E402

# A 40 mm block with a 10 mm blind hole, a flush 9.8 mm peg inside a labelled group, and a lid on top.
SOURCE = textwrap.dedent('''
    from build123d import Align, Box, Compound, Cylinder, Pos, Sphere

    PEG_RADIUS = {peg_radius}
    STEPS = {steps}

    def gen_step():
        base = Box(40, 40, 10, align=(Align.CENTER, Align.CENTER, Align.MIN)) - Pos(0, 0, 4) * Cylinder(
            5, 6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        base.label = "base"
        peg = Pos(0, 0, 4) * Cylinder(PEG_RADIUS, 6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        peg.label = "peg"
        lid = Pos(0, 0, 10) * Box(40, 40, 3, align=(Align.CENTER, Align.CENTER, Align.MIN))
        lid.label = "lid"
        pegs = Compound(children=[peg])
        pegs.label = "pegs"
        return Compound(children=[base, pegs, lid])

    def gen_assembly():
        stand_in = Pos(0, 0, 500) * Sphere(1)
        stand_in.label = "far_away_stand_in"
        return {{"steps": [dict(step, check_shapes={{"peg": stand_in}}) if step.pop("stand_in", False) else step for step in STEPS]}}
''')


@pytest.fixture(autouse=True)
def design_root(tmp_path, monkeypatch):
    # The exporter runs from the design root, as the cad tools do.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CAD_PILOT_CACHE", str(tmp_path / "cache"))
    return tmp_path


def _write(tmp_path, steps, peg_radius=4.9, source_text=SOURCE):
    source = tmp_path / "source" / "design.py"
    source.parent.mkdir(exist_ok=True)
    source.write_text(source_text.format(peg_radius=peg_radius, steps=repr(steps)), encoding="utf-8")
    step = tmp_path / "outputs" / "design.step"
    step.parent.mkdir(exist_ok=True)
    export_build123d_step_scene(load_generator(source).gen_step(), step)
    return source, step


def _document(tmp_path, steps, peg_radius=4.9, check=True):
    source, step = _write(tmp_path, steps, peg_radius)
    return assembly.build_document(source, step, check, 1.0), step


def _parts(tmp_path, root):
    step = tmp_path / "parts.step"
    export_build123d_step_scene(root, step)
    return load_step_parts(step, step.name).parts


def _occurrences(parts):
    return [part.name for part in parts]


def _statuses(document):
    return [(step["check"]["status"], next((contact["blocker"] for contact in step["check"]["contacts"]), None))
            for step in document["steps"]]


def test_groups_resolve_and_the_file_records_the_step_identity(tmp_path):
    steps = [{"title": "Drop in the peg", "parts": ["pegs"], "from": (0, 0, 20)},
             {"title": "Close the lid", "note": "Press flat", "parts": ["l?d"], "from": (0, 0, 30)}]
    document, step = _document(tmp_path, steps, check=False)
    assert document["format"] == "cad-explorer-assembly" and document["version"] == 1
    assert document["step"] == {"file": "design.step", "sha256": hashlib.sha256(step.read_bytes()).hexdigest()}
    assert [item["parts"] for item in document["steps"]] == [["pegs"], ["l?d"]]
    assert document["steps"][1]["note"] == "Press flat"
    assert document["source"] == "../source/design.py", "the generator is recorded relative to the sequence file"
    assert "check" not in document and all("check" not in item for item in document["steps"])
    assert assembly.sequence_path(step) == step.with_name("design.assembly.json")


def test_check_follows_the_order_and_direction_of_each_step(tmp_path):
    good = [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)}, {"title": "Lid", "parts": ["lid"], "from": (0, 0, 30)}]
    document, _ = _document(tmp_path, good)
    assert _statuses(document) == [("clear", None), ("clear", None)]
    assert document["check"]["sampleMm"] == 1.0 and "Rigid" in document["check"]["limits"]
    lid_first, _ = _document(tmp_path, list(reversed(good)))
    assert _statuses(lid_first) == [("clear", None), ("blocked", "lid")]
    sideways, _ = _document(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (20, 0, 0)}, good[1]])
    assert _statuses(sideways)[0] == ("blocked", "base")


def test_check_reports_installed_overlap_and_named_stand_ins(tmp_path):
    steps = [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)}, {"title": "Lid", "parts": ["lid"], "from": (0, 0, 30)}]
    oversize, _ = _document(tmp_path, steps, peg_radius=5.2)
    assert _statuses(oversize)[0] == ("interferes", "base")
    assert "when installed" in oversize["steps"][0]["check"]["detail"]
    stand_in, _ = _document(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (20, 0, 0), "stand_in": True}, steps[1]])
    assert _statuses(stand_in)[0] == ("clear", None)
    assert stand_in["steps"][0]["check"]["substitutes"] == ["peg checked as far_away_stand_in"]


@pytest.mark.parametrize(("steps", "message"), [
    ([{"title": "Peg", "parts": ["washer"], "from": (0, 0, 5)}], "unknown part"),
    ([{"title": "", "parts": ["peg"], "from": (0, 0, 5)}], "needs a title"),
    ([{"title": "Peg", "parts": ["peg"], "from": (0, 5)}], "three"),
    ([{"title": "Peg", "parts": ["peg"], "from": (0, 0, 5), "rotate": 90}], "unsupported"),
    ([{"title": "Peg", "parts": ["peg"], "from": ("10", "up", 0)}], "three numbers"),
    ([{"title": "Peg", "parts": ["p[e]g"], "from": (0, 0, 5)}], "unknown part"),
])
def test_sequence_errors_name_the_step(tmp_path, steps, message):
    with pytest.raises(assembly.SequenceError, match=message):
        _document(tmp_path, steps, check=False)


def test_command_writes_beside_the_step_and_summarizes(tmp_path, capsys):
    # The lid is not in a step, so it counts as already placed and blocks lifting the peg out.
    source, step = _write(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)}])
    # Paths are read as the cad tools read them: relative to the design root, with either separator.
    assert assembly.main(["source\\design.py", "--step", "outputs\\design.step", "--check", "--sample-mm", "2"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["check"][0]["status"] == "blocked" and "lid" in summary["check"][0]["detail"]
    assert json.loads(step.with_name("design.assembly.json").read_text(encoding="utf-8"))["steps"][0]["title"] == "Peg"
    assert assembly.main([str(source), "--step", str(tmp_path / "missing.step")]) == 2


def test_a_generator_without_gen_assembly_or_with_a_missing_import_is_a_plain_error(tmp_path, capsys):
    source, step = _write(tmp_path, [])
    source.write_text("def gen_step():\n    pass\n", encoding="utf-8")
    assert assembly.main([str(source), "--step", str(step)]) == 2
    assert "does not define gen_assembly()" in capsys.readouterr().err
    source.write_text("import no_such_module_here\n\ndef gen_assembly():\n    return {}\n", encoding="utf-8")
    assert assembly.main([str(source), "--step", str(step)]) == 2
    assert "imports 'no_such_module_here'" in capsys.readouterr().err


def test_a_project_module_beside_the_generator_is_importable(tmp_path):
    # The cad tools' loader: the generator's folder and the design root are importable, read afresh each time.
    source, step = _write(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)}])
    (tmp_path / "sequence_steps.py").write_text("STEPS = [{'title': 'Lid', 'parts': ['lid'], 'from': (0, 0, 30)}]\n", encoding="utf-8")
    source.write_text("from sequence_steps import STEPS\n\ndef gen_assembly():\n    return {'steps': STEPS}\n", encoding="utf-8")
    assert [item["parts"] for item in assembly.build_document(source, step, False, 1.0)["steps"]] == [["lid"]]


def test_a_failed_overlap_boolean_is_an_error_not_clear(tmp_path, monkeypatch):
    def failed(*shapes):
        raise GeometryError("intersection boolean did not complete")

    monkeypatch.setattr(assembly, "shared_volume", failed)
    document, _ = _document(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)},
                                       {"title": "Lid", "parts": ["lid"], "from": (0, 0, 30)}])
    assert [step["check"]["status"] for step in document["steps"]] == ["error", "error"]
    assert "intersection" in document["steps"][0]["check"]["detail"]


def test_a_path_that_reaches_a_part_after_a_gap_is_blocked(tmp_path):
    from build123d import Box, Compound, Pos

    # The box touches nothing where it is installed; its path meets the wall only after 46 mm.
    lone = Box(4, 4, 4)
    lone.label = "lone"
    wall = Pos(50, 0, 0) * Box(4, 40, 40)
    wall.label = "wall"
    # A plate thinner than a 10 mm sample spacing, between grid samples, is found from its interval's midpoint.
    plate = Pos(-35, 0, 0) * Box(0.2, 40, 40)
    plate.label = "plate"
    parts = _parts(tmp_path, Compound(children=[lone, wall, plate]))
    out = assembly.normalize_steps({"steps": [{"title": "Out", "parts": ["lone"], "from": (100, 0, 0)}]}, parts)
    result = assembly.check_steps(out, parts, 0.5)[0]
    assert (result["status"], result["contacts"][0]["blocker"]) == ("blocked", "wall")
    assert 46 <= result["contacts"][0]["atMm"] <= 48
    back = assembly.normalize_steps({"steps": [{"title": "Back", "parts": ["lone"], "from": (-100, 0, 0)}]}, parts)
    assert assembly.check_steps(back, parts, 10.0)[0]["contacts"][0]["blocker"] == "plate"


def test_check_shapes_must_be_shapes(tmp_path):
    source_text = SOURCE.replace("stand_in = Pos(0, 0, 500) * Sphere(1)", "stand_in = 'squeezed'").replace(
        'stand_in.label = "far_away_stand_in"', "")
    source, step = _write(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20), "stand_in": True}], source_text=source_text)
    with pytest.raises(assembly.SequenceError, match="build123d shapes"):
        assembly.build_document(source, step, False, 1.0)


def test_a_wildcard_never_matches_the_whole_assembly(tmp_path):
    from build123d import Box, Compound, Pos

    # "TMAT anchor *" was written for the anchor's parts; the top-level group "TMAT anchor v3" also fits it.
    base = Box(40, 40, 4)
    base.label = "TMAT base"
    plate = Pos(0, 0, 10) * Box(20, 20, 2)
    plate.label = "TMAT anchor plate"
    bolt = Pos(0, 0, 20) * Box(2, 2, 10)
    bolt.label = "TMAT anchor bolt"
    anchor = Compound(children=[plate, bolt])
    anchor.label = "anchor"
    root = Compound(children=[base, anchor])
    root.label = "TMAT anchor v3"
    parts = _parts(tmp_path, root)
    steps = assembly.normalize_steps({"steps": [{"title": "Anchor", "parts": ["TMAT anchor *"], "from": (0, 0, -30)}]}, parts)
    assert _occurrences(steps[0]["leaves"]) == ["TMAT anchor plate", "TMAT anchor bolt"]
    # Moving every part would leave nothing to collide with and so report clear; the anchor now meets the base.
    assert assembly.check_steps(steps, parts, 1.0)[0]["status"] == "blocked"
    with pytest.raises(assembly.SequenceError, match="matches only the whole assembly"):
        assembly.normalize_steps({"steps": [{"title": "All", "parts": ["TMAT*v3"], "from": (0, 0, 30)}]}, parts)


def test_unlabelled_parts_are_named_as_the_step_names_them(tmp_path):
    from build123d import Box, Compound, Pos

    # The STEP writer names an unlabelled part after its group, and CAD Explorer and `inspect parts` read that name.
    plate = Box(20, 20, 2)
    plate.label = "plate"
    bolt = Pos(0, 0, 5) * Box(2, 2, 8)
    kit = Compound(children=[plate, bolt])
    kit.label = "kit"
    parts = _parts(tmp_path, kit)
    steps = assembly.normalize_steps({"steps": [{"title": "Bolt", "parts": ["kit 2"], "from": (0, 0, 30)}]}, parts)
    assert _occurrences(steps[0]["leaves"]) == ["kit 2"]


def test_groups_count_occurrences_and_no_step_moves_every_part(tmp_path):
    from build123d import Box, Compound, Pos

    plate = Box(20, 20, 2)
    plate.label = "plate"
    bolt = Pos(0, 0, 5) * Box(2, 2, 8)
    bolt.label = "bolt"
    bracket = Compound(children=[plate, bolt])
    bracket.label = "Bracket"
    loose = Pos(30, 0, 0) * Box(2, 2, 8)
    loose.label = "bolt"
    parts = _parts(tmp_path, Compound(children=[bracket, loose]))
    # Bracket holds two of the three occurrences: it is not the whole assembly, and moving it leaves the loose bolt
    # placed, exactly as the viewer resolves it.
    steps = assembly.normalize_steps({"steps": [{"title": "Bracket", "parts": ["Bracket"], "from": (30, 0, 0)}]}, parts)
    assert _occurrences(steps[0]["leaves"]) == ["plate", "bolt"]
    result = assembly.check_steps(steps, parts, 1.0)[0]
    assert (result["status"], result["contacts"][0]["blocker"]) == ("blocked", "bolt"), "the loose bolt stays in the way"
    # A wildcard or shared prefix that resolves to every part would leave nothing to check against.
    for pattern in (["*"], ["plate", "b*"]):
        with pytest.raises(assembly.SequenceError, match="moves every part"):
            assembly.normalize_steps({"steps": [{"title": "All", "parts": pattern, "from": (0, 0, 30)}]}, parts)
