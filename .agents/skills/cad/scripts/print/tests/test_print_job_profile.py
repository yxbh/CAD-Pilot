import argparse
import json

import pytest

from print.cli import _path
from print.compensation import part_compensation
from print.job import JobError, load_job, parse_job
from print.profile import ProfileError, load_profile, parse_profile, record_compensation


PROFILE = {
    "printer": "Bambu Lab H2D 0.4 nozzle",
    "process": "0.20mm Standard @BBL H2D",
    "bed_type": "High Temp Plate",
    "filament": "PETG",
    "filaments": {
        "PETG": {"preset": "Bambu PETG Basic @BBL H2D 0.4 nozzle", "colour": "#9e9e9e"},
        "PLA": {"preset": "Bambu PLA Basic @BBL H2D", "colour": "#FFFFFF"},
    },
    "support": {"type": "tree(auto)", "interface_filament": "PLA"},
    "process_settings": {"resolution": "0.003"},
}


H2D = PROFILE["printer"]
PETG = PROFILE["filaments"]["PETG"]
MEASURED = {"mm": 0.1, "measured": "2026-10-31", "resolution": 0.003, "slice_closing_radius": 0.01}
NOW = {"resolution": 0.003, "slice_closing_radius": 0.01}


def test_compensation_is_measured_per_printer_and_filament():
    elsewhere = {"Bambu Lab X1 Carbon 0.4 nozzle": {"hole": {**MEASURED, "mm": 0.2}}}
    profile = parse_profile({**PROFILE, "filaments": {**PROFILE["filaments"], "PETG": {**PETG, "compensation": {H2D: {"hole": MEASURED}, **elsewhere}}}})
    assert profile.measured("PETG")["hole"].mm == 0.1 and "contour" not in profile.measured("PETG")
    assert profile.measured("PLA") == {}
    assert profile.as_dict()["filaments"]["PETG"]["compensation"][H2D]["hole"] == MEASURED
    hole, contour = part_compensation(profile, "PETG", NOW, calibrating=False)
    assert (hole.setting, hole.mm, hole.measurement.measured, hole.changed) == ("xy_hole_compensation", 0.1, "2026-10-31", {})
    assert (contour.setting, contour.mm, contour.measurement) == ("xy_contour_compensation", 0.0, None)
    # A calibration coupon prints at 0 whatever was measured.
    assert [(c.mm, c.measurement) for c in part_compensation(profile, "PETG", NOW, calibrating=True)] == [(0.0, None), (0.0, None)]
    # At another resolution the measured value is still used, and the change is named.
    (hole, _) = part_compensation(profile, "PETG", {**NOW, "resolution": 0.012}, calibrating=False)
    assert hole.mm == 0.1 and hole.changed == {"resolution": (0.003, 0.012)}


def test_saving_compensation_changes_only_that_filament_on_that_printer(tmp_path):
    from print.profile import Measurement

    path = tmp_path / "print-profile.json"
    path.write_text(json.dumps({**PROFILE, "filaments": {**PROFILE["filaments"], "PETG": {**PETG, "compensation": {H2D: {"contour": MEASURED}}}}}))
    hole = Measurement(0.15, "2026-11-02", 0.003, 0.01)
    before = path.read_text()
    assert record_compensation("PETG", H2D, {"hole": hole}, write=False, path=path).measured("PETG")["hole"] == hole
    assert path.read_text() == before
    with pytest.raises(ProfileError, match="under 1 mm"):
        record_compensation("PETG", H2D, {"hole": Measurement(10, "2026-11-02", 0.003, 0.01)}, write=False, path=path)
    profile = record_compensation("PETG", H2D, {"hole": hole}, write=True, path=path)
    assert profile.measured("PETG") == {"contour": profile.measured("PETG")["contour"], "hole": hole}
    written = json.loads(path.read_text())
    assert written["filaments"]["PETG"]["compensation"][H2D] == {"contour": MEASURED, "hole": hole.as_dict()}
    assert {key: value for key, value in written.items() if key != "filaments"} == {key: value for key, value in PROFILE.items() if key != "filaments"}
    assert written["filaments"]["PLA"] == PROFILE["filaments"]["PLA"]
    with pytest.raises(ProfileError, match="no filament 'ABS'"):
        record_compensation("ABS", H2D, {"hole": hole}, write=True, path=path)


def test_profile_reads_and_project_overrides_merge_key_by_key(tmp_path):
    path = tmp_path / "print-profile.json"
    path.write_text(json.dumps(PROFILE))
    profile = load_profile({"filaments": {"PETG": {"colour": "#688197"}}, "process_settings": {"slice_closing_radius": "0.01"}}, path=path)
    assert profile.filaments["PETG"].preset == "Bambu PETG Basic @BBL H2D 0.4 nozzle"
    assert profile.filaments["PETG"].colour == "#688197"
    assert profile.filaments["PLA"].colour == "#FFFFFF"
    assert profile.process_settings == {"resolution": "0.003", "slice_closing_radius": "0.01"}
    assert profile.support_interface == "PLA"


def test_missing_profile_says_what_to_ask(tmp_path):
    with pytest.raises(ProfileError, match="Ask the user which printer"):
        load_profile(path=tmp_path / "absent.json")


@pytest.mark.parametrize(
    "change, message",
    [
        ({"bed_type": "Glass"}, "bed_type 'Glass'"),
        ({"filament": "ABS"}, "filament 'ABS' is not one of"),
        ({"filaments": {"PETG": {"preset": "x", "colour": "blue"}}}, "#RRGGBB"),
        ({"support": {"type": "everywhere"}}, "support type"),
        ({"support": {"type": "tree(auto)", "interface_filament": "TPU"}}, "interface_filament 'TPU'"),
        ({"nozzle": 0.4}, "unknown key"),
        ({"process_settings": {"wall_loops": 5}}, 'wall_loops must be text as Bambu Studio writes it, such as "5"'),
        ({"process_settings": {"wipe_tower_x": [40]}}, "wipe_tower_x must be text"),
        ({"process_settings": {"xy_hole_compensation": "0.1"}}, "measured per printer and filament and saved with save-compensation"),
        ({"process_settings": {"enable_circle_compensation": "1"}}, "measured per printer and filament"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {**MEASURED, "mm": 8}}}}}}, "under 1 mm"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {**MEASURED, "measured": "last week"}}}}}}, "must be a date"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {**MEASURED, "measured": "20261031"}}}}}}, "must be a date"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {"mm": 0.1, "measured": "2026-10-31"}}}}}}, "missing resolution"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"holes": MEASURED}}}}}, "unknown key"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {**MEASURED, "mm": "0.1"}}}}}}, "must be a number"),
    ],
)
def test_profile_errors_name_the_problem(change, message):
    with pytest.raises(ProfileError, match=message):
        parse_profile({**PROFILE, **change})


def test_job_plates_parts_and_defaults(tmp_path):
    path = tmp_path / "jig.print.json"
    path.write_text(
        json.dumps(
            {
                "name": "Jig",
                "plates": [
                    {"name": "Fit test", "parts": [{"file": "out/coupon.step", "rotate": [180, 0, 0]}]},
                    {"parts": [{"file": "out/post.stl", "copies": 4, "support": False, "colour": "#c12e1f"}]},
                ],
            }
        )
    )
    job = load_job(path)
    assert job.output == tmp_path / "jig.3mf"
    assert [plate.name for plate in job.plates] == ["Fit test", "Plate 2"]
    coupon, post = job.parts
    assert coupon.file == tmp_path / "out" / "coupon.step" and coupon.rotate == (180.0, 0.0, 0.0)
    assert (post.name, post.copies, post.support, post.colour) == ("post", 4, False, "#C12E1F")
    assert not job.auto_plates


def test_single_part_target_takes_part_options(tmp_path):
    job = load_job(tmp_path / "bracket.step", {"rotate": [0, 90, 0], "copies": 2})
    assert job.auto_plates and job.output == tmp_path / "bracket.3mf"
    (part,) = job.parts
    assert part.rotate == (0.0, 90.0, 0.0) and part.copies == 2


@pytest.mark.parametrize(
    "data, message",
    [
        ({"parts": [{"file": "a.step"}], "plates": []}, "either plates"),
        ({"parts": [{"file": "a.obj"}]}, "STEP, STP or STL"),
        ({"parts": [{"file": "a.step", "rotate": [90, 0]}]}, "rotate must be"),
        ({"parts": [{"file": "a.step", "copies": 0}]}, "copies"),
        ({"parts": [{"file": "a.step", "orientation": "up"}]}, "unknown key"),
        ({"parts": [{"file": "a.step"}], "output": "a.stl"}, ".3mf"),
        ({"parts": [{"file": "/outputs/a.step"}]}, "relative to the job file"),
        ({"parts": [{"file": "D:\\outputs\\a.step"}]}, "relative to the job file"),
        ({"parts": [{"file": "a.step"}], "output": "C:/prints/a.3mf"}, "relative to the job file"),
    ],
)
def test_job_errors_name_the_problem(tmp_path, data, message):
    with pytest.raises(JobError, match=message):
        parse_job(data, base=tmp_path, default_output=tmp_path / "x.3mf")


def test_job_paths_take_either_separator(tmp_path):
    job = parse_job({"parts": [{"file": "..\\outputs\\a.step"}], "output": "prints\\a.3mf"}, base=tmp_path / "jobs", default_output=tmp_path / "x.3mf")
    assert job.parts[0].file == tmp_path / "outputs" / "a.step"
    assert job.output == tmp_path / "jobs" / "prints" / "a.3mf"


def test_command_line_paths_read_like_the_other_cad_tools(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert _path("outputs\\a.step") == tmp_path.resolve() / "outputs" / "a.step"
    assert _path(str(tmp_path / "b.step")) == tmp_path.resolve() / "b.step"
    with pytest.raises(argparse.ArgumentTypeError, match="absolute on this system"):
        _path("D:a.step")  # drive-relative: absolute on no system
