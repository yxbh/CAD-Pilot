import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from build123d import Box, Pos, export_step

from print.bambu import BambuStudio, BambuStudioError, CliRun
from print.bambu3mf import write_project
from print.layout import Rect
from print.job import parse_job
from print.plan import plan_project
from print.profile import parse_profile
from print.slicing import slice_project


PROFILE = {
    "printer": "Bambu Lab H2D 0.4 nozzle",
    "process": "0.20mm Standard @BBL H2D",
    "bed_type": "High Temp Plate",
    "filament": "PETG",
    "filaments": {
        "PETG": {"preset": "Bambu PETG Basic @BBL H2D 0.4 nozzle", "colour": "#688197"},
        "PLA": {"preset": "Bambu PLA Basic @BBL H2D", "colour": "#FFFFFF"},
    },
    "support": {"type": "tree(auto)", "interface_filament": "PLA"},
    "process_settings": {"resolution": "0.003", "slice_closing_radius": "0.01"},
}
LAUNCHER = Path(__file__).resolve().parents[1]


def _installed() -> BambuStudio | None:
    try:
        studio = BambuStudio.locate()
        studio.presets.require("machine", PROFILE["printer"])
        return studio
    except BambuStudioError:
        return None


STUDIO = _installed()
needs_bambu = pytest.mark.skipif(STUDIO is None, reason="Bambu Studio with H2D presets is not installed")


def _plate_names(project: Path) -> list[str]:
    with zipfile.ZipFile(project) as archive:
        config = ET.fromstring(archive.read("Metadata/model_settings.config"))
    return [
        {m.get("key"): m.get("value") for m in plate.findall("metadata")}["plater_name"] for plate in config.iter("plate")
    ]


class _FakeStudio:
    """Slices plates 1..3 from the command line's arguments; ``failing`` stops a run, as the real
    command line stops at the first plate it cannot slice."""

    def __init__(self, failing: int) -> None:
        self.failing = failing
        self.targets: list[int] = []

    def run(self, arguments, work, *, timeout):
        target = int(arguments[arguments.index("--slice") + 1])
        out = Path(arguments[arguments.index("--outputdir") + 1])
        self.targets.append(target)
        sliced = []
        for number in [1, 2, 3] if target == 0 else [target]:
            if number == self.failing:
                result = {"error_string": "Nothing to be sliced", "plate_index": number, "sliced_plates": sliced}
                (out / "result.json").write_text(json.dumps(result))
                return CliRun(1, "", 0)
            (out / f"plate_{number}.gcode").write_text("")
            sliced.append({"id": number, "total_predication": 600.0 * number, "filaments": [{"id": 1, "total_used_g": 2.5}], "feature_type_times": {}})
        (out / "result.json").write_text(json.dumps({"error_string": "Success.", "sliced_plates": sliced}))
        return CliRun(0, "", 0)


def test_a_failing_plate_is_reported_and_the_rest_still_slice(tmp_path):
    project = tmp_path / "three.3mf"
    plates = "".join(f'<plate><metadata key="plater_id" value="{n}"/><metadata key="plater_name" value="P{n}"/></plate>' for n in (1, 2, 3))
    with zipfile.ZipFile(project, "w") as archive:
        archive.writestr("Metadata/model_settings.config", f"<config>{plates}</config>")
        archive.writestr("Metadata/project_settings.config", json.dumps({"filament_settings_id": ["PETG"], "filament_colour": ["#000000"]}))
    studio = _FakeStudio(failing=2)
    report = slice_project(studio, project)
    assert studio.targets == [0, 3]
    assert [(p.plate, p.error) for p in report.plates] == [(1, None), (2, "Nothing to be sliced"), (3, None)]
    assert report.plates[2].seconds == 1800.0 and report.plates[0].filaments[0].grams == 2.5
    assert not report.ok


@needs_bambu
def test_flattened_presets_carry_what_they_include():
    machine = STUDIO.presets.flat("machine", PROFILE["printer"])
    # The H2D takes its start G-code from an included template; without it the command line refuses to slice.
    assert "M" in machine["machine_start_gcode"]
    assert machine["printer_model"] == "Bambu Lab H2D"


@needs_bambu
def test_project_has_named_plates_supports_and_slices(tmp_path):
    export_step(Pos(0, 0, 10) * Box(10, 10, 20) + Pos(0, 0, 22) * Box(40, 10, 4), str(tmp_path / "tee.step"))
    export_step(Pos(0, 0, 4) * Box(30, 20, 8), str(tmp_path / "block.step"))
    job = parse_job(
        {
            "name": "Fixture",
            "plates": [
                {"name": "Tee on support", "parts": [{"file": "tee.step"}]},
                {"name": "Blocks", "parts": [{"file": "block.step", "copies": 2}]},
            ],
        },
        base=tmp_path,
        default_output=tmp_path / "fixture.3mf",
    )
    plan = plan_project(job, parse_profile(PROFILE), STUDIO)
    write_project(plan, job.output)

    assert _plate_names(job.output) == ["Tee on support", "Blocks"]
    with zipfile.ZipFile(job.output) as archive:
        settings = json.loads(archive.read("Metadata/project_settings.config"))
        model = archive.read("3D/3dmodel.model").decode()
    assert settings["curr_bed_type"] == "High Temp Plate"
    assert settings["filament_settings_id"] == ["Bambu PETG Basic @BBL H2D 0.4 nozzle", "Bambu PLA Basic @BBL H2D"]
    assert settings["support_interface_filament"] == "2" and settings["support_top_z_distance"] == "0"
    assert (settings["enable_support"], settings["support_type"], settings["resolution"]) == ("1", "tree(auto)", "0.003")
    assert "BambuStudio-" in model
    assert plan.plates[0].tower is not None and plan.plates[1].tower is None

    report = slice_project(STUDIO, job.output)
    assert report.ok, [plate.error for plate in report.plates]
    tee, blocks = report.plates
    assert tee.support_seconds > 0 and tee.prime_tower
    assert [f.preset for f in tee.filaments] == settings["filament_settings_id"]
    assert not blocks.prime_tower and [f.slot for f in blocks.filaments] == [1]
    assert all(plate.seconds > 0 for plate in report.plates)


@needs_bambu
def test_cli_writes_a_single_part_project_and_reports_its_path(tmp_path):
    home = tmp_path / "home"
    (home / ".cad-pilot").mkdir(parents=True)
    (home / ".cad-pilot" / "print-profile.json").write_text(json.dumps(PROFILE))
    export_step(Pos(0, 0, 3) * Box(20, 20, 6), str(tmp_path / "plate.step"))
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    result = subprocess.run(
        [sys.executable, str(LAUNCHER), "project", "plate.step", "--copies", "2", "--colour", "#C12E1F", "--slice"],
        cwd=tmp_path, env=env, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == f"3MF: {(tmp_path / 'plate.3mf').resolve()}"
    assert "plate 1 \"plate\": " in result.stdout and "#C12E1F" in result.stdout
    assert _plate_names(tmp_path / "plate.3mf") == ["plate"]


def test_a_crash_names_the_function_from_the_macos_crash_report(tmp_path, monkeypatch):
    from print import bambu

    header = json.dumps({"app_name": "BambuStudio"})
    body = {"pid": 4242, "faultingThread": 0, "threads": [{"frames": [{"imageIndex": 0}, {"symbol": "Slic3r::FilamentGroup::calc_one_change_budget(std::vector<unsigned int> const&) const"}]}]}
    (tmp_path / "BambuStudio-2026-10-31-095255.ips").write_text(header + "\n" + json.dumps(body))
    monkeypatch.setattr(bambu, "CRASH_REPORTS", tmp_path)
    monkeypatch.setattr(bambu.sys, "platform", "darwin")
    assert bambu.crash_frame(4242, wait=0) == "Slic3r::FilamentGroup::calc_one_change_budget"
    assert bambu.crash_frame(1, wait=0) is None
    assert CliRun(-11, "", 4242).failure() == "Bambu Studio crashed (signal 11) in Slic3r::FilamentGroup::calc_one_change_budget"


class _ScriptedStudio:
    """Answers each --slice target from a script: (exit code, log, plates sliced, result.json or None)."""

    def __init__(self, script):
        self.script = script
        self.targets: list[int] = []

    def run(self, arguments, work, *, timeout):
        target = int(arguments[arguments.index("--slice") + 1])
        out = Path(arguments[arguments.index("--outputdir") + 1])
        self.targets.append(target)
        code, log, sliced, result = self.script[target]
        entries = []
        for number in sliced:
            (out / f"plate_{number}.gcode").write_text("")
            entries.append({"id": number, "total_predication": 60.0, "filaments": [], "feature_type_times": {}})
        if result is not None:
            (out / "result.json").write_text(json.dumps({**result, "sliced_plates": entries}))
        return CliRun(code, log, 0)


def _three_plates(tmp_path):
    project = tmp_path / "three.3mf"
    plates = "".join(f'<plate><metadata key="plater_id" value="{n}"/><metadata key="plater_name" value="P{n}"/></plate>' for n in (1, 2, 3))
    with zipfile.ZipFile(project, "w") as archive:
        archive.writestr("Metadata/model_settings.config", f"<config>{plates}</config>")
        archive.writestr("Metadata/project_settings.config", json.dumps({"filament_settings_id": ["PETG"]}))
    return project


def test_a_crash_without_result_blames_no_plate_until_each_is_sliced_alone(tmp_path, monkeypatch):
    from print import bambu

    monkeypatch.setattr(bambu, "crash_frame", lambda pid, wait=5.0: "Slic3r::Somewhere")
    studio = _ScriptedStudio({0: (-11, "", [], None), 1: (0, "", [1], {}), 2: (-11, "", [], None), 3: (0, "", [3], {})})
    report = slice_project(studio, _three_plates(tmp_path))
    assert studio.targets == [0, 1, 2, 3]
    assert [plate.error for plate in report.plates] == [None, "Bambu Studio crashed (signal 11) in Slic3r::Somewhere", None]


def test_crossing_toolpaths_in_a_many_plate_run_are_traced_to_their_plate(tmp_path):
    conflict = "gcode path conflicts found between tee 1 and tee 2\n"
    studio = _ScriptedStudio({0: (0, conflict, [1, 2, 3], {}), 1: (0, "", [1], {}), 2: (0, conflict, [2], {}), 3: (0, "", [3], {})})
    report = slice_project(studio, _three_plates(tmp_path))
    assert studio.targets == [0, 1, 2, 3]
    assert [plate.conflicts for plate in report.plates] == [[], ["toolpaths of tee 1 and tee 2 cross"], []]
    assert not report.ok


def test_a_plain_3mf_is_not_a_project(tmp_path):
    plain = tmp_path / "plain.3mf"
    with zipfile.ZipFile(plain, "w") as archive:
        archive.writestr("3D/3dmodel.model", "<model/>")
    with pytest.raises(BambuStudioError, match="is not a Bambu Studio project"):
        slice_project(_ScriptedStudio({}), plain)
    (tmp_path / "text.3mf").write_text("not a zip")
    with pytest.raises(BambuStudioError, match="is not a Bambu Studio project"):
        slice_project(_ScriptedStudio({}), tmp_path / "text.3mf")


@needs_bambu
@pytest.mark.parametrize("printer", ["Bambu Lab X1 Carbon 0.4 nozzle", "Bambu Lab A1 mini 0.4 nozzle", "Bambu Lab P2S 0.4 nozzle", PROFILE["printer"]])
def test_installed_beds_give_a_reachable_tower_clear_of_exclusions(printer):
    from print.plan import _keep_outs, _reach, _tower

    settings = STUDIO.presets.flat("machine", printer)
    reach, keep_out = _reach(settings), _keep_outs(settings)
    if printer.startswith("Bambu Lab X1"):
        assert keep_out == [Rect(0, 0, 18, 28)]
    tower, kept_clear = _tower(settings, reach, keep_out)
    assert reach.contains(tower) and not any(kept_clear.overlaps(rect) for rect in keep_out)
