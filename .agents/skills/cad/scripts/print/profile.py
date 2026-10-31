"""The personal print profile: printer, process, plate, filaments and supports, stored once per user
and overridden per project."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from common.atomic_replace import replacing

from .bambu import BED_TEMPERATURE_KEYS


PROFILE_PATH = Path.home() / ".cad-pilot" / "print-profile.json"
SUPPORT_TYPES = ("tree(auto)", "normal(auto)")
COLOUR = re.compile(r"#[0-9A-Fa-f]{6}")
KEYS = {"printer", "process", "bed_type", "filament", "filaments", "support", "process_settings", "bambu_studio"}
SUPPORT_KEYS = {"type", "interface_filament"}
FILAMENT_KEYS = {"preset", "colour", "compensation"}
# Bambu's X-Y compensations, measured per printer and filament with calibration coupons.
COMPENSATION_SETTINGS = {"hole": "xy_hole_compensation", "contour": "xy_contour_compensation"}
# The settings a measured compensation depends on: it holds only at the values in force when it was measured.
CONDITIONS = ("resolution", "slice_closing_radius")
MEASUREMENT_KEYS = {"mm", "measured", *CONDITIONS}
# A compensation is a small correction per side, under this.
MAX_COMPENSATION_MM = 1.0
# Corrections of hole and outline sizes that would stack on the measured compensation.
OWN_CORRECTIONS = {*COMPENSATION_SETTINGS.values(), "enable_circle_compensation"}


class ProfileError(ValueError):
    pass


@dataclass(frozen=True)
class Measurement:
    """A compensation read off a calibration coupon (mm per side, as Bambu applies it), the day it was
    measured, and the slicing conditions in force then."""

    mm: float
    measured: str
    resolution: float
    slice_closing_radius: float

    def as_dict(self) -> dict:
        return {"mm": self.mm, "measured": self.measured, "resolution": self.resolution, "slice_closing_radius": self.slice_closing_radius}


@dataclass(frozen=True)
class Filament:
    key: str
    preset: str
    colour: str
    # Printer preset -> "hole" and/or "contour" -> measurement.
    compensation: dict[str, dict[str, Measurement]] = field(default_factory=dict)

    def as_dict(self) -> dict:
        entry: dict = {"preset": self.preset, "colour": self.colour}
        if self.compensation:
            entry["compensation"] = {
                printer: {kind: m.as_dict() for kind, m in kinds.items()} for printer, kinds in self.compensation.items()
            }
        return entry


@dataclass(frozen=True)
class PrintProfile:
    printer: str
    process: str
    bed_type: str
    filament: str
    filaments: dict[str, Filament]
    support_type: str
    support_interface: str | None
    process_settings: dict[str, object] = field(default_factory=dict)
    bambu_studio: str | None = None

    def as_dict(self) -> dict:
        return {
            "printer": self.printer,
            "process": self.process,
            "bed_type": self.bed_type,
            "filament": self.filament,
            "filaments": {key: f.as_dict() for key, f in self.filaments.items()},
            "support": {"type": self.support_type, "interface_filament": self.support_interface},
            "process_settings": dict(self.process_settings),
            **({"bambu_studio": self.bambu_studio} if self.bambu_studio else {}),
        }

    def measured(self, filament: str) -> dict[str, Measurement]:
        """The hole and contour compensation measured for a filament on this profile's printer."""
        return self.filaments[filament].compensation.get(self.printer, {})


def _merge(base: dict, overrides: Mapping) -> dict:
    """Overrides replace values, except that nested tables merge key by key."""
    merged = dict(base)
    for key, value in overrides.items():
        if isinstance(value, Mapping) and isinstance(merged.get(key), Mapping):
            merged[key] = _merge(dict(merged[key]), value)
        else:
            merged[key] = value
    return merged


def _unknown(where: str, data: Mapping, allowed: set[str]) -> None:
    extra = sorted(set(data) - allowed)
    if extra:
        raise ProfileError(f"{where}: unknown key(s) {', '.join(extra)}; expected {', '.join(sorted(allowed))}")


def _text(where: str, value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProfileError(f"{where} must be a non-empty string")
    return value


def _colour(where: str, value: object) -> str:
    if not isinstance(value, str) or not COLOUR.fullmatch(value):
        raise ProfileError(f"{where} must be a #RRGGBB colour, not {value!r}")
    return value.upper()


def _number(where: str, value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProfileError(f"{where} must be a number, not {value!r}")
    return float(value)


def _measurement(where: str, data: object) -> Measurement:
    if not isinstance(data, Mapping):
        raise ProfileError(f"{where} must be an object with {', '.join(sorted(MEASUREMENT_KEYS))}")
    _unknown(where, data, MEASUREMENT_KEYS)
    missing = sorted(MEASUREMENT_KEYS - set(data))
    if missing:
        raise ProfileError(f"{where}: missing {', '.join(missing)}")
    mm = _number(f"{where} mm", data["mm"])
    if abs(mm) >= MAX_COMPENSATION_MM:
        raise ProfileError(f"{where} mm is {mm:g}: a compensation is a small correction per side, under {MAX_COMPENSATION_MM:g} mm")
    measured = data["measured"]
    try:
        canonical = date.fromisoformat(measured).isoformat() == measured
    except (TypeError, ValueError):
        canonical = False
    if not canonical:
        raise ProfileError(f"{where} measured must be a date such as \"2026-10-31\", not {measured!r}")
    conditions = {key: _number(f"{where} {key}", data[key]) for key in CONDITIONS}
    return Measurement(mm, measured, **conditions)


def _compensation(where: str, data: object) -> dict[str, dict[str, Measurement]]:
    if not isinstance(data, Mapping):
        raise ProfileError(f"{where} must map printer presets to hole and contour measurements")
    result = {}
    for printer, kinds in data.items():
        if not isinstance(kinds, Mapping):
            raise ProfileError(f"{where} {printer!r} must be an object with hole and/or contour")
        _unknown(f"{where} {printer!r}", kinds, set(COMPENSATION_SETTINGS))
        result[printer] = {kind: _measurement(f"{where} {printer!r} {kind}", value) for kind, value in kinds.items()}
    return result


def parse_profile(data: Mapping, *, where: str = "print profile") -> PrintProfile:
    _unknown(where, data, KEYS)
    missing = sorted({"printer", "process", "bed_type", "filament", "filaments", "support"} - set(data))
    if missing:
        raise ProfileError(f"{where}: missing {', '.join(missing)}")
    bed_type = _text(f"{where} bed_type", data["bed_type"])
    if bed_type not in BED_TEMPERATURE_KEYS:
        raise ProfileError(f"{where} bed_type {bed_type!r} is not one of {', '.join(BED_TEMPERATURE_KEYS)}")
    raw_filaments = data["filaments"]
    if not isinstance(raw_filaments, Mapping) or not raw_filaments:
        raise ProfileError(f"{where} filaments must name at least one filament")
    filaments = {}
    for key, entry in raw_filaments.items():
        if not isinstance(entry, Mapping):
            raise ProfileError(f"{where} filament {key!r} must be an object with preset and colour")
        _unknown(f"{where} filament {key!r}", entry, FILAMENT_KEYS)
        filaments[key] = Filament(
            key,
            _text(f"{where} filament {key!r} preset", entry.get("preset")),
            _colour(f"{where} filament {key!r} colour", entry.get("colour")),
            _compensation(f"{where} filament {key!r} compensation", entry.get("compensation", {})),
        )
    default = _text(f"{where} filament", data["filament"])
    if default not in filaments:
        raise ProfileError(f"{where} filament {default!r} is not one of the filaments: {', '.join(filaments)}")
    support = data["support"]
    if not isinstance(support, Mapping):
        raise ProfileError(f"{where} support must be an object with type and interface_filament")
    _unknown(f"{where} support", support, SUPPORT_KEYS)
    support_type = support.get("type")
    if support_type not in SUPPORT_TYPES:
        raise ProfileError(f"{where} support type must be one of {', '.join(SUPPORT_TYPES)}, not {support_type!r}")
    interface = support.get("interface_filament")
    if interface is not None and interface not in filaments:
        raise ProfileError(f"{where} support interface_filament {interface!r} is not one of the filaments: {', '.join(filaments)}")
    process_settings = data.get("process_settings", {})
    if not isinstance(process_settings, Mapping):
        raise ProfileError(f"{where} process_settings must be an object of Bambu setting names and values")
    for key, value in process_settings.items():
        if key in OWN_CORRECTIONS:
            raise ProfileError(
                f"{where} process_settings {key}: hole and contour compensation is measured per printer and filament "
                "and saved with save-compensation (see the cad skill's references/print.md), not set for every print"
            )
        # Bambu Studio reads its settings as text and silently ignores numbers or booleans.
        if not (isinstance(value, str) or isinstance(value, list) and all(isinstance(v, str) for v in value)):
            raise ProfileError(
                f"{where} process_settings {key} must be text as Bambu Studio writes it, such as \"{value}\", not {value!r}"
            )
    bambu_studio = data.get("bambu_studio")
    return PrintProfile(
        printer=_text(f"{where} printer", data["printer"]),
        process=_text(f"{where} process", data["process"]),
        bed_type=bed_type,
        filament=default,
        filaments=filaments,
        support_type=support_type,
        support_interface=interface,
        process_settings={str(key): value for key, value in process_settings.items()},
        bambu_studio=_text(f"{where} bambu_studio", bambu_studio) if bambu_studio is not None else None,
    )


def _read(path: Path) -> dict:
    if not path.is_file():
        raise ProfileError(
            f"No personal print profile at {path}. Ask the user which printer, nozzle, process, filament, "
            "colour, build plate and supports they use, then write it (see the cad skill's references/print.md)."
        )
    try:
        personal = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ProfileError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(personal, dict):
        raise ProfileError(f"{path} must hold a JSON object")
    _unknown(str(path), personal, KEYS)
    return personal


def load_profile(overrides: Mapping | None = None, *, path: Path = PROFILE_PATH) -> PrintProfile:
    """The personal profile with a project's overrides on top."""
    personal = _read(path)
    if overrides:
        _unknown("project print settings", overrides, KEYS)
    return parse_profile(_merge(dict(personal), overrides or {}), where=str(path) if not overrides else "print profile with project overrides")


def record_compensation(filament: str, printer: str, measurements: Mapping[str, Measurement], *, write: bool, path: Path = PROFILE_PATH) -> PrintProfile:
    """The personal profile with measured compensation for one filament on one printer, and nothing
    else changed; ``write`` saves it to the profile's file."""
    personal = _read(path)
    if filament not in parse_profile(personal, where=str(path)).filaments:
        raise ProfileError(f"{path} has no filament {filament!r}")
    kinds = personal["filaments"][filament].setdefault("compensation", {}).setdefault(printer, {})
    kinds.update({kind: m.as_dict() for kind, m in measurements.items()})
    profile = parse_profile(personal, where=str(path))
    if write:
        with replacing(path) as temporary:
            temporary.write_text(json.dumps(personal, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return profile
