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


def _document(tmp_path, steps, peg_radius=4.9, check=True):
    source = tmp_path / "source" / "design.py"
    source.parent.mkdir(exist_ok=True)
    source.write_text(SOURCE.format(peg_radius=peg_radius, steps=repr(steps)), encoding="utf-8")
    step = tmp_path / "outputs" / "design.step"
    step.parent.mkdir(exist_ok=True)
    step.write_text("ISO-10303-21; stand-in bytes for the identity hash; END-ISO-10303-21;", encoding="utf-8")
    return assembly.build_document(source, step, check, 1.0), step


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
])
def test_sequence_errors_name_the_step(tmp_path, steps, message):
    with pytest.raises(assembly.SequenceError, match=message):
        _document(tmp_path, steps, check=False)


def test_command_writes_beside_the_step_and_summarizes(tmp_path, capsys):
    # The lid is not in a step, so it counts as already placed and blocks lifting the peg out.
    steps = [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)}]
    _, step = _document(tmp_path, steps, check=False)
    assert assembly.main([str(tmp_path / "source" / "design.py"), "--step", str(step), "--check", "--sample-mm", "2"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["check"][0]["status"] == "blocked" and "lid" in summary["check"][0]["detail"]
    assert json.loads(step.with_name("design.assembly.json").read_text(encoding="utf-8"))["steps"][0]["title"] == "Peg"
    assert assembly.main([str(tmp_path / "source" / "design.py"), "--step", str(tmp_path / "missing.step")]) == 2


def test_a_failed_overlap_boolean_is_an_error_not_clear(tmp_path, monkeypatch):
    class FailedCommon:
        def __init__(self, *shapes):
            pass

        def IsDone(self):
            return False

    monkeypatch.setattr(assembly, "BRepAlgoAPI_Common", FailedCommon)
    document, _ = _document(tmp_path, [{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20)},
                                       {"title": "Lid", "parts": ["lid"], "from": (0, 0, 30)}])
    assert [step["check"]["status"] for step in document["steps"]] == ["error", "error"]
    assert "intersection" in document["steps"][0]["check"]["detail"]
