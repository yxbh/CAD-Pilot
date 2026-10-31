"""Slice check: slice a Bambu Studio project with Bambu Studio's command line and report each
plate's estimated time, filament use and warnings."""

from __future__ import annotations

import json
import re
import tempfile
import time
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

from .bambu import BambuStudio, BambuStudioError, CliRun


CONFLICT = re.compile(r"gcode path conflicts found between (.+?) and (.+?)\s*$", re.M)


@dataclass(frozen=True)
class FilamentUse:
    slot: int
    preset: str
    colour: str
    grams: float


@dataclass
class PlateSlice:
    plate: int
    name: str
    seconds: float | None = None
    filaments: list[FilamentUse] = field(default_factory=list)
    support_seconds: float = 0.0
    prime_tower: bool = False
    warnings: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class SliceReport:
    project: Path
    version: str
    printer: str
    process: str
    bed_type: str
    plates: list[PlateSlice]
    elapsed_seconds: float

    @property
    def ok(self) -> bool:
        """Every plate sliced, with no crossing toolpaths (which the app only warns about)."""
        return all(plate.error is None and not plate.conflicts for plate in self.plates)

    def as_dict(self) -> dict:
        data = asdict(self)
        data["project"] = str(self.project)
        data["ok"] = self.ok
        return data


def project_contents(project: Path) -> tuple[dict, list[str]]:
    """A project's settings and its plate names, in plate order."""
    try:
        with zipfile.ZipFile(project) as archive:
            settings = json.loads(archive.read("Metadata/project_settings.config"))
            config = ET.fromstring(archive.read("Metadata/model_settings.config"))
    except (zipfile.BadZipFile, KeyError, ValueError, ET.ParseError) as error:
        raise BambuStudioError(
            f"{project} is not a Bambu Studio project ({error}); a plain 3MF has no plates or settings to slice"
        ) from error
    names = []
    for plate in config.iter("plate"):
        values = {m.get("key"): m.get("value") for m in plate.findall("metadata")}
        names.append((int(values.get("plater_id", len(names) + 1)), values.get("plater_name") or ""))
    return settings, [name for _, name in sorted(names)]


def _plate_result(entry: dict, plate: PlateSlice, settings: dict) -> None:
    presets = settings.get("filament_settings_id", [])
    colours = settings.get("filament_colour", [])
    plate.seconds = float(entry.get("total_predication") or 0.0)
    for used in entry.get("filaments", []):
        slot = int(used["id"])
        plate.filaments.append(
            FilamentUse(
                slot,
                presets[slot - 1] if slot - 1 < len(presets) else f"slot {slot}",
                colours[slot - 1] if slot - 1 < len(colours) else "",
                round(float(used.get("total_used_g", 0.0)), 2),
            )
        )
    features = entry.get("feature_type_times", {})
    plate.support_seconds = float(sum(v for k, v in features.items() if k.startswith("Support")))
    plate.prime_tower = features.get("Prime tower", 0) > 0
    if entry.get("warning_message"):
        plate.warnings.append(str(entry["warning_message"]))


def slice_project(studio: BambuStudio, project: Path, *, timeout: float = 1800) -> SliceReport:
    """Slice every plate in one run when that goes cleanly. The command line stops at the first plate
    it cannot slice, may crash without saying where, and logs crossing toolpaths without their
    plate, so after any of those the plates not yet accounted for are sliced one at a time, and
    only a one-plate run's failures are blamed on a plate."""
    project = project.resolve()
    settings, names = project_contents(project)
    plates = {number: PlateSlice(number, name) for number, name in enumerate(names, start=1)}
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="cad-slice-") as temp:
        work = Path(temp)

        def run(target: int) -> tuple[dict, dict[int, dict], CliRun]:
            out = work / f"plate-{target}"
            out.mkdir()
            result = studio.run(["--slice", str(target), "--outputdir", str(out), str(project)], work, timeout=timeout)
            result_file = out / "result.json"
            data = json.loads(result_file.read_text(encoding="utf-8")) if result_file.is_file() else {}
            sliced = {
                int(entry.get("id", 0)): entry
                for entry in data.get("sliced_plates", [])
                if (out / f"plate_{int(entry.get('id', 0))}.gcode").is_file()
            }
            return data, sliced, result

        data, sliced, result = run(0)
        if not CONFLICT.search(result.output):
            for number, entry in sliced.items():
                if number in plates:
                    _plate_result(entry, plates[number], settings)
            failed = int(data.get("plate_index") or 0)
            if result.returncode != 0 and not result.crashed and failed in plates and plates[failed].seconds is None:
                plates[failed].error = (data.get("error_string") or result.failure()).strip()
        for number in [n for n in sorted(plates) if plates[n].seconds is None and plates[n].error is None]:
            data, sliced, result = run(number)
            plate = plates[number]
            plate.conflicts += [f"toolpaths of {first} and {second} cross" for first, second in CONFLICT.findall(result.output)]
            if number in sliced:
                _plate_result(sliced[number], plate, settings)
            if result.returncode != 0 and plate.seconds is None:
                plate.error = (result.failure() if result.crashed else data.get("error_string") or result.failure()).strip()
            elif plate.seconds is None:
                plate.error = "not sliced: Bambu Studio wrote no G-code for it"
    return SliceReport(
        project=project,
        version=str(settings.get("version", "")),
        printer=str(settings.get("printer_settings_id", "")),
        process=str(settings.get("print_settings_id", "")),
        bed_type=str(settings.get("curr_bed_type", "")),
        plates=[plates[n] for n in sorted(plates)],
        elapsed_seconds=round(time.perf_counter() - started, 2),
    )
