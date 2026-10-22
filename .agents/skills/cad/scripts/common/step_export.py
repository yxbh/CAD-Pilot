from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from common.atomic_replace import replacing
from common.step_scene import LoadedStepScene, load_step_scene_from_xcaf_doc, step_file_hash


def create_bin_xcaf_doc() -> Any:
    from OCP.BinXCAFDrivers import BinXCAFDrivers
    from build123d.exporters3d import (
        TCollection_ExtendedString,
        TDocStd_Document,
        UNITS_PER_METER,
        Unit,
        XCAFApp_Application,
        XCAFDoc_DocumentTool,
    )

    doc = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    application = XCAFApp_Application.GetApplication_s()
    BinXCAFDrivers.DefineFormat_s(application)
    application.NewDocument(TCollection_ExtendedString("BinXCAF"), doc)
    application.InitDocument(doc)
    XCAFDoc_DocumentTool.SetLengthUnit_s(doc, 1 / UNITS_PER_METER[Unit.MM])
    return doc


def _create_bin_xcaf_doc(to_export: Any) -> Any:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.TopLoc import TopLoc_Location
    from build123d.exporters3d import (
        Compound,
        Curve,
        Part,
        PreOrderIter,
        Sketch,
        TCollection_ExtendedString,
        TDataStd_Name,
        TopExp_Explorer,
        XCAFDoc_ColorType,
        XCAFDoc_DocumentTool,
        ta,
    )

    doc = create_bin_xcaf_doc()
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    is_assembly = isinstance(to_export, Compound) and len(to_export.children) > 0
    shape_definitions: dict[int, object] = {}
    # STEPCAF collapses definitions backed by the same TShape during transfer.
    # That is normally the desired instance reuse, but it also collapses the
    # definition style: differently coloured occurrences then all receive the
    # last colour. Keep one topology representative per appearance. Copying
    # with copyGeom=False detaches only the topological identity.
    leaf_variants: dict[int, list[tuple[object, dict[object, object]]]] = {}

    def set_label_name(label: object, name: str | None) -> None:
        if name and not label.IsNull():
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(str(name)))

    def set_label_color(label: object, color: object | None) -> None:
        if color is None or label.IsNull():
            return
        color_tool.SetColor(label, color.wrapped, XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    def color_signature(color: object | None) -> tuple[float, float, float, float] | None:
        if color is None:
            return None
        rgb = color.wrapped.GetRGB()
        return (float(rgb.Red()), float(rgb.Green()), float(rgb.Blue()), float(color.wrapped.Alpha()))

    def leaf_shape_for_appearance(unlocated: object, shape: object) -> object:
        signature = color_signature(getattr(shape, "color", None))
        bucket = leaf_variants.setdefault(hash(unlocated), [])
        for native_shape, variants in bucket:
            # IsEqual includes orientation (location is already stripped).
            # IsSame would let a reversed occurrence reuse the forward
            # representative and silently flip its intended topology.
            if unlocated.IsEqual(native_shape):
                representative = variants.get(signature)
                if representative is not None:
                    return representative
                representative = BRepBuilderAPI_Copy(
                    unlocated,
                    False,  # share geometric surfaces and curves
                    False,  # never copy triangulation into the STEP document
                ).Shape()
                variants[signature] = representative
                return representative
        bucket.append((unlocated, {signature: unlocated}))
        return unlocated

    def shape_location(shape: object) -> object:
        wrapped = getattr(shape, "wrapped", None)
        if wrapped is None:
            return TopLoc_Location()
        return wrapped.Location()

    def shape_without_location(shape: object) -> object:
        wrapped = getattr(shape, "wrapped", None)
        if wrapped is None:
            return shape
        return wrapped.Located(TopLoc_Location())

    root_location = shape_location(to_export)

    def shape_definition_for_tree(shape: object) -> object:
        key = id(shape)
        cached = shape_definitions.get(key)
        if cached is not None:
            return cached

        children = list(getattr(shape, "children", []) or [])
        if children:
            definition_label = shape_tool.NewShape()
            shape_definitions[key] = definition_label
            set_label_name(definition_label, getattr(shape, "label", None))
            set_label_color(definition_label, getattr(shape, "color", None))
            for child in children:
                child_definition = shape_definition_for_tree(child)
                child_location = shape_location(child)
                if shape is to_export and not root_location.IsIdentity():
                    # A free assembly definition has no instance placement.
                    # Carry its frame into the immediate child instances;
                    # adding a placed root reference would add a STEP group.
                    child_location = root_location.Multiplied(child_location)
                child_component = shape_tool.AddComponent(
                    definition_label,
                    child_definition,
                    child_location,
                )
                set_label_name(child_component, getattr(child, "label", None))
                set_label_color(child_component, getattr(child, "color", None))
            return definition_label

        unlocated = leaf_shape_for_appearance(shape_without_location(shape), shape)
        definition_label = shape_tool.AddShape(unlocated, False)
        shape_definitions[key] = definition_label
        set_label_name(definition_label, getattr(shape, "label", None))
        set_label_color(definition_label, getattr(shape, "color", None))
        return definition_label

    if is_assembly:
        shape_definition_for_tree(to_export)
        shape_tool.UpdateAssemblies()
        return doc

    shape_tool.AddShape(to_export.wrapped, is_assembly)

    for node in PreOrderIter(to_export):
        if not node.label and node.color is None:
            continue

        node_label = shape_tool.FindShape(node.wrapped, findInstance=False)
        sub_node_labels = []
        if node.color is not None and isinstance(node, Compound) and not node.children:
            sub_nodes = []
            if isinstance(node, Part):
                explorer = TopExp_Explorer(node.wrapped, ta.TopAbs_SOLID)
            elif isinstance(node, Sketch):
                explorer = TopExp_Explorer(node.wrapped, ta.TopAbs_FACE)
            elif isinstance(node, Curve):
                explorer = TopExp_Explorer(node.wrapped, ta.TopAbs_EDGE)
            else:
                # A bare Compound leaf (a boolean or chamfer chain that came
                # back as a plain Compound) still holds coloured geometry.
                # Colour whatever it contains, most solid content first.
                explorer = TopExp_Explorer(node.wrapped, ta.TopAbs_SOLID)
                if not explorer.More():
                    explorer = TopExp_Explorer(node.wrapped, ta.TopAbs_FACE)
                if not explorer.More():
                    explorer = TopExp_Explorer(node.wrapped, ta.TopAbs_EDGE)

            while explorer.More():
                sub_nodes.append(explorer.Current())
                explorer.Next()

            sub_node_labels = [
                shape_tool.FindShape(sub_node, findInstance=False)
                for sub_node in sub_nodes
            ]
        set_label_name(node_label, node.label)

        if node.color is not None:
            for label in [node_label] + sub_node_labels:
                set_label_color(label, node.color)

    shape_tool.UpdateAssemblies()
    return doc


def export_xcaf_doc_step_scene(
    doc: Any,
    output_path: Path,
    *,
    label: str | None = None,
    originating_system: str = "build123d",
) -> LoadedStepScene:
    from build123d.exporters3d import (
        APIHeaderSection_MakeHeader,
        IFSelect_ReturnStatus,
        IGESControl_Controller,
        Interface_Static,
        Message,
        Message_Gravity,
        PrecisionMode,
        STEPCAFControl_Controller,
        STEPCAFControl_Writer,
        STEPControl_Controller,
        STEPControl_StepModelType,
        TCollection_HAsciiString,
        XSControl_WorkSession,
    )

    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    messenger = Message.DefaultMessenger_s()
    for printer in messenger.Printers():
        printer.SetTraceLevel(Message_Gravity(Message_Gravity.Message_Fail))

    session = XSControl_WorkSession()
    writer = STEPCAFControl_Writer(session, False)
    writer.SetColorMode(True)
    writer.SetLayerMode(True)
    writer.SetNameMode(True)

    header = APIHeaderSection_MakeHeader(writer.Writer().Model())
    if label:
        header.SetName(TCollection_HAsciiString(label))
    header.SetOriginatingSystem(TCollection_HAsciiString(originating_system))

    STEPCAFControl_Controller.Init_s()
    STEPControl_Controller.Init_s()
    IGESControl_Controller.Init_s()
    Interface_Static.SetIVal_s("write.surfacecurve.mode", 1)
    Interface_Static.SetIVal_s("write.precision.mode", PrecisionMode.AVERAGE.value)
    writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)

    with replacing(output_path) as temp_path:
        if writer.Write(os.fspath(temp_path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
            raise RuntimeError(f"Failed to write STEP file: {output_path}")
        if not temp_path.exists() or temp_path.stat().st_size <= 0:
            raise RuntimeError(f"STEP export did not create {output_path}")
    return load_step_scene_from_xcaf_doc(
        output_path,
        doc,
        step_hash=step_file_hash(output_path),
    )


def export_build123d_step_scene(to_export: Any, output_path: Path) -> LoadedStepScene:
    doc = _create_bin_xcaf_doc(to_export)
    return export_xcaf_doc_step_scene(
        doc,
        output_path,
        label=getattr(to_export, "label", None),
    )
