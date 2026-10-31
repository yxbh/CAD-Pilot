"""Print plans: a job's parts meshed, turned and checked, their filament slots, the full Bambu Studio
settings, and each plate's layout."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

from .bambu import BED_TEMPERATURE_KEYS, BambuStudio, setting
from .job import Job, PartSpec
from .layout import Footprint, Rect, pack
from .meshes import PrintMesh, load_mesh
from .orientation import CheckSettings, OrientationReport, check_orientation
from .profile import PrintProfile


EDGE_MARGIN_MM = 5.0
PART_GAP_MM = 8.0
# Bambu Studio moves a prime tower closer than this to the edge of the area every nozzle reaches.
TOWER_MARGIN_MM = 15.0
# Room kept for a prime tower and its brim: Bambu sizes the tower from the purge volume and the
# tallest part, and this covers it for parts up to the H2D's full height.
TOWER_SIZE_MM = 60.0
TOWER_BRIM_MM = 8.0
MAX_PLATES = 36  # the most a Bambu Studio project holds; its command line crashes loading more
# Bambu Studio's default purge between two filaments, and to load or unload one (mm³).
PURGE_MM3 = 280
LOAD_UNLOAD_MM3 = 140
# Bambu Studio's advice for a support interface in another material: no gap between the interface
# and the part, a solid interface, and support layers that match the part's.
ZERO_GAP_INTERFACE = {
    "support_top_z_distance": "0",
    "support_bottom_z_distance": "0",
    "support_interface_spacing": "0",
    "support_interface_pattern": "rectilinear_interlaced",
    "independent_support_layer_height": "0",
}


class PlanError(ValueError):
    pass


@dataclass(frozen=True)
class Slot:
    number: int
    key: str
    preset: str
    colour: str
    material: str


@dataclass
class PartPlan:
    spec: PartSpec
    mesh: PrintMesh
    check: OrientationReport
    slot: Slot
    uses_interface: bool
    object_settings: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Instance:
    part: int
    copy: int
    rect: Rect
    turned: bool


@dataclass
class PlatePlan:
    name: str
    instances: list[Instance]
    tower: Rect | None


@dataclass
class ProjectPlan:
    job: Job
    profile: PrintProfile
    parts: list[PartPlan]
    slots: list[Slot]
    plates: list[PlatePlan]
    settings: dict
    bed: Rect

    @property
    def version(self) -> str:
        return str(self.settings.get("version", ""))

    def instance_name(self, instance: Instance) -> str:
        part = self.parts[instance.part]
        return part.spec.name if part.spec.copies == 1 else f"{part.spec.name} {instance.copy}"


def _rect(points: list[str] | str) -> Rect:
    """The bounding rectangle of Bambu's "XxY" corner lists."""
    if isinstance(points, str):
        points = points.split(",")
    xy = [tuple(float(v) for v in point.split("x")) for point in points if point]
    return Rect(min(x for x, _ in xy), min(y for _, y in xy), max(x for x, _ in xy), max(y for _, y in xy))


def _keep_outs(settings: dict) -> list[Rect]:
    rects = []
    for key in ("bed_exclude_area", "wrapping_exclude_area"):
        points = [point for point in settings.get(key) or [] if point and point != "0x0"]
        for start in range(0, len(points) - len(points) % 4, 4):
            rect = _rect(points[start : start + 4])
            if rect.width > 0 and rect.depth > 0:
                rects.append(rect)
    return rects


def _slots(job: Job, profile: PrintProfile, material: Callable[[str], str]) -> tuple[list[Slot], dict[PartSpec, Slot]]:
    slots: dict[tuple[str, str], Slot] = {}
    by_part = {}
    for spec in job.parts:
        key = spec.filament or profile.filament
        if key not in profile.filaments:
            raise PlanError(f"part {spec.name!r} asks for filament {key!r}; the print profile has {', '.join(profile.filaments)}")
        filament = profile.filaments[key]
        colour = spec.colour or filament.colour
        if (key, colour) not in slots:
            slots[(key, colour)] = Slot(len(slots) + 1, key, filament.preset, colour, material(filament.preset))
        by_part[spec] = slots[(key, colour)]
    return list(slots.values()), by_part


def _tower(settings: dict, reach: Rect, keep_out: list[Rect]) -> Rect:
    """Where the prime tower goes: the printer's default spot, moved inside the area every nozzle
    reaches (the H2D's default sits outside its right nozzle's reach) and clear of the bed's
    excluded areas. The command line, unlike the app, does not move a tower that is out of place."""
    x = float(setting(settings.get("wipe_tower_x", ["15"])))
    y = float(setting(settings.get("wipe_tower_y", ["220"])))
    low, high = reach.x0 + TOWER_MARGIN_MM, reach.x1 - TOWER_MARGIN_MM - TOWER_SIZE_MM
    candidates = [min(max(x, low), high)] + [low + 5.0 * step for step in range(int(max(high - low, 0) // 5) + 1)]
    for candidate in candidates:
        tower = Rect(candidate, y, candidate + TOWER_SIZE_MM, y + TOWER_SIZE_MM)
        if not any(tower.grown(TOWER_BRIM_MM).overlaps(rect) for rect in keep_out):
            return tower
    raise PlanError("the bed has no room for a prime tower clear of its excluded areas")


def _reach(settings: dict) -> Rect:
    bed = _rect(settings["printable_area"])
    for area in settings.get("extruder_printable_area") or []:
        nozzle = _rect(area)
        bed = Rect(max(bed.x0, nozzle.x0), max(bed.y0, nozzle.y0), min(bed.x1, nozzle.x1), min(bed.y1, nozzle.y1))
    return bed


def _max_height(settings: dict) -> float:
    heights = [float(setting(settings["printable_height"]))]
    heights += [float(h) for h in settings.get("extruder_printable_height") or []]
    return min(heights)


def _pack_plates(plan_parts: list[PartPlan], job: Job, area: Rect, keep_out: list[Rect], tower: Rect, interface: Slot | None) -> list[PlatePlan]:
    def needs_tower(indices: set[int]) -> bool:
        slots = {plan_parts[i].slot.number for i in indices}
        if interface is not None and any(plan_parts[i].uses_interface for i in indices):
            slots.add(interface.number)
        return len(slots) > 1

    footprints: list[list[Footprint]] = []
    index = 0
    for plate in job.plates:
        items = []
        for spec in plate.parts:
            width, depth, _ = (float(v) for v in plan_parts[index].mesh.size)
            items += [Footprint((index, copy), width, depth, spec.turn) for copy in range(1, spec.copies + 1)]
            index += 1
        footprints.append(items)
    plates: list[PlatePlan] = []
    for plate, remaining in zip(job.plates, footprints):
        while remaining:
            reserve = needs_tower({item.key[0] for item in remaining})
            placed, remaining = pack(remaining, area, keep_out + ([tower.grown(TOWER_BRIM_MM)] if reserve else []), PART_GAP_MM)
            if not placed:
                item = remaining[0]
                raise PlanError(
                    f"{plan_parts[item.key[0]].spec.name} ({item.width:.1f} x {item.depth:.1f} mm) does not fit the usable plate area "
                    f"X {area.x0:g}..{area.x1:g}, Y {area.y0:g}..{area.y1:g} mm"
                    + (" beside the prime tower" if reserve else "")
                )
            if remaining and not job.auto_plates:
                names = ", ".join(sorted({plan_parts[item.key[0]].spec.name for item in remaining}))
                raise PlanError(
                    f"plate {plate.name!r} is full: {names} do not fit beside the rest. Move them to another named plate."
                )
            name = plate.name if not plates or not job.auto_plates else f"{plate.name} {len(plates) + 1}"
            instances = [Instance(p.key[0], p.key[1], p.rect, p.turned) for p in placed]
            used = {i.part for i in instances}
            plates.append(PlatePlan(name, sorted(instances, key=lambda i: (i.part, i.copy)), tower if needs_tower(used) else None))
    if job.auto_plates and len(plates) > 1:
        plates[0].name = f"{plates[0].name} 1"
    if len(plates) > MAX_PLATES:
        raise PlanError(f"{len(plates)} plates; a Bambu Studio project holds at most {MAX_PLATES}. Split the job.")
    return plates


def _project_settings(resolved: dict, profile: PrintProfile, slots: list[Slot], interface: Slot | None, system_process: dict, plate_count: int, tower: Rect) -> dict:
    settings = dict(resolved)
    overrides: dict[str, object] = {"enable_support": "1", "support_type": profile.support_type, **profile.process_settings}
    if interface is not None:
        overrides.update(support_interface_filament=str(interface.number), **ZERO_GAP_INTERFACE)
    settings.update(overrides)
    settings["curr_bed_type"] = profile.bed_type
    # The command line crashes slicing several filaments when any slot lacks a colour.
    settings["filament_colour"] = [slot.colour for slot in slots]
    settings["filament_map"] = ["1"] * len(slots)
    # Slicing refuses purge tables not sized for every nozzle and pair of filaments, and the
    # settings export does not size them; the app fills them from Bambu's defaults the same way.
    nozzles, count = len(settings.get("nozzle_diameter") or ["0.4"]), len(slots)
    settings["flush_volumes_matrix"] = [
        "0" if row == column else str(PURGE_MM3) for _ in range(nozzles) for row in range(count) for column in range(count)
    ]
    settings["flush_volumes_vector"] = [str(LOAD_UNLOAD_MM3)] * (2 * count)
    settings["flush_multiplier"] = ["1"] * nozzles
    # The settings export leaves the nozzle list empty and slicing then finds no valid nozzle;
    # Bambu Studio's own projects list one nozzle of the chosen flow type per extruder.
    if not settings.get("extruder_nozzle_stats"):
        settings["extruder_nozzle_stats"] = [f"{volume}#1" for volume in settings.get("nozzle_volume_type", ["Standard"])]
    settings["wipe_tower_x"] = [f"{tower.x0:g}"] * plate_count
    settings["wipe_tower_y"] = [f"{tower.y0:g}"] * plate_count
    changed = sorted(key for key, value in overrides.items() if key in system_process and system_process[key] != value)
    # One entry each for the process, every filament, then the printer.
    settings["different_settings_to_system"] = [";".join(changed), *[""] * len(slots), ""]
    settings["inherits_group"] = ["", *[""] * len(slots), ""]
    return settings


def plan_project(job: Job, profile: PrintProfile, studio: BambuStudio) -> ProjectPlan:
    presets = studio.presets()
    presets.require("machine", profile.printer)
    presets.require("process", profile.process)
    machine = presets.flat("machine", profile.printer)
    system_process = presets.flat("process", profile.process)
    process = {**system_process, **profile.process_settings}
    checks = CheckSettings.from_settings({**machine, **process})

    def material(preset: str) -> str:
        # Only the filaments a job uses need presets in this installation.
        return setting(presets.flat("filament", preset)["filament_type"])

    slots, slot_of = _slots(job, profile, material)

    loaded: dict = {}
    oriented: dict = {}
    parts: list[PartPlan] = []
    for spec in job.parts:
        if spec.file not in loaded:
            loaded[spec.file] = load_mesh(spec.file)
        key = (spec.file, spec.rotate)
        if key not in oriented:
            mesh = loaded[spec.file].oriented(spec.rotate)
            oriented[key] = (mesh, check_orientation(mesh, checks))
        mesh, check = oriented[key]
        parts.append(PartPlan(spec, mesh, check, slot_of[spec], False))

    interface = None
    if profile.support_interface is not None:
        filament = profile.filaments[profile.support_interface]
        interface_material = material(filament.preset)
        for part in parts:
            part.uses_interface = part.spec.support and part.check.needs_support and part.slot.material != interface_material
        if any(part.uses_interface for part in parts):
            interface = next((s for s in slots if (s.key, s.colour) == (filament.key, filament.colour)), None)
            if interface is None:
                interface = Slot(len(slots) + 1, filament.key, filament.preset, filament.colour, interface_material)
                slots.append(interface)
            for part in parts:
                if part.spec.support and not part.uses_interface:
                    # Support the check did not expect, or under the interface's own material, stays in
                    # the part's filament with the process's gaps: no second filament, no unplanned tower.
                    part.object_settings.update({key: setting(process[key]) for key in ZERO_GAP_INTERFACE if key in process})
                    part.object_settings["support_interface_filament"] = "0"
    for part in parts:
        if not part.spec.support:
            part.object_settings["enable_support"] = "0"

    resolved = studio.resolved_settings(profile.printer, profile.process, [slot.preset for slot in slots])
    temperatures = resolved.get(BED_TEMPERATURE_KEYS[profile.bed_type], [])
    for slot in slots:
        value = temperatures[slot.number - 1] if slot.number - 1 < len(temperatures) else None
        if value is not None and float(value) <= 0:
            raise PlanError(f"{slot.preset} cannot be printed on the {profile.bed_type} (Bambu sets no bed temperature for it)")

    bed = _rect(resolved["printable_area"])
    reach = _reach(resolved)
    area = Rect(reach.x0 + EDGE_MARGIN_MM, reach.y0 + EDGE_MARGIN_MM, reach.x1 - EDGE_MARGIN_MM, reach.y1 - EDGE_MARGIN_MM)
    max_height = _max_height(resolved)
    for part in parts:
        height = float(part.mesh.size[2])
        if height > max_height:
            raise PlanError(f"{part.spec.name} is {height:.1f} mm tall in this orientation; the printer takes {max_height:g} mm")
    keep_out = _keep_outs(resolved)
    tower = _tower(resolved, reach, keep_out)
    plates = _pack_plates(parts, job, area, keep_out, tower, interface)
    settings = _project_settings(resolved, profile, slots, interface, system_process, len(plates), tower)
    return ProjectPlan(job, profile, parts, slots, plates, settings, bed)


def plate_origin(index: int, plate_count: int, bed: Rect) -> tuple[float, float]:
    """Where Bambu Studio lays out plate ``index`` (0-based): a grid of square-ish columns, each a
    fifth of a bed apart."""
    columns = math.ceil(math.sqrt(plate_count))
    row, column = divmod(index, columns)
    return column * bed.x1 * 1.2, -row * bed.y1 * 1.2
