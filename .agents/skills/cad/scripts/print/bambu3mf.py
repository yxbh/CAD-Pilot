"""Bambu Studio project 3MFs: a print plan written as one, with meshes on named plates, per-object
filament and support settings, and the full project settings, as Bambu Studio's own reader expects
them; and a project's settings, plates and objects read back."""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

from common.threemf import CORE_NS, append_component_object, append_mesh_object, build_model_root, format_number, write_package

from .bambu import BambuStudioError
from .plan import Instance, ProjectPlan, plate_origin


# The model metadata that marks a calibration coupon's project with the compensation it measures.
# Bambu Studio keeps model metadata it does not know when it saves a project.
CALIBRATION_KEY = "CADPilot:Calibration"


@dataclass(frozen=True)
class ProjectFile:
    """A project's full settings, its plate names in plate order, each object's own metadata (its
    name and the settings it overrides) and the model's metadata."""

    settings: dict
    plates: list[str]
    objects: list[dict[str, str]]
    metadata: dict[str, str]


def _metadata(parent: ET.Element, key: str, value: object) -> None:
    ET.SubElement(parent, "metadata", {"key": key, "value": str(value)})


def _transform(plan: ProjectPlan, plate: int, instance: Instance) -> str:
    """The build item's 3MF transform (row vectors): an optional quarter turn about Z, then the move
    onto its spot on its plate."""
    origin_x, origin_y = plate_origin(plate, len(plan.plates), plan.bed)
    rect = instance.rect
    if instance.turned:
        # (x, y) -> (-y, x) turns the footprint [0, w] x [0, d] to [-d, 0] x [0, w].
        rotation, x = (0, 1, 0, -1, 0, 0, 0, 0, 1), rect.x1
    else:
        rotation, x = (1, 0, 0, 0, 1, 0, 0, 0, 1), rect.x0
    return " ".join(format_number(v) for v in (*rotation, origin_x + x, origin_y + rect.y0, 0.0))


def model_settings_xml(plan: ProjectPlan, object_ids: dict[tuple[int, int], int], mesh_ids: list[int]) -> bytes:
    config = ET.Element("config")
    for plate in plan.plates:
        for instance in plate.instances:
            part = plan.parts[instance.part]
            item = ET.SubElement(config, "object", {"id": str(object_ids[(instance.part, instance.copy)])})
            _metadata(item, "name", plan.instance_name(instance))
            _metadata(item, "extruder", part.slot.number)
            for key, value in sorted(part.object_settings.items()):
                _metadata(item, key, value)
            volume = ET.SubElement(item, "part", {"id": str(mesh_ids[instance.part]), "subtype": "normal_part"})
            _metadata(volume, "name", part.spec.name)
    for number, plate in enumerate(plan.plates, start=1):
        element = ET.SubElement(config, "plate")
        _metadata(element, "plater_id", number)
        _metadata(element, "plater_name", plate.name)
        _metadata(element, "locked", "false")
        for instance in plate.instances:
            object_id = object_ids[(instance.part, instance.copy)]
            placed = ET.SubElement(element, "model_instance")
            _metadata(placed, "object_id", object_id)
            _metadata(placed, "instance_id", 0)
            _metadata(placed, "identify_id", object_id)
    return ET.tostring(config, encoding="utf-8", xml_declaration=True)


def write_project(plan: ProjectPlan, path: Path) -> Path:
    model, resources, build = build_model_root(
        {
            # Bambu Studio reads plates and settings only from a project its own name stamps.
            "Application": f"BambuStudio-{plan.version}",
            "BambuStudio:3mfVersion": "1",
            "Title": plan.job.name,
            "CreationDate": date.today().isoformat(),
            **({CALIBRATION_KEY: plan.calibration} if plan.calibration else {}),
        }
    )
    next_id = 1
    mesh_ids: list[int] = []
    shared: dict[int, int] = {}
    for index, part in enumerate(plan.parts):
        key = id(part.mesh)
        if key not in shared:
            append_mesh_object(resources, object_id=next_id, name=part.spec.name, vertices=part.mesh.vertices.tolist(), triangles=part.mesh.faces.tolist())
            shared[key] = next_id
            next_id += 1
        mesh_ids.append(shared[key])
    object_ids: dict[tuple[int, int], int] = {}
    for number, plate in enumerate(plan.plates):
        for instance in plate.instances:
            object_ids[(instance.part, instance.copy)] = next_id
            append_component_object(resources, object_id=next_id, name=plan.instance_name(instance), components=[(mesh_ids[instance.part], None)])
            ET.SubElement(
                build,
                f"{{{CORE_NS}}}item",
                {"objectid": str(next_id), "transform": _transform(plan, number, instance), "printable": "1"},
            )
            next_id += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    return write_package(
        path,
        ET.tostring(model, encoding="utf-8", xml_declaration=True),
        parts={
            "Metadata/model_settings.config": model_settings_xml(plan, object_ids, mesh_ids),
            "Metadata/project_settings.config": json.dumps(plan.settings, indent=4).encode("utf-8"),
        },
        content_types={"config": "application/xml"},
    )


def _model_metadata(archive: zipfile.ZipFile) -> dict[str, str]:
    """The model's metadata, which comes before its meshes, read without parsing them."""
    found = {}
    with archive.open("3D/3dmodel.model") as model:
        for event, element in ET.iterparse(model, events=("start", "end")):
            if event == "start" and element.tag == f"{{{CORE_NS}}}resources":
                break
            if event == "end" and element.tag == f"{{{CORE_NS}}}metadata":
                found[element.get("name", "")] = element.text or ""
    return found


def read_project(path: Path) -> ProjectFile:
    """What a Bambu Studio project holds, written by this tool or by Bambu Studio itself."""
    try:
        with zipfile.ZipFile(path) as archive:
            settings = json.loads(archive.read("Metadata/project_settings.config"))
            config = ET.fromstring(archive.read("Metadata/model_settings.config"))
            metadata = _model_metadata(archive)
    except (zipfile.BadZipFile, KeyError, ValueError, ET.ParseError) as error:
        raise BambuStudioError(
            f"{path} is not a Bambu Studio project ({error}); a plain 3MF has no plates or settings to slice"
        ) from error
    plates = []
    for plate in config.iter("plate"):
        values = {m.get("key"): m.get("value") for m in plate.findall("metadata")}
        plates.append((int(values.get("plater_id", len(plates) + 1)), values.get("plater_name") or ""))
    objects = [{m.get("key"): m.get("value") for m in item.findall("metadata") if m.get("key")} for item in config.iter("object")]
    return ProjectFile(settings, [name for _, name in sorted(plates)], objects, metadata)
