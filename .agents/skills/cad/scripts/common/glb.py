from __future__ import annotations

import json
import struct
from array import array
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from common.glb_mesh_payload import (
    CAD_TO_GLB_SCALE,
    DEFAULT_MATERIAL,
    color_key,
    normalize_rgba,
    occurrence_color_for_id,
    scene_glb_mesh_payload,
    scene_glb_mesh_payload_key,
)
from common.glb_topology import STEP_TOPOLOGY_EXTENSION, STEP_TOPOLOGY_SCHEMA_VERSION
from common.render import part_glb_path
from common.step_scene import ColorRGBA, LoadedStepScene, OccurrenceNode, SelectorBundle, occurrence_selector_id


ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_INT = 5125
TRIANGLES = 4


def export_part_glb_from_scene(
    step_path: Path,
    scene: LoadedStepScene,
    *,
    linear_deflection: float,
    angular_deflection: float,
    color: tuple[float, float, float, float] | None = None,
    selector_bundle: SelectorBundle | None = None,
    include_selector_topology: bool = True,
) -> Path:
    target_path = part_glb_path(step_path)
    # The hierarchical writer handles plain part scenes too, and unlike the
    # build123d GLB exporter it preserves XCAF colors and occurrence ids.
    _ = (linear_deflection, angular_deflection)
    return _HierarchicalGlbWriter(scene, color=color).write(
        target_path,
        selector_bundle=selector_bundle,
        include_selector_topology=include_selector_topology,
        entry_kind="part",
    )


def export_assembly_glb_from_scene(
    step_path: Path,
    scene: LoadedStepScene,
    *,
    linear_deflection: float,
    angular_deflection: float,
    color: tuple[float, float, float, float] | None = None,
    occurrence_colors: Mapping[str, ColorRGBA] | None = None,
    selector_bundle: SelectorBundle | None = None,
    include_selector_topology: bool = True,
) -> Path:
    target_path = part_glb_path(step_path)
    # The caller meshes the scene before scheduling artifact jobs. Keep the
    # deflection args on this API so assembly/part exports share one contract.
    _ = (linear_deflection, angular_deflection)
    return _HierarchicalGlbWriter(scene, color=color, occurrence_colors=occurrence_colors).write(
        target_path,
        selector_bundle=selector_bundle,
        include_selector_topology=include_selector_topology,
        entry_kind="assembly",
    )


def write_scene_glb(
    scene: LoadedStepScene,
    target_path: Path,
    *,
    selector_bundle: SelectorBundle,
    entry_kind: str,
) -> Path:
    """A topology GLB for a STEP read from disk, written wherever the caller keeps it."""
    return _HierarchicalGlbWriter(scene, color=None).write(
        target_path,
        selector_bundle=selector_bundle,
        include_selector_topology=True,
        entry_kind=entry_kind,
    )


def write_empty_glb(target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    json_chunk = b'{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}],"scene":0,"nodes":[]}'
    json_chunk += b" " * ((4 - (len(json_chunk) % 4)) % 4)
    chunk_header = len(json_chunk).to_bytes(4, "little") + b"JSON"
    payload = b"glTF" + (2).to_bytes(4, "little") + (12 + len(chunk_header) + len(json_chunk)).to_bytes(4, "little")
    target_path.write_bytes(payload + chunk_header + json_chunk)
    return target_path


def build_step_topology_index_manifest(
    manifest: Mapping[str, Any],
    *,
    entry_kind: str | None = None,
) -> dict[str, Any]:
    resolved_entry_kind = str(entry_kind or "").strip().lower()
    assembly = manifest.get("assembly")
    if not resolved_entry_kind:
        resolved_entry_kind = "assembly" if isinstance(assembly, Mapping) else "part"
    if resolved_entry_kind not in {"part", "assembly"}:
        resolved_entry_kind = "part"

    tables = manifest.get("tables") if isinstance(manifest.get("tables"), Mapping) else {}
    occurrence_columns = tables.get("occurrenceColumns") if isinstance(tables, Mapping) else None
    index: dict[str, Any] = {
        "schemaVersion": STEP_TOPOLOGY_SCHEMA_VERSION,
        "profile": "index",
        "entryKind": resolved_entry_kind,
    }
    for key in ("cadRef", "stepPath", "stepHash", "bbox", "stats"):
        value = manifest.get(key)
        if value is not None:
            index[key] = value
    if isinstance(occurrence_columns, list):
        index["tables"] = {"occurrenceColumns": occurrence_columns}
    occurrences = manifest.get("occurrences")
    if isinstance(occurrences, list):
        index["occurrences"] = occurrences
    if isinstance(assembly, Mapping):
        index["assembly"] = assembly
        index["entryKind"] = "assembly"
    return index


def _gltf_matrix_from_transform(transform: tuple[float, ...]) -> list[float]:
    if len(transform) != 16:
        transform = (
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        )
    return [
        float(transform[0]), float(transform[4]), float(transform[8]), 0.0,
        float(transform[1]), float(transform[5]), float(transform[9]), 0.0,
        float(transform[2]), float(transform[6]), float(transform[10]), 0.0,
        float(transform[3]) * CAD_TO_GLB_SCALE,
        float(transform[7]) * CAD_TO_GLB_SCALE,
        float(transform[11]) * CAD_TO_GLB_SCALE,
        1.0,
    ]


class _GlbBuilder:
    def __init__(self) -> None:
        self.json: dict[str, object] = {
            "asset": {"version": "2.0", "generator": "tom-cad"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "buffers": [{"byteLength": 0}],
            "bufferViews": [],
            "accessors": [],
        }
        self.binary = bytearray()

    def add_material(self, color: ColorRGBA) -> int:
        materials = self.json["materials"]
        assert isinstance(materials, list)
        materials.append(
            {
                "pbrMetallicRoughness": {
                    "baseColorFactor": [float(color[0]), float(color[1]), float(color[2]), float(color[3])],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.55,
                },
                "doubleSided": True,
            }
        )
        return len(materials) - 1

    def add_buffer_view(self, payload: bytes, *, target: int | None = None) -> int:
        while len(self.binary) % 4:
            self.binary.append(0)
        offset = len(self.binary)
        self.binary.extend(payload)
        while len(self.binary) % 4:
            self.binary.append(0)
        buffer_views = self.json["bufferViews"]
        assert isinstance(buffer_views, list)
        view: dict[str, object] = {
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": len(payload),
        }
        if target is not None:
            view["target"] = target
        buffer_views.append(view)
        return len(buffer_views) - 1

    def add_accessor(
        self,
        values: array,
        *,
        component_type: int,
        accessor_type: str,
        target: int,
        count: int,
        minimum: list[float] | None = None,
        maximum: list[float] | None = None,
    ) -> int:
        buffer_view = self.add_buffer_view(values.tobytes(), target=target)
        accessor: dict[str, object] = {
            "bufferView": buffer_view,
            "byteOffset": 0,
            "componentType": component_type,
            "count": count,
            "type": accessor_type,
        }
        if minimum is not None:
            accessor["min"] = minimum
        if maximum is not None:
            accessor["max"] = maximum
        accessors = self.json["accessors"]
        assert isinstance(accessors, list)
        accessors.append(accessor)
        return len(accessors) - 1

    def add_mesh(
        self,
        positions: array,
        normals: array,
        primitives: list[tuple[array, int]],
        *,
        minimum: list[float],
        maximum: list[float],
        name: str,
    ) -> int | None:
        vertex_count = len(positions) // 3
        if vertex_count <= 0:
            return None
        position_accessor = self.add_accessor(
            positions,
            component_type=FLOAT,
            accessor_type="VEC3",
            target=ARRAY_BUFFER,
            count=vertex_count,
            minimum=minimum,
            maximum=maximum,
        )
        normal_accessor = None
        if len(normals) == len(positions):
            normal_accessor = self.add_accessor(
                normals,
                component_type=FLOAT,
                accessor_type="VEC3",
                target=ARRAY_BUFFER,
                count=vertex_count,
            )
        mesh_primitives = []
        for indices, material in primitives:
            if not indices:
                continue
            index_accessor = self.add_accessor(
                indices,
                component_type=UNSIGNED_INT,
                accessor_type="SCALAR",
                target=ELEMENT_ARRAY_BUFFER,
                count=len(indices),
            )
            mesh_primitives.append(
                {
                    "attributes": {
                        "POSITION": position_accessor,
                        **({"NORMAL": normal_accessor} if normal_accessor is not None else {}),
                    },
                    "indices": index_accessor,
                    "material": material,
                    "mode": TRIANGLES,
                }
            )
        if not mesh_primitives:
            return None
        meshes = self.json["meshes"]
        assert isinstance(meshes, list)
        meshes.append(
            {
                "name": name,
                "primitives": mesh_primitives,
            }
        )
        return len(meshes) - 1

    def add_node(self, node: dict[str, object]) -> int:
        nodes = self.json["nodes"]
        assert isinstance(nodes, list)
        nodes.append(node)
        return len(nodes) - 1

    def set_scene_nodes(self, node_indices: list[int]) -> None:
        scenes = self.json["scenes"]
        assert isinstance(scenes, list)
        scene = scenes[0]
        assert isinstance(scene, dict)
        scene["nodes"] = node_indices

    def add_step_topology(
        self,
        bundle: SelectorBundle,
        *,
        include_selector_topology: bool = True,
        entry_kind: str | None = None,
    ) -> None:
        selector_manifest = dict(bundle.manifest)
        selector_manifest["schemaVersion"] = STEP_TOPOLOGY_SCHEMA_VERSION
        selector_manifest["profile"] = "selector"
        selector_manifest.pop("assembly", None)
        selector_manifest.pop("buffers", None)

        index_manifest = build_step_topology_index_manifest(bundle.manifest, entry_kind=entry_kind)
        selector_manifest["entryKind"] = index_manifest["entryKind"]
        index_payload = json.dumps(index_manifest, separators=(",", ":")).encode("utf-8")
        index_view = self.add_buffer_view(index_payload)

        selector_view: int | None = None
        if include_selector_topology:
            if bundle.buffers:
                selector_manifest["buffers"] = {
                    "littleEndian": True,
                    "views": {
                        name: {
                            "dtype": "float32" if values.typecode == "f" else "uint32",
                            "bufferView": self.add_buffer_view(values.tobytes()),
                            "byteOffset": 0,
                            "byteLength": len(values) * values.itemsize,
                            "count": len(values),
                            "itemSize": values.itemsize,
                        }
                        for name, values in bundle.buffers.items()
                    },
                }
            selector_payload = json.dumps(selector_manifest, separators=(",", ":")).encode("utf-8")
            selector_view = self.add_buffer_view(selector_payload)

        extensions_used = self.json.setdefault("extensionsUsed", [])
        assert isinstance(extensions_used, list)
        if STEP_TOPOLOGY_EXTENSION not in extensions_used:
            extensions_used.append(STEP_TOPOLOGY_EXTENSION)
        extensions = self.json.setdefault("extensions", {})
        assert isinstance(extensions, dict)
        extension: dict[str, object] = {
            "schemaVersion": STEP_TOPOLOGY_SCHEMA_VERSION,
            "entryKind": index_manifest.get("entryKind", "part"),
            "indexView": index_view,
            "encoding": "utf-8",
        }
        if isinstance(index_manifest.get("stats"), Mapping):
            extension["stats"] = index_manifest["stats"]
        if selector_view is not None:
            extension["selectorView"] = selector_view
        extensions[STEP_TOPOLOGY_EXTENSION] = extension
        bundle.manifest = selector_manifest if include_selector_topology else index_manifest

    def write(self, target_path: Path) -> Path:
        if not self.binary:
            return write_empty_glb(target_path)
        buffers = self.json["buffers"]
        assert isinstance(buffers, list)
        buffer = buffers[0]
        assert isinstance(buffer, dict)
        buffer["byteLength"] = len(self.binary)
        json_chunk = json.dumps(self.json, separators=(",", ":")).encode("utf-8")
        json_chunk += b" " * ((4 - (len(json_chunk) % 4)) % 4)
        binary_chunk = bytes(self.binary)
        binary_chunk += b"\0" * ((4 - (len(binary_chunk) % 4)) % 4)
        payload_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(
            b"glTF"
            + struct.pack("<II", 2, payload_length)
            + struct.pack("<I4s", len(json_chunk), b"JSON")
            + json_chunk
            + struct.pack("<I4s", len(binary_chunk), b"BIN\0")
            + binary_chunk
        )
        return target_path


class _HierarchicalGlbWriter:
    def __init__(
        self,
        scene: LoadedStepScene,
        *,
        color: tuple[float, float, float, float] | None,
        occurrence_colors: Mapping[str, ColorRGBA] | None = None,
    ) -> None:
        self.scene = scene
        self.color = color
        self.occurrence_colors = dict(occurrence_colors or {})
        self.builder = _GlbBuilder()
        self.materials_by_color: dict[tuple[int, int, int, int], int] = {}
        self.meshes_by_key: dict[tuple[object, ...], int | None] = {}

    def write(
        self,
        target_path: Path,
        *,
        selector_bundle: SelectorBundle | None = None,
        include_selector_topology: bool = True,
        entry_kind: str | None = None,
    ) -> Path:
        root_nodes = [self._node_index(root) for root in self.scene.roots]
        self.builder.set_scene_nodes(root_nodes)
        if selector_bundle is not None:
            self.builder.add_step_topology(
                selector_bundle,
                include_selector_topology=include_selector_topology,
                entry_kind=entry_kind,
            )
        return self.builder.write(target_path)

    def _occurrence_color_for_node(self, node: OccurrenceNode) -> ColorRGBA | None:
        occurrence_id = occurrence_selector_id(node)
        return occurrence_color_for_id(occurrence_id, self.occurrence_colors)

    def _color_for_node(self, node: OccurrenceNode) -> ColorRGBA:
        if self.color is not None:
            return normalize_rgba(self.color)
        occurrence_color = self._occurrence_color_for_node(node)
        if occurrence_color is not None:
            return occurrence_color
        if node.color is not None:
            return normalize_rgba(node.color)
        if node.prototype_key is not None and node.prototype_key in self.scene.prototype_colors:
            return normalize_rgba(self.scene.prototype_colors[node.prototype_key])
        return DEFAULT_MATERIAL

    def _material_index(self, color: ColorRGBA) -> int:
        key = color_key(color)
        material = self.materials_by_color.get(key)
        if material is None:
            material = self.builder.add_material(color)
            self.materials_by_color[key] = material
        return material

    def _mesh_index(self, node: OccurrenceNode) -> int | None:
        if node.prototype_key is None:
            return None
        color = self._color_for_node(node)
        occurrence_color = self._occurrence_color_for_node(node)
        suppress_face_colors = self.color is not None or occurrence_color is not None
        key = scene_glb_mesh_payload_key(
            self.scene,
            node.prototype_key,
            default_color=color,
            suppress_face_colors=suppress_face_colors,
        )
        if key in self.meshes_by_key:
            return self.meshes_by_key[key]
        payload = scene_glb_mesh_payload(
            self.scene,
            node.prototype_key,
            default_color=color,
            suppress_face_colors=suppress_face_colors,
        )
        mesh = self.builder.add_mesh(
            payload.positions,
            payload.normals,
            [(indices, self._material_index(primitive_color)) for primitive_color, indices in payload.primitives],
            minimum=payload.minimum,
            maximum=payload.maximum,
            name=self.scene.prototype_names.get(node.prototype_key) or occurrence_selector_id(node),
        )
        self.meshes_by_key[key] = mesh
        return mesh

    def _node_index(self, occurrence: OccurrenceNode) -> int:
        occurrence_id = occurrence_selector_id(occurrence)
        node: dict[str, object] = {
            "name": occurrence_id,
            "extras": {
                "cadOccurrenceId": occurrence_id,
                "cadName": occurrence.name or occurrence.source_name or "",
            },
        }
        matrix = _gltf_matrix_from_transform(occurrence.local_transform)
        if matrix != _gltf_matrix_from_transform((1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)):
            node["matrix"] = matrix
        mesh = self._mesh_index(occurrence)
        if mesh is not None:
            node["mesh"] = mesh
        children = [self._node_index(child) for child in occurrence.children]
        if children:
            node["children"] = children
        return self.builder.add_node(node)
