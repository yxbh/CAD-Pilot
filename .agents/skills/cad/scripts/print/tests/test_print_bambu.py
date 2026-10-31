import json
import math
import os
import re
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from build123d import Box, Cylinder, Pos, export_step

from print.bambu import BambuStudio, BambuStudioError, CliRun
from common.threemf import CORE_NS
from print.bambu3mf import CALIBRATION_KEY, write_project
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


def _object_settings(project: Path) -> dict[str, dict[str, str]]:
    """Each object's own settings in a project, by object name."""
    with zipfile.ZipFile(project) as archive:
        config = ET.fromstring(archive.read("Metadata/model_settings.config"))
    objects = {}
    for item in config.iter("object"):
        values = {m.get("key"): m.get("value") for m in item.findall("metadata")}
        objects[values.pop("name")] = values
    return objects


def _walls_at(gcode: str, z: float, centre: tuple[float, float], reach: float) -> tuple[float, float]:
    """At one layer of G-code written without arcs: the extrusion path nearest a point (the wall
    around a hole there) and the width of the paths within ``reach`` of it (the outer wall)."""
    layer, x, y, points = None, 0.0, 0.0, []
    for line in gcode.splitlines():
        if line.startswith("; Z_HEIGHT:"):
            layer = float(line.split(":")[1])
        elif line.startswith(("G0 ", "G1 ")):
            words = {w[0]: float(w[1:]) for w in line.split(";")[0].split()[1:] if w[0] in "XYE"}
            nx, ny = words.get("X", x), words.get("Y", y)
            if layer is not None and abs(layer - z) < 0.11 and words.get("E", 0) > 0:
                points += [(x + t / 10 * (nx - x), y + t / 10 * (ny - y)) for t in range(11)]
            x, y = nx, ny
    near = [(px, py) for px, py in points if abs(px - centre[0]) <= reach and abs(py - centre[1]) <= reach]
    assert near, f"no extrusion near {centre} at z {z}"
    return min(math.hypot(px - centre[0], py - centre[1]) for px, py in near), max(p[0] for p in near) - min(p[0] for p in near)


def _slice_keeping_gcode(project: Path, work: Path) -> tuple[str, Path]:
    """Slice plate 1 and export the project as Bambu Studio itself writes it back."""
    out = work / "sliced"
    result = STUDIO.run(["--slice", "1", "--outputdir", str(out), "--export-3mf", "roundtrip.3mf", str(project)], work, timeout=300)
    assert result.returncode == 0, result.failure()
    return (out / "plate_1.gcode").read_text(), out / "roundtrip.3mf"


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


def _project(path: Path, settings: dict, *, plates: int = 1, objects: tuple[dict, ...] = (), metadata: dict | None = None) -> Path:
    """A project as far as slicing and saving compensation read one: settings, plates, objects' own
    settings and the model's metadata."""
    plate = "".join(f'<plate><metadata key="plater_id" value="{n}"/><metadata key="plater_name" value="P{n}"/></plate>' for n in range(1, plates + 1))
    items = "".join(
        f'<object id="{n + 2}">' + "".join(f'<metadata key="{key}" value="{value}"/>' for key, value in item.items()) + "</object>"
        for n, item in enumerate(objects)
    )
    model = f'<model xmlns="{CORE_NS}">' + "".join(f'<metadata name="{k}">{v}</metadata>' for k, v in (metadata or {}).items()) + "<resources/></model>"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("3D/3dmodel.model", model)
        archive.writestr("Metadata/model_settings.config", f"<config>{items}{plate}</config>")
        archive.writestr("Metadata/project_settings.config", json.dumps(settings))
    return path


def test_a_failing_plate_is_reported_and_the_rest_still_slice(tmp_path):
    project = _project(tmp_path / "three.3mf", {"filament_settings_id": ["PETG"], "filament_colour": ["#000000"]}, plates=3)
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
    export_step(Pos(0, 0, 3) * Box(20, 20, 6), str(tmp_path / "plate.step"))
    result = _cli(_home(tmp_path, PROFILE), tmp_path, "project", "plate.step", "--copies", "2", "--colour", "#C12E1F", "--slice")
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
    """Answers each --slice target from a script: (exit code, log, plates sliced, result.json or None);
    an exit code of "timeout" stands for a run stopped at its time limit."""

    def __init__(self, script):
        self.script = script
        self.targets: list[int] = []

    def run(self, arguments, work, *, timeout):
        target = int(arguments[arguments.index("--slice") + 1])
        out = Path(arguments[arguments.index("--outputdir") + 1])
        self.targets.append(target)
        code, log, sliced, result = self.script[target]
        if code == "timeout":
            return CliRun(-9, log, 0, timeout=timeout)
        entries = []
        for number in sliced:
            (out / f"plate_{number}.gcode").write_text("")
            entries.append({"id": number, "total_predication": 60.0, "filaments": [], "feature_type_times": {}})
        if result is not None:
            (out / "result.json").write_text(json.dumps({**result, "sliced_plates": entries}))
        return CliRun(code, log, 0)


def _three_plates(tmp_path):
    return _project(tmp_path / "three.3mf", {"filament_settings_id": ["PETG"]}, plates=3)


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


MEASURED_WITH = {"process": PROFILE["process"], "filament_preset": PROFILE["filaments"]["PETG"]["preset"]}
MEASURED_PETG = {
    "hole": {"mm": 0.1, "measured": "2026-10-31", "resolution": 0.003, "slice_closing_radius": 0.01, **MEASURED_WITH},
    "contour": {"mm": -0.05, "measured": "2026-10-31", "resolution": 0.012, "slice_closing_radius": 0.01, **MEASURED_WITH},
}
# Without arc fitting the G-code draws circles as straight moves, which the checks above read.
NO_ARCS = {**PROFILE["process_settings"], "enable_arc_fitting": "0"}


def _measured_profile(**process_settings) -> dict:
    petg = {**PROFILE["filaments"]["PETG"], "compensation": {PROFILE["printer"]: MEASURED_PETG}}
    return {**PROFILE, "filaments": {**PROFILE["filaments"], "PETG": petg}, "process_settings": {**NO_ARCS, **process_settings}}


@needs_bambu
def test_each_object_slices_with_its_own_filaments_measured_compensation(tmp_path):
    from print.report import plan_lines

    export_step(Pos(0, 0, 3) * Box(20, 20, 6) - Pos(0, 0, 3) * Cylinder(3, 6), str(tmp_path / "holed.step"))
    job = parse_job(
        {"name": "Mixed", "parts": [
            {"file": "holed.step", "name": "in PETG", "filament": "PETG", "turn": False},
            {"file": "holed.step", "name": "in PLA", "filament": "PLA", "turn": False},
        ]},
        base=tmp_path, default_output=tmp_path / "mixed.3mf",
    )
    plan = plan_project(job, parse_profile(_measured_profile()), STUDIO)
    write_project(plan, job.output)
    lines = "\n".join(plan_lines(plan))
    assert "in PETG (PETG): hole +0.1 mm (measured 2026-10-31), outer contour -0.05 mm (measured 2026-10-31)" in lines
    assert "in PLA (PLA): hole 0 mm (unmeasured), outer contour 0 mm (unmeasured)" in lines
    # The contour value was measured at another resolution than this project slices with.
    assert "PETG contour compensation was measured with resolution 0.012; this project slices with resolution 0.003" in lines
    assert "PETG hole compensation was measured" not in lines

    gcode, roundtrip = _slice_keeping_gcode(job.output, tmp_path)
    for project in (job.output, roundtrip):
        objects = _object_settings(project)
        assert (objects["in PETG"]["xy_hole_compensation"], objects["in PETG"]["xy_contour_compensation"]) == ("0.1", "-0.05")
        assert (objects["in PLA"]["xy_hole_compensation"], objects["in PLA"]["xy_contour_compensation"]) == ("0", "0")
    (petg,) = [i.rect for p in plan.plates for i in p.instances if plan.instance_name(i) == "in PETG"]
    (pla,) = [i.rect for p in plan.plates for i in p.instances if plan.instance_name(i) == "in PLA"]
    hole_petg, width_petg = _walls_at(gcode, 3.0, ((petg.x0 + petg.x1) / 2, (petg.y0 + petg.y1) / 2), 12)
    hole_pla, width_pla = _walls_at(gcode, 3.0, ((pla.x0 + pla.x1) / 2, (pla.y0 + pla.y1) / 2), 12)
    # The PETG hole's wall moves out 0.1 mm and its outer wall in 0.05 mm on each side; the PLA part's stay.
    assert hole_petg - hole_pla == pytest.approx(0.1, abs=0.01)
    assert width_petg - width_pla == pytest.approx(-0.1, abs=0.01)
    assert hole_pla == pytest.approx(3.0 + 0.21, abs=0.02)


@needs_bambu
def test_a_calibration_coupon_slices_at_zero_whatever_the_profile_measured(tmp_path):
    from print.coupon import write_calibration_ladder

    (rung,) = write_calibration_ladder(tmp_path / "holes.step", "holes", 3.0, [0.0], 5.0)
    job = parse_job({"parts": [{"file": "holes.step", "turn": False}]}, base=tmp_path, default_output=tmp_path / "holes.3mf")
    plan = plan_project(job, parse_profile(_measured_profile()), STUDIO, calibration="hole")
    write_project(plan, job.output)
    settings = _object_settings(job.output)["holes"]
    assert (settings["xy_hole_compensation"], settings["xy_contour_compensation"]) == ("0", "0")
    gcode, _ = _slice_keeping_gcode(job.output, tmp_path)
    (instance,) = plan.plates[0].instances
    # The one hole sits mid-length, a wall and the dimple band in from the front edge (see coupon.py).
    from print.coupon import DIMPLE_BAND_MM, WALL_MM

    centre = ((instance.rect.x0 + instance.rect.x1) / 2, instance.rect.y0 + DIMPLE_BAND_MM + WALL_MM + rung.size_mm / 2)
    hole, _ = _walls_at(gcode, 2.5, centre, 3)
    assert hole == pytest.approx(1.5 + 0.21, abs=0.02)  # not 0.1 mm further out, as PETG's measured value would put it


def _cli(home: Path, cwd: Path, *arguments: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    return subprocess.run([sys.executable, str(LAUNCHER), *arguments], cwd=cwd, env=env, capture_output=True, text=True, check=False)


def _home(tmp_path: Path, profile: dict) -> Path:
    home = tmp_path / "home"
    (home / ".cad-pilot").mkdir(parents=True)
    (home / ".cad-pilot" / "print-profile.json").write_text(json.dumps(profile))
    return home


@needs_bambu
def test_the_coupon_command_writes_a_calibration_project_at_zero(tmp_path):
    home = _home(tmp_path, _measured_profile())
    coupon = Path("coupons", "pegs.step")
    result = _cli(home, tmp_path, "coupon", "-o", str(coupon), "--calibrate", "pegs", "--diameter", "8", "--values", "-0.1", "0", "0.1")
    assert result.returncode == 0, result.stderr
    assert "1 dimple: peg 7.8 mm, contour compensation -0.1 mm" in result.stdout
    assert f"save-compensation {coupon.with_suffix('.3mf')} --filament PETG --contour <value>" in result.stdout
    assert "hole 0 mm (forced for calibration), outer contour 0 mm (forced for calibration)" in result.stdout
    project = (tmp_path / coupon).with_suffix(".3mf")
    assert result.stdout.strip().splitlines()[-1] == f"3MF: {project.resolve()}"
    settings = _object_settings(project)["pegs"]
    assert (settings["xy_hole_compensation"], settings["xy_contour_compensation"]) == ("0", "0")


@needs_bambu
def test_saving_a_rung_shows_the_change_and_writes_only_when_asked(tmp_path):
    from print.coupon import write_calibration_ladder

    # The coupon was sliced at resolution 0.003 and closing radius 0.01; the profile has moved on since.
    write_calibration_ladder(tmp_path / "holes.step", "holes", 3.0, [0.0, 0.1], 5.0)
    job = parse_job({"parts": [{"file": "holes.step", "filament": "PLA"}]}, base=tmp_path, default_output=tmp_path / "holes.3mf")
    write_project(plan_project(job, parse_profile(PROFILE), STUDIO, calibration="hole"), job.output)
    home = _home(tmp_path, {**PROFILE, "process_settings": {"resolution": "0.012"}})
    path = home / ".cad-pilot" / "print-profile.json"
    before = path.read_text()
    wrong = _cli(home, tmp_path, "save-compensation", "holes.3mf", "--filament", "PETG", "--hole", "0.1")
    assert wrong.returncode == 2 and "not PETG" in wrong.stderr
    pegs = _cli(home, tmp_path, "save-compensation", "holes.3mf", "--filament", "PLA", "--contour", "0.1")
    assert pegs.returncode == 2 and "save its result with --hole" in pegs.stderr
    preview = _cli(home, tmp_path, "save-compensation", "holes.3mf", "--filament", "PLA", "--hole", "0.15")
    assert preview.returncode == 0, preview.stderr
    assert "hole compensation: 0 mm (unmeasured) -> 0.15 mm" in preview.stdout and "Nothing written" in preview.stdout
    assert path.read_text() == before
    written = _cli(home, tmp_path, "save-compensation", "holes.3mf", "--filament", "PLA", "--hole", "0.15", "--write")
    assert written.returncode == 0, written.stderr
    saved = json.loads(path.read_text())["filaments"]["PLA"]["compensation"][PROFILE["printer"]]
    # The record keeps the conditions the coupon sliced with, not the profile's current ones.
    with_pla = {"process": PROFILE["process"], "filament_preset": PROFILE["filaments"]["PLA"]["preset"]}
    assert saved == {"hole": {"mm": 0.15, "measured": date.today().isoformat(), "resolution": 0.003, "slice_closing_radius": 0.01, **with_pla}}


COUPON_SETTINGS = {
    "printer_settings_id": PROFILE["printer"],
    "print_settings_id": PROFILE["process"],
    "filament_settings_id": [PROFILE["filaments"]["PETG"]["preset"]],
    "resolution": "0.003",
    "slice_closing_radius": "0.01",
}
AT_ZERO = {"name": "holes", "xy_hole_compensation": "0", "xy_contour_compensation": "0"}


@pytest.mark.parametrize(
    "objects, metadata, kind, message",
    [
        ((AT_ZERO,), {}, "hole", "is not a calibration coupon's project.*coupon --calibrate holes --filament PETG"),
        ((AT_ZERO,), {CALIBRATION_KEY: "hole"}, "contour", "is a holes coupon, which measures hole compensation: save its result with --hole"),
        ((AT_ZERO, {**AT_ZERO, "xy_hole_compensation": "0.1"}), {CALIBRATION_KEY: "hole"}, "hole", "with xy_hole_compensation 0.1, not 0"),
        (({"name": "holes"},), {CALIBRATION_KEY: "hole"}, "hole", "with xy_hole_compensation unset, not 0"),
    ],
)
def test_a_result_is_saved_only_from_a_coupon_that_measures_it_at_zero(tmp_path, objects, metadata, kind, message):
    from print.cli import _coupon_settings
    from print.job import JobError

    coupon = _project(tmp_path / "coupon.3mf", COUPON_SETTINGS, objects=objects, metadata=metadata)
    with pytest.raises(JobError, match=message):
        _coupon_settings(coupon, kind, parse_profile(PROFILE), "PETG")


def test_a_coupons_result_holds_with_its_process_and_filament_preset(tmp_path):
    from print.cli import _coupon_settings
    from print.compensation import conditions

    coupon = _project(tmp_path / "coupon.3mf", COUPON_SETTINGS, objects=(AT_ZERO,), metadata={CALIBRATION_KEY: "hole"})
    settings = _coupon_settings(coupon, "hole", parse_profile(PROFILE), "PETG")
    assert conditions(settings, PROFILE["filaments"]["PETG"]["preset"]) == {"resolution": 0.003, "slice_closing_radius": 0.01, **MEASURED_WITH}


def _fake_install(root: Path) -> Path:
    """An app folder laid out like Bambu Studio's on macOS, whose executable is an empty file."""
    app = root / "Bambu.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "MacOS" / "BambuStudio").write_text("")
    (app / "Contents" / "Resources" / "profiles").mkdir(parents=True)
    (app / "Contents" / "Resources" / "profiles" / "BBL.json").write_text("{}")
    return app


def test_a_relative_install_is_made_absolute_and_a_program_that_cannot_start_is_an_error(tmp_path, monkeypatch):
    app = _fake_install(tmp_path)
    monkeypatch.chdir(tmp_path)
    studio = BambuStudio.locate("Bambu.app")
    # The command line runs in a temporary folder, where a relative path would name nothing.
    assert studio.executable == app / "Contents" / "MacOS" / "BambuStudio"
    work = tmp_path / "work"
    work.mkdir()
    with pytest.raises(BambuStudioError, match="Could not run Bambu Studio"):
        studio.run(["--help"], work)


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in program is a shell script")
def test_a_run_past_its_time_limit_is_stopped_and_reported(tmp_path):
    program = tmp_path / "slow"
    program.write_text("#!/bin/sh\nexec sleep 30\n")
    program.chmod(0o755)
    result = BambuStudio(program, program, tmp_path).run([], tmp_path, timeout=0.5)
    assert result.timed_out and not result.crashed and result.stopped
    assert result.failure() == "Bambu Studio did not finish within 0.5 s"


def test_a_timed_out_run_is_retried_plate_by_plate_and_blames_only_a_lone_plate(tmp_path):
    studio = _ScriptedStudio({0: ("timeout", "", [], None), 1: (0, "", [1], {}), 2: ("timeout", "", [], None), 3: (0, "", [3], {})})
    report = slice_project(studio, _three_plates(tmp_path), timeout=1800)
    assert studio.targets == [0, 1, 2, 3]
    assert [plate.error for plate in report.plates] == [None, "Bambu Studio did not finish within 1800 s", None]
    assert report.plates[0].seconds == 60.0 and not report.ok


def _cannot_slice(studio, project):
    raise BambuStudioError("Could not run Bambu Studio: it cannot start")


def test_slice_still_names_the_3mf_when_slicing_cannot_run(tmp_path, monkeypatch, capsys):
    from print import cli

    project = _three_plates(tmp_path)
    monkeypatch.setattr(cli, "_configured_studio", lambda: None)
    monkeypatch.setattr(cli.BambuStudio, "locate", classmethod(lambda cls, configured=None: None))
    monkeypatch.setattr(cli, "slice_project", _cannot_slice)
    assert cli.main(["slice", str(project)]) == 2
    out, err = capsys.readouterr()
    assert out.strip().splitlines()[-1] == f"3MF: {project}"
    assert "error: Could not run Bambu Studio" in err


@needs_bambu
def test_project_still_reports_its_plan_and_3mf_when_slicing_fails(tmp_path, monkeypatch, capsys):
    from print import cli

    export_step(Pos(0, 0, 3) * Box(20, 20, 6), str(tmp_path / "plate.step"))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "load_profile", lambda overrides=None: parse_profile(PROFILE))
    monkeypatch.setattr(cli, "slice_project", _cannot_slice)
    assert cli.main(["project", "plate.step", "--slice"]) == 2
    out, err = capsys.readouterr()
    assert 'plate 1 "plate": plate' in out
    assert out.strip().splitlines()[-1] == f"3MF: {tmp_path / 'plate.3mf'}"
    assert (tmp_path / "plate.3mf").is_file() and "error: Could not run Bambu Studio" in err
