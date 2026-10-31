"""Assembly-sequence exporter checks on a disposable peg-in-hole design."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
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


def test_a_path_that_reaches_a_part_after_a_gap_is_blocked():
    from build123d import Box, Compound, Pos

    # The box touches nothing where it is installed; its path meets the wall only after 46 mm.
    lone = Box(4, 4, 4)
    lone.label = "lone"
    wall = Pos(50, 0, 0) * Box(4, 40, 40)
    wall.label = "wall"
    # A plate thinner than a 10 mm sample spacing, between grid samples, is found from its interval's midpoint.
    plate = Pos(-35, 0, 0) * Box(0.2, 40, 40)
    plate.label = "plate"
    leaves, groups = assembly.labelled_parts(Compound(children=[lone, wall, plate]))
    out = assembly.normalize_steps({"steps": [{"title": "Out", "parts": ["lone"], "from": (100, 0, 0)}]}, groups)
    result = assembly.check_steps(out, leaves, 0.5)[0]
    assert (result["status"], result["contacts"][0]["blocker"]) == ("blocked", "wall")
    assert 46 <= result["contacts"][0]["atMm"] <= 48
    back = assembly.normalize_steps({"steps": [{"title": "Back", "parts": ["lone"], "from": (-100, 0, 0)}]}, groups)
    assert assembly.check_steps(back, leaves, 10.0)[0]["contacts"][0]["blocker"] == "plate"


def test_check_shapes_must_be_shapes(tmp_path):
    source = SOURCE.replace("stand_in = Pos(0, 0, 500) * Sphere(1)", "stand_in = 'squeezed'").replace(
        'stand_in.label = "far_away_stand_in"', "")
    (tmp_path / "source").mkdir()
    (tmp_path / "source" / "design.py").write_text(source.format(
        peg_radius=4.9, steps=repr([{"title": "Peg", "parts": ["peg"], "from": (0, 0, 20), "stand_in": True}])), encoding="utf-8")
    step = tmp_path / "design.step"
    step.write_text("ISO-10303-21; END-ISO-10303-21;", encoding="utf-8")
    with pytest.raises(assembly.SequenceError, match="build123d shapes"):
        assembly.build_document(tmp_path / "source" / "design.py", step, False, 1.0)


def test_an_edit_of_the_same_length_within_a_second_is_read(tmp_path, monkeypatch):
    # A cached .pyc is matched on whole-second mtime and size, so loading must not reuse one.
    monkeypatch.setattr(sys, "dont_write_bytecode", False)
    source = tmp_path / "design.py"
    for value in ("first", "later"):
        source.write_text(f"def gen_step():\n    return {value!r}\n\ndef gen_assembly():\n    return {{}}\n", encoding="utf-8")
        os.utime(source, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        assert assembly._load_source(source).gen_step() == value


@pytest.mark.parametrize("future", ["", "from __future__ import annotations\n"])
def test_designs_load_as_their_own_module(tmp_path, future):
    # The loader's own __future__ imports stay out of the design, and dataclasses can find the design's module.
    source = tmp_path / "design.py"
    source.write_text(future + textwrap.dedent('''
        from dataclasses import dataclass

        @dataclass
        class Params:
            width: float = 10.0

        def gen_step():
            return Params().width

        def gen_assembly():
            return {"steps": []}
    '''), encoding="utf-8")
    module = assembly._load_source(source)
    assert module.gen_step() == 10.0
    assert ("annotations" in module.__dict__) == bool(future)


def test_a_wildcard_never_matches_the_whole_assembly():
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
    leaves, groups = assembly.labelled_parts(root)
    assert assembly.match_parts(["TMAT anchor *"], groups) == (["TMAT anchor plate", "TMAT anchor bolt"], [])
    assert assembly.match_parts(["anchor"], groups) == (["TMAT anchor plate", "TMAT anchor bolt"], []), "a real subgroup still matches"
    assert assembly.match_parts(["TMAT anchor v?"], groups) == ([], ["TMAT anchor v? (it matches only the whole assembly)"])
    steps = assembly.normalize_steps({"steps": [{"title": "Anchor", "parts": ["TMAT anchor *"], "from": (0, 0, -30)}]}, groups)
    # Moving every part would leave nothing to collide with and so report clear; the anchor now meets the base.
    assert assembly.check_steps(steps, leaves, 1.0)[0]["status"] == "blocked"
    with pytest.raises(assembly.SequenceError, match="matches only the whole assembly"):
        assembly.normalize_steps({"steps": [{"title": "All", "parts": ["TMAT*v3"], "from": (0, 0, 30)}]}, groups)
    # A single-part model can still name its only part.
    lone = Box(4, 4, 4)
    lone.label = "lone"
    assert assembly.match_parts(["lone"], assembly.labelled_parts(Compound(children=[lone]))[1]) == (["lone"], [])
