"""The personal print profile: printer, process, plate, filaments and supports, stored once per user
and overridden per project."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .bambu import BED_TEMPERATURE_KEYS


PROFILE_PATH = Path.home() / ".cad-pilot" / "print-profile.json"
SUPPORT_TYPES = ("tree(auto)", "normal(auto)")
COLOUR = re.compile(r"#[0-9A-Fa-f]{6}")
KEYS = {"printer", "process", "bed_type", "filament", "filaments", "support", "process_settings", "bambu_studio"}
SUPPORT_KEYS = {"type", "interface_filament"}
FILAMENT_KEYS = {"preset", "colour"}


class ProfileError(ValueError):
    pass


@dataclass(frozen=True)
class Filament:
    key: str
    preset: str
    colour: str


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
            "filaments": {key: {"preset": f.preset, "colour": f.colour} for key, f in self.filaments.items()},
            "support": {"type": self.support_type, "interface_filament": self.support_interface},
            "process_settings": dict(self.process_settings),
            **({"bambu_studio": self.bambu_studio} if self.bambu_studio else {}),
        }


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


def load_profile(overrides: Mapping | None = None, *, path: Path = PROFILE_PATH) -> PrintProfile:
    """The personal profile with a project's overrides on top."""
    if not path.is_file():
        raise ProfileError(
            f"No personal print profile at {path}. Ask the user which printer, nozzle, process, filament, "
            "colour, build plate and supports they use, then write it (see the cad skill's references/print.md)."
        )
    try:
        personal = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ProfileError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(personal, Mapping):
        raise ProfileError(f"{path} must hold a JSON object")
    _unknown(str(path), personal, KEYS)
    if overrides:
        _unknown("project print settings", overrides, KEYS)
    return parse_profile(_merge(dict(personal), overrides or {}), where=str(path) if not overrides else "print profile with project overrides")
