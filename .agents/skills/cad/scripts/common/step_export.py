from __future__ import annotations

import itertools
import os
import re
from pathlib import Path
from typing import Any

from common.atomic_replace import replacing
from common.part_names import tree_names
from common.step_scene import LoadedStepScene, load_step_scene_from_xcaf_doc, step_file_hash


# OCCT writes a name's non-ASCII characters as its UTF-8 bytes read as Latin-1
# ("Bügel" comes back as "BÃ¼gel"), and its reader misreads an escaped quote
# ('') followed by "," or ")" or a double quote: the part goes missing, or the
# file does not parse. So a non-ASCII name reaches OCCT in ASCII, every
# non-ASCII run as a Part 21 \X2\ or \X4\ directive, and after writing, the
# product and occurrence records get those directives' backslashes back (OCCT
# doubles them) and every quote spelled \X\27. Every reader decodes both.
_NON_ASCII_RUN = re.compile(r"([^\x00-\x7f]+)")
# A directive as OCCT writes it in a literal: every backslash doubled.
_DOUBLED_DIRECTIVE = re.compile(rb"\\\\X([24])\\\\([0-9A-F]+)\\\\X0\\\\")
# The records that carry the names this writer sets: products and their occurrences.
_NAMED_RECORDS = (b" = PRODUCT(", b" = NEXT_ASSEMBLY_USAGE_OCCURRENCE(")


def unicode_directives(text: str) -> str:
    """Non-ASCII ``text`` as Part 21 directives: each run in the basic plane as one
    \\X2\\ directive of UTF-16 code units, each run beyond it as one \\X4\\
    directive of code points, upper-case hex."""
    out = []
    for wide, run in itertools.groupby(text, key=lambda char: ord(char) > 0xFFFF):
        chars = "".join(run)
        if wide:
            out.append("\\X4\\" + chars.encode("utf-32-be").hex().upper() + "\\X0\\")
        else:
            out.append("\\X2\\" + chars.encode("utf-16-be").hex().upper() + "\\X0\\")
    return "".join(out)


def ascii_name(name: str) -> str:
    """``name`` as it is handed to OCCT: every run of non-ASCII characters as
    :func:`unicode_directives`. An ASCII name is itself."""
    if name.isascii():
        return name
    pieces = _NON_ASCII_RUN.split(name)
    return "".join(piece if index % 2 == 0 else unicode_directives(piece) for index, piece in enumerate(pieces))


def _has_respelled_name(model: Any) -> bool:
    """Whether any product or occurrence name holds a directive or a quote, so the
    written file needs :func:`_respell_names_in_file`."""
    from OCP.StepBasic import StepBasic_Product
    from OCP.StepRepr import StepRepr_NextAssemblyUsageOccurrence

    for kind in (StepBasic_Product, StepRepr_NextAssemblyUsageOccurrence):
        iterator = model.Entities()
        iterator.SelectType(kind.get_type_descriptor_s(), True)
        iterator.Start()
        while iterator.More():
            name = iterator.Value().Name()
            if name is not None:
                text = name.ToCString()
                if "\\X" in text or "'" in text:
                    return True
            iterator.Next()
    return False


def _respell_literals(record: bytes) -> bytes:
    """``record`` with each string literal's directives given back the single backslashes
    OCCT doubled, and each quote written \\X\\27; any other literal as OCCT wrote it.
    OCCT wraps a long literal at a space, and a reader drops those line breaks, so they
    are dropped here too before the literal is judged."""
    parts, cursor, position = [], 0, record.find(b"'")
    while position >= 0:
        end = position + 1
        while True:
            end = record.index(b"'", end)
            if record[end + 1:end + 2] != b"'":
                break
            end += 2
        body = record[position + 1:end].replace(b"\r", b"").replace(b"\n", b"")
        respelled = _DOUBLED_DIRECTIVE.sub(rb"\\X\1\\\2\\X0\\", body).replace(b"''", b"\\X\\27")
        if respelled != body:
            parts += [record[cursor:position], b"'" + respelled + b"'"]
            cursor = end + 1
        position = record.find(b"'", end + 1)
    parts.append(record[cursor:])
    return b"".join(parts)


def _record_end(data: bytes, start: int) -> int:
    """The offset just past the ';' that ends the record running from ``start``."""
    quoted = False
    for offset in range(start, len(data)):
        byte = data[offset]
        if byte == 0x27:
            quoted = not quoted
        elif byte == 0x3B and not quoted:
            return offset + 1
    raise ValueError("a record does not end")


def _respell_names_in_file(path: Path) -> None:
    """Rewrite the header's FILE_NAME and every product and occurrence record with
    :func:`_respell_literals`."""
    data = path.read_bytes()
    starts = [data.find(b"FILE_NAME(", 0, data.find(b"\nDATA;"))]
    for keyword in _NAMED_RECORDS:
        found = data.find(keyword)
        while found >= 0:
            line = data.rfind(b"\n", 0, found) + 1
            if data[line:line + 1] == b"#" and data[line + 1:found].isdigit():
                starts.append(line)
            found = data.find(keyword, found + len(keyword))
    parts, cursor = [], 0
    for start in sorted(starts):
        # A header-like line inside an earlier record's literal is not a record.
        if start < cursor:
            continue
        end = _record_end(data, start)
        parts += [data[cursor:start], _respell_literals(data[start:end])]
        cursor = end
    parts.append(data[cursor:])
    path.write_bytes(b"".join(parts))


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


def _create_bin_xcaf_doc(to_export: Any, names: dict[int, str]) -> Any:
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
    # definition's colour and name: differently coloured or named occurrences
    # then all receive the last one. Keep one topology representative per
    # colour and label. Copying with copyGeom=False detaches only the
    # topological identity.
    leaf_variants: dict[int, list[tuple[object, dict[object, object]]]] = {}

    def set_label_name(label: object, name: str | None) -> None:
        if name and not label.IsNull():
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(ascii_name(str(name))))

    def set_label_color(label: object, color: object | None) -> None:
        if color is None or label.IsNull():
            return
        color_tool.SetColor(label, color.wrapped, XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    def color_signature(color: object | None) -> tuple[float, float, float, float] | None:
        if color is None:
            return None
        rgb = color.wrapped.GetRGB()
        return (float(rgb.Red()), float(rgb.Green()), float(rgb.Blue()), float(color.wrapped.Alpha()))

    def leaf_shape_for_definition(unlocated: object, shape: object) -> object:
        signature = (color_signature(getattr(shape, "color", None)), names.get(id(shape)))
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
            # Colours go on leaves only. build123d already passes a group's
            # colour down to its children, and STEPCAF writes a coloured
            # sub-assembly occurrence as a presentation with no items, which
            # readers report as a parse error.
            set_label_name(definition_label, names.get(id(shape)))
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
                set_label_name(child_component, names.get(id(child)))
                if not getattr(child, "children", None):
                    set_label_color(child_component, getattr(child, "color", None))
            return definition_label

        unlocated = leaf_shape_for_definition(shape_without_location(shape), shape)
        definition_label = shape_tool.AddShape(unlocated, False)
        shape_definitions[key] = definition_label
        set_label_name(definition_label, names.get(id(shape)))
        set_label_color(definition_label, getattr(shape, "color", None))
        return definition_label

    if is_assembly:
        shape_definition_for_tree(to_export)
        shape_tool.UpdateAssemblies()
        return doc

    set_label_name(shape_tool.AddShape(to_export.wrapped, is_assembly), names.get(id(to_export)))

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
        header.SetName(TCollection_HAsciiString(ascii_name(label)))
    header.SetOriginatingSystem(TCollection_HAsciiString(originating_system))

    STEPCAFControl_Controller.Init_s()
    STEPControl_Controller.Init_s()
    IGESControl_Controller.Init_s()
    Interface_Static.SetIVal_s("write.surfacecurve.mode", 1)
    Interface_Static.SetIVal_s("write.precision.mode", PrecisionMode.AVERAGE.value)
    writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)
    respell_names = _has_respelled_name(writer.Writer().Model())

    with replacing(output_path) as temp_path:
        if writer.Write(os.fspath(temp_path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
            raise RuntimeError(f"Failed to write STEP file: {output_path}")
        if not temp_path.exists() or temp_path.stat().st_size <= 0:
            raise RuntimeError(f"STEP export did not create {output_path}")
        if respell_names:
            _respell_names_in_file(temp_path)
    return load_step_scene_from_xcaf_doc(
        output_path,
        doc,
        step_hash=step_file_hash(output_path),
    )


def export_build123d_step_scene(to_export: Any, output_path: Path) -> LoadedStepScene:
    """Write a build123d shape or labelled assembly tree; unlabelled parts get fallback names.

    The scene's ``unlabelled_parts`` lists the names given to parts that had
    no label, so the caller can say which ones need one.
    """
    names, unlabelled = tree_names(
        to_export,
        root_name=Path(output_path).stem,
        children=lambda node: list(getattr(node, "children", None) or ()),
        label=lambda node: getattr(node, "label", None),
    )
    doc = _create_bin_xcaf_doc(to_export, names)
    scene = export_xcaf_doc_step_scene(doc, output_path, label=names[id(to_export)])
    scene.unlabelled_parts = tuple(unlabelled)
    return scene
