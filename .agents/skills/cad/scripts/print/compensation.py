"""X-Y hole and contour compensation per part: the value measured for its filament on the profile's
printer, or 0 when it is unmeasured or the part is a calibration coupon, and which of the slicing
conditions it was measured at have changed since."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field

from .bambu import setting
from .profile import COMPENSATION_SETTINGS, CONDITIONS, Measurement, PrintProfile


@dataclass(frozen=True)
class Compensation:
    """``measurement`` is None when the value is 0 because nothing is measured or a calibration coupon
    forces it; ``changed`` maps each condition that differs to its value then and now."""

    kind: str
    mm: float
    measurement: Measurement | None = None
    changed: dict[str, tuple[float, float]] = field(default_factory=dict)

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


def conditions(settings: Mapping) -> dict[str, float]:
    """The slicing conditions a measured compensation holds at, from full Bambu settings."""
    return {key: float(setting(settings[key])) for key in CONDITIONS}


def part_compensation(profile: PrintProfile, filament: str, now: Mapping[str, float], *, calibrating: bool) -> list[Compensation]:
    measured = {} if calibrating else profile.measured(filament)
    found = []
    for kind in COMPENSATION_SETTINGS:
        measurement = measured.get(kind)
        if measurement is None:
            found.append(Compensation(kind, 0.0))
            continue
        changed = {
            key: (getattr(measurement, key), now[key])
            for key in CONDITIONS
            if not math.isclose(getattr(measurement, key), now[key], rel_tol=1e-9, abs_tol=1e-12)
        }
        found.append(Compensation(kind, measurement.mm, measurement, changed))
    return found
