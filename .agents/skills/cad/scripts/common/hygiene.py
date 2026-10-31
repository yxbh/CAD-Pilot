"""Geometry hygiene of one part: what a printed, handled object should not have.

Each check reports the faces and edges it is about by their ordinals in the
part's own face and edge maps, the order ``@cad`` selectors number them in,
so a finding becomes a ref. Positions are in the part's local frame; the
caller places them. A finding is a prompt to look, not a verdict: an
intentional sharp edge or a part made of several solids is the designer's
call. Self-intersection is ``scripts/step``'s check at generation and is not
repeated here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from common.geometry import _items

SMOOTH_ANGLE = 1.0  # degrees between face normals below which an edge is a tangent join
CREASE_ANGLE = 15.0  # degrees above which a convex join is a sharp edge, chamfer edges included
DEFAULT_SLIVER = 0.05  # mm: faces thinner and edges shorter than this


@dataclass(frozen=True)
class Finding:
    check: str
    message: str
    faces: tuple[int, ...] = ()
    edges: tuple[int, ...] = ()
    at: tuple[float, float, float] | None = None
    value: float | None = None


@dataclass
class PartHygiene:
    findings: list[Finding] = field(default_factory=list)
    solids: int = 0
    faces: int = 0
    edges: int = 0
    convex_edges: int = 0
    sharp_edges: int = 0
    rounds: int = 0
    smallest_round: float | None = None


def _ordinal_maps(shape):
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    faces = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    edges = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, TopAbs_FACE, faces)
    TopExp.MapShapes_s(shape, TopAbs_EDGE, edges)
    return faces, edges


def _point(p) -> tuple[float, float, float]:
    return (round(p.X(), 3), round(p.Y(), 3), round(p.Z(), 3))


def _face_normal(face, uv):
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.gp import gp_Pnt, gp_Vec

    point, normal = gp_Pnt(), gp_Vec()
    BRepGProp_Face(face).Normal(uv.X(), uv.Y(), point, normal)
    return normal.Normalized() if normal.Magnitude() > 1e-12 else None


@dataclass(frozen=True)
class _Join:
    ordinal: int
    angle: float  # degrees between the two faces' outward normals
    convex: bool
    faces: tuple[int, int]
    at: tuple[float, float, float]
    length: float


def _edge_joins(shape, faces_map, edges_map) -> tuple[list[_Join], list[tuple[int, int]]]:
    """How the two faces at each edge meet, and the edges with other than two faces."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Curve2d
    from OCP.GCPnts import GCPnts_AbscissaPoint
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher
    from OCP.gp import gp_Pnt, gp_Vec

    ancestors = IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, ancestors)
    joins: list[_Join] = []
    odd: list[tuple[int, int]] = []
    for ordinal in range(1, edges_map.Extent() + 1):
        edge = TopoDS.Edge(edges_map.FindKey(ordinal))
        if BRep_Tool.Degenerated_s(edge) or not ancestors.Contains(edge):
            continue
        faces: list = []
        for face in _items(ancestors.FindFromKey(edge)):
            if not any(face.IsSame(other) for other in faces):
                faces.append(face)
        if len(faces) == 1 and BRep_Tool.IsClosed_s(edge, TopoDS.Face(faces[0])):
            continue  # a seam: the face meets itself
        if len(faces) != 2:
            odd.append((ordinal, len(faces)))
            continue
        first, second = (TopoDS.Face(face) for face in faces)
        curve = BRepAdaptor_Curve(edge)
        middle = 0.5 * (curve.FirstParameter() + curve.LastParameter())
        point, tangent = gp_Pnt(), gp_Vec()
        curve.D1(middle, point, tangent)
        normals = [_face_normal(face, BRepAdaptor_Curve2d(edge, face).Value(middle)) for face in (first, second)]
        if tangent.Magnitude() < 1e-12 or None in normals:
            continue
        explorer = TopExp_Explorer(first, TopAbs_EDGE)
        while explorer.More() and not explorer.Current().IsSame(edge):
            explorer.Next()
        tangent.Normalize()
        if explorer.More() and explorer.Current().Orientation() == TopAbs_REVERSED:
            tangent.Reverse()
        # The first face lies to the left of its boundary seen from outside,
        # so normal x tangent points into it; the second face's normal
        # pointing back against that direction makes the join convex.
        into_first = normals[0].Crossed(tangent)
        joins.append(_Join(
            ordinal=ordinal,
            angle=math.degrees(normals[0].Angle(normals[1])),
            convex=normals[1].Dot(into_first) < 0,
            faces=(faces_map.FindIndex(first), faces_map.FindIndex(second)),
            at=_point(point),
            length=GCPnts_AbscissaPoint.Length_s(curve),
        ))
    return joins, odd


def _round_radius(face, edge) -> float | None:
    """How round a face is across the tangent edge it meets a neighbour at: the radius of a rounded edge.

    The curvature is taken in the direction that leaves the edge into the face,
    so a fillet strip, a corner blend or a spline fillet gives its rounding
    radius, while a pin's side between two rounded ends, straight in that
    direction, gives none. Only faces that bulge outward count.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Curve2d, BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.gp import gp_Dir, gp_Pnt, gp_Vec

    curve = BRepAdaptor_Curve(edge)
    middle = 0.5 * (curve.FirstParameter() + curve.LastParameter())
    point, tangent = gp_Pnt(), gp_Vec()
    curve.D1(middle, point, tangent)
    uv = BRepAdaptor_Curve2d(edge, face).Value(middle)
    props = BRepLProp_SLProps(BRepAdaptor_Surface(face), uv.X(), uv.Y(), 2, 1e-7)
    if tangent.Magnitude() < 1e-12 or not props.IsNormalDefined() or not props.IsCurvatureDefined():
        return None
    normal = gp_Vec(props.Normal())
    if face.Orientation() == TopAbs_REVERSED:
        normal.Reverse()
    across = normal.Crossed(tangent)
    if across.Magnitude() < 1e-12:
        return None
    if props.IsUmbilic():
        curvature = props.MaxCurvature()
    else:
        largest, smallest = gp_Dir(), gp_Dir()
        props.CurvatureDirections(largest, smallest)
        cos = across.Normalized().Dot(gp_Vec(largest))
        curvature = props.MaxCurvature() * cos * cos + props.MinCurvature() * (1 - cos * cos)
    # Curvature is signed against the surface's own normal; a reversed face turns it.
    if face.Orientation() == TopAbs_REVERSED:
        curvature = -curvature
    if curvature > -1e-9:
        return None  # flat across the edge, or hollow like a fillet in an inside corner
    return 1.0 / -curvature


def _split_faces(solid, faces_map) -> list[list[int]]:
    """Groups of faces that lie on one surface and could be one face."""
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    unify = ShapeUpgrade_UnifySameDomain(solid, False, True, False)
    unify.Build()
    history = unify.History()
    merged = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(unify.Shape(), TopAbs_FACE, merged)
    own = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(solid, TopAbs_FACE, own)
    groups: dict[int, list[int]] = {}
    for index in range(1, own.Extent() + 1):
        face = own.FindKey(index)
        results = _items(history.Modified(face)) or ([face] if merged.Contains(face) else [])
        for result in results:
            target = merged.FindIndex(result)
            if target:
                groups.setdefault(target, []).append(faces_map.FindIndex(face))
    return [sorted(set(group)) for group in groups.values() if len(set(group)) > 1]


def _face_width(face) -> tuple[float, float]:
    """Area and a width estimate, twice the area over the perimeter: a long strip's narrow side."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    area, perimeter = GProp_GProps(), GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, area)
    BRepGProp.LinearProperties_s(face, perimeter)
    return area.Mass(), (2 * area.Mass() / perimeter.Mass() if perimeter.Mass() > 0 else 0.0)


def check_part(shape, *, round_radius: float | None = None, sliver: float = DEFAULT_SLIVER, solids: int = 1) -> PartHygiene:
    """Hygiene findings for one part's native shape.

    ``round_radius`` is the project's comfort radius: convex edges should be
    rounded at least this much. Without it, sharp edges are counted, not
    reported. ``solids`` is how many separate solids the part should have.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    report = PartHygiene()
    faces_map, edges_map = _ordinal_maps(shape)
    report.faces, report.edges = faces_map.Extent(), edges_map.Extent()
    solid_map = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, TopAbs_SOLID, solid_map)
    report.solids = solid_map.Extent()
    found = report.findings

    if report.solids == 0:
        shells = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
        TopExp.MapShapes_s(shape, TopAbs_SHELL, shells)
        found.append(Finding("no-solid", "has no solid, only " + (f"{shells.Extent()} shell(s)" if shells.Extent() else "loose faces or edges")
                             + ": it encloses no volume and cannot be printed or measured as a body"))
    elif report.solids != solids:
        volumes = []
        for index in range(1, report.solids + 1):
            props = GProp_GProps()
            BRepGProp.VolumeProperties_s(solid_map.FindKey(index), props)
            volumes.append(props.Mass())
        listed = ", ".join(f"{volume:.4g}" for volume in volumes)
        found.append(Finding(
            "solids",
            f"is {report.solids} separate solids (volumes {listed} mm3), not {solids}: bodies that touch or overlap "
            "without being fused stay separate. Fuse them, or make each its own labelled part",
            value=float(report.solids),
        ))

    analyzer = BRepCheck_Analyzer(shape)
    if not analyzer.IsValid():
        bad_faces = tuple(i for i in range(1, report.faces + 1) if not analyzer.IsValid(faces_map.FindKey(i)))
        bad_edges = tuple(i for i in range(1, report.edges + 1) if not analyzer.IsValid(edges_map.FindKey(i)))
        found.append(Finding(
            "invalid",
            "fails the kernel's validity check" + (" on the listed faces and edges" if bad_faces or bad_edges else ""),
            faces=bad_faces,
            edges=bad_edges,
        ))

    joins, odd = _edge_joins(shape, faces_map, edges_map)
    for ordinal, count in odd:
        what = "an open edge on only one face: the surface has a hole" if count < 2 else f"a non-manifold edge shared by {count} faces"
        found.append(Finding("open-edge" if count < 2 else "non-manifold", f"has {what}", edges=(ordinal,)))

    for index in range(1, report.solids + 1):
        for group in _split_faces(solid_map.FindKey(index), faces_map):
            found.append(Finding(
                "split-face",
                f"has {len(group)} faces on one surface that should be one face: fuse the bodies they came from in one "
                "operation, or unify same-domain faces",
                faces=tuple(group),
            ))

    for ordinal in range(1, report.faces + 1):
        face = TopoDS.Face(faces_map.FindKey(ordinal))
        area, width = _face_width(face)
        if width < sliver:
            found.append(Finding("sliver-face", f"has a sliver face about {width:.3g} mm wide ({area:.3g} mm2)", faces=(ordinal,), value=width))
    for join in joins:
        if join.length < sliver:
            found.append(Finding("short-edge", f"has an edge only {join.length:.3g} mm long", edges=(join.ordinal,), at=join.at, value=join.length))

    smooth_by_face: dict[int, list[int]] = {}
    for join in joins:
        if join.angle < SMOOTH_ANGLE:
            for face in join.faces:
                smooth_by_face.setdefault(face, []).append(join.ordinal)
        elif join.convex:
            report.convex_edges += 1
            if join.angle >= CREASE_ANGLE:
                report.sharp_edges += 1
                if round_radius is not None:
                    found.append(Finding(
                        "sharp-edge",
                        f"has a sharp convex edge where faces meet at {join.angle:.0f} degrees, {join.length:.3g} mm long",
                        edges=(join.ordinal,),
                        faces=join.faces,
                        at=join.at,
                        value=round(join.angle, 1),
                    ))
    for ordinal, smooth in smooth_by_face.items():
        if len(smooth) < 2:
            continue  # a round meets its neighbours tangentially on two sides
        face = TopoDS.Face(faces_map.FindKey(ordinal))
        radii = [r for r in (_round_radius(face, TopoDS.Edge(edges_map.FindKey(edge))) for edge in smooth) if r is not None]
        if not radii:
            continue
        radius = min(radii)
        report.rounds += 1
        report.smallest_round = radius if report.smallest_round is None else min(report.smallest_round, radius)
        if round_radius is not None and radius < round_radius - 1e-6:
            found.append(Finding(
                "small-round",
                f"has an edge rounded to {radius:.3g} mm, less than the {round_radius:g} mm comfort radius",
                faces=(ordinal,),
                value=round(radius, 4),
            ))
    return report
