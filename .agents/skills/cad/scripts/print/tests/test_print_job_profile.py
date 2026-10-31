import argparse
import json
import re
from pathlib import Path

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
WITH = {"process": PROFILE["process"], "filament_preset": PETG["preset"]}
MEASURED = {"mm": 0.1, "measured": "2026-10-31", "resolution": 0.003, "slice_closing_radius": 0.01, **WITH}
NOW = {"resolution": 0.003, "slice_closing_radius": 0.01, **WITH}


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
    # At another resolution, or with another filament preset, the measured value is still used, and the change is named.
    (hole, _) = part_compensation(profile, "PETG", {**NOW, "resolution": 0.012}, calibrating=False)
    assert hole.mm == 0.1 and hole.changed == {"resolution": (0.003, 0.012)}
    (hole, _) = part_compensation(profile, "PETG", {**NOW, "filament_preset": "Bambu PETG HF @BBL H2D 0.4 nozzle"}, calibrating=False)
    assert hole.changed == {"filament_preset": (PETG["preset"], "Bambu PETG HF @BBL H2D 0.4 nozzle")}


def test_saving_compensation_changes_only_that_filament_on_that_printer(tmp_path):
    from print.profile import Measurement

    path = tmp_path / "print-profile.json"
    path.write_text(json.dumps({**PROFILE, "filaments": {**PROFILE["filaments"], "PETG": {**PETG, "compensation": {H2D: {"contour": MEASURED}}}}}))
    hole = Measurement(0.15, "2026-11-02", **{**NOW, "resolution": 0.003})
    before = path.read_text()
    assert record_compensation("PETG", H2D, {"hole": hole}, write=False, path=path).measured("PETG")["hole"] == hole
    assert path.read_text() == before
    with pytest.raises(ProfileError, match="under 1 mm"):
        record_compensation("PETG", H2D, {"hole": Measurement(10, "2026-11-02", **NOW)}, write=False, path=path)
    profile = record_compensation("PETG", H2D, {"hole": hole}, write=True, path=path)
    assert profile.measured("PETG") == {"contour": profile.measured("PETG")["contour"], "hole": hole}
    written = json.loads(path.read_text())
    assert written["filaments"]["PETG"]["compensation"][H2D] == {"contour": MEASURED, "hole": hole.as_dict()}
    assert {key: value for key, value in written.items() if key != "filaments"} == {key: value for key, value in PROFILE.items() if key != "filaments"}
    assert written["filaments"]["PLA"] == PROFILE["filaments"]["PLA"]
    with pytest.raises(ProfileError, match="no filament 'ABS'"):
        record_compensation("ABS", H2D, {"hole": hole}, write=True, path=path)


def test_a_measurement_without_its_conditions_is_deleted_and_measured_again(tmp_path):
    from print.profile import Measurement

    # Saved with its resolution and closing radius but not its process and filament preset.
    path = tmp_path / "print-profile.json"
    unchecked = {key: value for key, value in MEASURED.items() if key not in WITH}
    path.write_text(json.dumps({**PROFILE, "filaments": {**PROFILE["filaments"], "PETG": {**PETG, "compensation": {H2D: {"hole": unchecked}}}}}))
    entry = re.escape(f"filament 'PETG' compensation '{H2D}' hole: missing filament_preset, process, which every measurement records")
    for overrides in (None, {"process_settings": {"wall_loops": "3"}}):
        with pytest.raises(ProfileError, match=f'^{re.escape(str(path))}( with project overrides)? {entry}.* Delete this "hole" entry from the file and measure it again'):
            load_profile(overrides, path=path)
    # Deleting the entry, as the error says, leaves the hole unmeasured and saving a new one possible.
    data = json.loads(path.read_text())
    del data["filaments"]["PETG"]["compensation"][H2D]["hole"]
    path.write_text(json.dumps(data))
    assert load_profile(path=path).measured("PETG") == {}
    hole = Measurement(0.1, "2026-11-02", **NOW)
    assert record_compensation("PETG", H2D, {"hole": hole}, write=True, path=path).measured("PETG") == {"hole": hole}


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
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {"mm": 0.1, "measured": "2026-10-31"}}}}}}, "missing filament_preset, process, resolution, slice_closing_radius, which every measurement records"),
        ({"filaments": {"PETG": {**PETG, "compensation": {H2D: {"hole": {**MEASURED, "process": ""}}}}}}, "process must be a non-empty string"),
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


def test_missing_profile_values_say_what_to_ask(tmp_path):
    path = tmp_path / "print-profile.json"
    path.write_text(json.dumps({key: value for key, value in PROFILE.items() if key not in {"bed_type", "support"}}))
    with pytest.raises(ProfileError, match=r"missing bed_type, support\. Ask the user which printer.*rather than taking them from other files"):
        load_profile(path=path)


def test_a_job_cannot_choose_the_bambu_studio_that_runs(tmp_path):
    path = tmp_path / "print-profile.json"
    path.write_text(json.dumps(PROFILE))
    with pytest.raises(ProfileError, match="a print job cannot set bambu_studio"):
        load_profile({"bambu_studio": str(tmp_path / "BambuStudio.app")}, path=path)
    # The personal profile still names this machine's installation.
    path.write_text(json.dumps({**PROFILE, "bambu_studio": "/Applications/BambuStudio.app"}))
    assert load_profile(path=path).bambu_studio == "/Applications/BambuStudio.app"


def test_the_documented_job_writes_its_3mf_beside_the_job(tmp_path):
    reference = (Path(__file__).resolve().parents[3] / "references" / "print.md").read_text(encoding="utf-8")
    section = reference.split("## Print jobs", 1)[1]
    example = json.loads(re.search(r"```json\n(.*?)```", section, re.S).group(1))
    prints = tmp_path / "prints"
    job = parse_job(example, base=prints, default_output=prints / "jig.3mf")
    assert job.output.parent == prints
    assert {part.file.parent for part in job.parts} == {tmp_path / "outputs"}


def test_the_documented_profile_reads():
    reference = (Path(__file__).resolve().parents[3] / "references" / "print.md").read_text(encoding="utf-8")
    section = reference.split("## The personal print profile", 1)[1]
    profile = parse_profile(json.loads(re.search(r"```json\n(.*?)```", section, re.S).group(1)))
    assert profile.measured("PETG")["hole"].filament_preset == profile.filaments["PETG"].preset


@pytest.mark.parametrize("name, content", [("jig.3mf", b"PK\x03\x04"), ("jig.print.json", b"\xff\xfe\x00binary")])
def test_a_3mf_or_binary_target_is_not_a_job(tmp_path, name, content):
    (tmp_path / name).write_bytes(content)
    with pytest.raises(JobError, match="slice a project with|is not a print job"):
        load_job(tmp_path / name)
