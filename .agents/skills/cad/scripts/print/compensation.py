"""X-Y hole and contour compensation per part: the value measured for its filament on the profile's
printer, or 0 when it is unmeasured or the part is a calibration coupon, and which of the conditions
it was measured with have changed since."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field

from .bambu import setting
from .profile import COMPENSATION_SETTINGS, CONDITIONS, NUMBER_CONDITIONS, Measurement, PrintProfile


@dataclass(frozen=True)
class Compensation:
    """``measurement`` is None when the value is 0 because nothing is measured or a calibration coupon
    forces it; ``changed`` maps each condition that differs to its value then and now."""

    kind: str
    mm: float
    measurement: Measurement | None = None
    changed: dict[str, tuple[float | str, float | str]] = field(default_factory=dict)

    @property
    def setting(self) -> str:
        return COMPENSATION_SETTINGS[self.kind]

    def as_dict(self) -> dict:
        return {
            "setting": self.setting,
            "mm": self.mm,
            "measurement": self.measurement.as_dict() if self.measurement else None,
            "changed_since_measured": {key: {"then": then, "now": now} for key, (then, now) in self.changed.items()},
        }


def conditions(settings: Mapping, filament_preset: str) -> dict[str, float | str]:
    """The conditions a measured compensation holds with: from a project's full Bambu settings, its
    resolution, closing radius and process preset, and the part's filament preset."""
    return {
        **{key: float(setting(settings[key])) for key in NUMBER_CONDITIONS},
        "process": setting(settings["print_settings_id"]),
        "filament_preset": filament_preset,
    }


def condition_text(key: str, value: float | str) -> str:
    return f"{key} {value:g}" if isinstance(value, float) else f'{key} "{value}"'


def _same(then: float | str, now: float | str) -> bool:
    if isinstance(then, float) and isinstance(now, float):
        return math.isclose(then, now, rel_tol=1e-9, abs_tol=1e-12)
    return then == now


def part_compensation(profile: PrintProfile, filament: str, now: Mapping[str, float | str], *, calibrating: bool) -> list[Compensation]:
    measured = {} if calibrating else profile.measured(filament)
    found = []
    for kind in COMPENSATION_SETTINGS:
        measurement = measured.get(kind)
        if measurement is None:
            found.append(Compensation(kind, 0.0))
            continue
        then = measurement.conditions
        changed = {key: (then[key], now[key]) for key in CONDITIONS if not _same(then[key], now[key])}
        found.append(Compensation(kind, measurement.mm, measurement, changed))
    return found
