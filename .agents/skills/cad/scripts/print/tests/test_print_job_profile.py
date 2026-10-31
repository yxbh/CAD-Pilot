import json

import pytest

from print.job import JobError, load_job, parse_job
from print.profile import ProfileError, load_profile, parse_profile


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
    ],
)
def test_job_errors_name_the_problem(tmp_path, data, message):
    with pytest.raises(JobError, match=message):
        parse_job(data, base=tmp_path, default_output=tmp_path / "x.3mf")
