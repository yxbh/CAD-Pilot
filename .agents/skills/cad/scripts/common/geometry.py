"""Small, exact geometry queries for Python checks.

Inputs are native build123d geometry in a common coordinate system. Lengths
use the input unit; areas, volumes and inertia use its corresponding powers.
No function selects assembly parts, assigns tolerances, repairs inputs or
decides whether a design passes. Kernel failures raise ``GeometryError``.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from build123d import Edge, Shape, Shell, Solid, Vector

__all__ = [
    "GeometryError", "GeometryIssue", "ClosestPoints", "MassProperties",
    "closest_points", "overlap_volume", "is_sound", "topology_errors",
    "boundary_edges", "self_intersections", "mass_properties",
]

Matrix3 = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]


class GeometryError(RuntimeError):
    """The kernel could not establish the requested geometric result."""


@dataclass(frozen=True)
class ClosestPoints:
    distance: float
    point_a: Vector
    point_b: Vector


@dataclass(frozen=True)
class GeometryIssue:
    code: str
    entities: tuple[Shape, ...]


@dataclass(frozen=True)
class MassProperties:
    volume: float
    mass: float
    center_of_mass: Vector
    inertia: Matrix3


def _wrapped(shape, expected=None):
    from build123d import Shape
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX

    if not isinstance(shape, expected or Shape):
        raise TypeError(f"expected {(expected or Shape).__name__}, got {type(shape).__name__}")
    try:
        wrapped = shape.wrapped
    except AssertionError as exc:  # build123d's empty wrappers have no TopoDS object
        raise ValueError("geometry must be nonempty") from exc
    if wrapped is None or wrapped.IsNull() or not any(
        TopExp_Explorer(wrapped, kind).More() for kind in (TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX)
    ):
        raise ValueError("geometry must be nonempty")
    return wrapped


def _copy(shape):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy

    copier = BRepBuilderAPI_Copy(shape, True, False)
    if not copier.IsDone() or copier.Shape().IsNull():
        raise GeometryError("could not copy geometry")
    return copier.Shape()


def _cast(shape):
    from build123d import Compound

    return Compound.cast(shape)


def _items(collection) -> list:
    """An OCCT list's elements, taking exactly ``Size()`` from its iterator.

    Exhausting the binding's iterator ends in a C++ exception that pybind
    turns into StopIteration; unwinding it costs ~2.4 ms on macOS arm64, which
    a check paid once per issue, per status list, per sub-shape.
    """
    iterator = iter(collection)
    return [next(iterator) for _ in range(collection.Size())]


def _properties(shape):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props, False, False, False)
    if not isfinite(props.Mass()):
        raise GeometryError("volume integration returned a nonfinite result")
    return props


def _distance_members(shape):
    """Unpack containers without turning solid interiors into boundaries."""
    from OCP.TopAbs import TopAbs_COMPOUND, TopAbs_COMPSOLID
    from OCP.TopoDS import TopoDS_Iterator

    members, pending = [], [shape]
    while pending:
        current = pending.pop()
        if current.ShapeType() in (TopAbs_COMPOUND, TopAbs_COMPSOLID):
            children = TopoDS_Iterator(current, True, True)
            while children.More():
                pending.append(children.Value())
                children.Next()
        else:
            members.append(current)
    return members


def closest_points(a: Shape, b: Shape) -> ClosestPoints:
    """Minimum set distance and one minimizing pair, in the input frame.

    Solid interiors count: contact, overlap and containment have distance
    zero. Witnesses need not be on both boundaries or unique. This is not
    penetration depth. Pass faces/shells to ask about their boundaries.
    """
    from build123d import Vector
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    def measure(left, right):
        query = BRepExtrema_DistShapeShape(left, right)
        if not query.IsDone() or query.NbSolution() < 1:
            raise GeometryError("closest point computation did not complete")
        distance = float(query.Value())
        pa, pb = Vector(query.PointOnShape1(1)), Vector(query.PointOnShape2(1))
        if not all(isfinite(v) for v in (distance, *pa, *pb)) or distance < 0:
            raise GeometryError("closest point computation returned an invalid result")
        return ClosestPoints(distance, pa, pb)

    left, right = _wrapped(a), _wrapped(b)
    try:
        # OCCT's interior check recognizes top-level solids, but not solids
        # nested in compounds. Query their union member by member, preserving
        # shells, wires and other loose geometry as well as solids. Iterator
        # locations/orientations include every containing assembly placement.
        left_members, right_members = _distance_members(left), _distance_members(right)
        if len(left_members) == len(right_members) == 1:
            return measure(left_members[0], right_members[0])

        from OCP.BRepBndLib import BRepBndLib
        from OCP.Bnd import Bnd_Box

        def bounds(shape):
            box = Bnd_Box()
            BRepBndLib.Add_s(shape, box, False)
            return box

        right_bounds = [bounds(member) for member in right_members]
        best = None
        for member in left_members:
            box = bounds(member)
            candidates = sorted((box.Distance(other), i) for i, other in enumerate(right_bounds))
            for lower_bound, i in candidates:
                if best is not None and lower_bound >= best.distance:
                    break
                result = measure(member, right_members[i])
                if best is None or result.distance < best.distance:
                    best = result
                    if best.distance == 0:
                        return best
        if best is None:
            raise GeometryError("closest point computation found no geometry members")
        return best
    except Exception as exc:
        raise GeometryError(f"closest point computation failed: {exc}") from exc


def overlap_volume(a: Solid, b: Solid) -> float:
    """Intersection volume of two finite, positively oriented solids.

    Contact has zero volume. Assembly pair selection, intentional overlaps
    and acceptance thresholds belong to the caller. Inputs are never fused
    or modified; a failed boolean is an error, never a zero-volume answer.
    """
    from build123d import Solid
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.Bnd import Bnd_Box

    left, right = _wrapped(a, Solid), _wrapped(b, Solid)
    try:
        if _properties(left).Mass() <= 0 or _properties(right).Mass() <= 0:
            raise ValueError("overlap_volume requires positively oriented solids with positive volume")
        boxes = (Bnd_Box(), Bnd_Box())
        for shape, bounds in zip((left, right), boxes):
            BRepBndLib.Add_s(shape, bounds, False)
        if boxes[0].IsOut(boxes[1]):
            return 0.0
        boolean = BRepAlgoAPI_Common(_copy(left), _copy(right))
        if not boolean.IsDone():
            raise GeometryError("intersection boolean did not complete")
        common = boolean.Shape()
        if common.IsNull() or not BRepCheck_Analyzer(common).IsValid():
            raise GeometryError("intersection boolean returned invalid geometry")
        volume = float(_properties(common).Mass())
        if volume < 0:
            raise GeometryError("intersection boolean returned negative volume")
        return volume
    except ValueError:
        raise
    except Exception as exc:
        raise GeometryError(f"intersection computation failed: {exc}") from exc


def _argument_check(shape, *, small_edges: bool):
    """A performed ``BRepAlgoAPI_Check``, run once on the kernel's worker threads.

    The constructor that takes a shape performs the check serially; setting
    the data on an empty checker instead lets it run in parallel, which is
    several times faster on parts with many faces.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Check

    checker = BRepAlgoAPI_Check()
    checker.SetData(shape, small_edges, True)
    checker.SetRunParallel(True)
    checker.Perform()
    return checker


def _verdict_input(shape):
    """The native shape a pass/fail verdict is about, or None for a null shape.

    Unlike the measurements, ``is_sound`` accepts null and empty geometry: a
    gate in a model body must not crash on an empty intermediate.
    """
    from build123d import Shape

    if not isinstance(shape, Shape):
        raise TypeError(f"expected Shape, got {type(shape).__name__}")
    wrapped = shape._wrapped
    return None if wrapped is None or wrapped.IsNull() else wrapped


def is_sound(shape: Shape) -> bool:
    """The boolean kernel's argument check (``BRepAlgoAPI_Check``) passes the
    shape: BRepCheck-valid, no self-intersections, no too-small edges, and an
    argument type a boolean accepts. This is what a fuse or cut demands of an
    operand, and it can be expensive. A null or empty shape is not sound: the
    kernel rejects it as an argument type (``BOPAlgo_BadType``), a verdict,
    not an error. A check the kernel could not complete raises
    ``GeometryError``. Closure, solid count and signed volume are separate
    questions; the faulty entities are ``self_intersections``'s.
    """
    wrapped = _verdict_input(shape)
    if wrapped is None:
        return False  # BRepAlgoAPI_Check on a null shape: BOPAlgo_BadType
    return not _argument_faults(wrapped)


def _argument_faults(wrapped) -> tuple[str, ...]:
    """``is_sound``'s check of a native shape, from one run of the kernel.

    Returns the status name of each fault the kernel reports, such as
    ``BOPAlgo_SelfIntersect`` once per crossing pair, ``BOPAlgo_TooSmallEdge``
    or ``BOPAlgo_NotValid``; empty when the shape is sound. It needs no
    build123d wrapper, so a worker process can check shapes read from a STEP
    file without importing build123d.
    """
    from OCP.BOPAlgo import BOPAlgo_CheckStatus

    inconclusive = (BOPAlgo_CheckStatus.BOPAlgo_CheckUnknown, BOPAlgo_CheckStatus.BOPAlgo_OperationAborted)
    try:
        # Self-intersections and small edges both on, the kernel's defaults.
        checker = _argument_check(wrapped, small_edges=True)
        if checker.HasErrors():
            raise GeometryError("boolean argument checker failed")
        statuses = [result.GetCheckStatus() for result in _items(checker.Result())]
        for status in statuses:
            if status in inconclusive:
                raise GeometryError(f"boolean argument check was inconclusive: {status.name}")
        if checker.IsValid():
            return ()
        return tuple(status.name for status in statuses) or ("invalid",)
    except GeometryError:
        raise
    except Exception as exc:
        raise GeometryError(f"soundness check failed: {exc}") from exc


def _shape_map(shape, kind=None):
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    shapes = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    if kind is None:
        TopExp.MapShapes_s(shape, shapes)
    else:
        TopExp.MapShapes_s(shape, kind, shapes)
    return shapes


def _keys(shapes) -> list:
    return [shapes.FindKey(i) for i in range(1, shapes.Extent() + 1)]


def _direct_statuses(entity, faces) -> list:
    """(status, context) pairs from the BRepCheck checks that return a status directly.

    OCP 8 cannot convert ``BRepCheck_Result.Status()`` (an
    ``NCollection_List<BRepCheck_Status>``) to Python, so the analyzer's own
    status lists are out of reach. The shell, face and wire checks below are
    the ones OCCT exposes one status at a time; a wire is checked in the
    context of every face that bounds with it.
    """
    from OCP.BRepCheck import BRepCheck_Face, BRepCheck_NoError, BRepCheck_Shell, BRepCheck_Wire
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID, TopAbs_WIRE
    from OCP.TopoDS import TopoDS, TopoDS_Edge

    found = []
    kind = entity.ShapeType()
    if kind in (TopAbs_SOLID, TopAbs_SHELL):
        shells = [entity] if kind == TopAbs_SHELL else _keys(_shape_map(entity, TopAbs_SHELL))
        for shell in shells:
            check = BRepCheck_Shell(TopoDS.Shell(shell))
            found += [(check.Closed(False), None), (check.Orientation(False), None)]
    elif kind == TopAbs_FACE:
        check = BRepCheck_Face(TopoDS.Face(entity))
        found += [(status, None) for status in (
            check.IntersectWires(False), check.ClassifyWires(False), check.OrientationOfWires(False),
        )]
    elif kind == TopAbs_WIRE:
        check = BRepCheck_Wire(TopoDS.Wire(entity))
        found.append((check.Closed(False), None))
        for face in faces:
            if not _shape_map(face, TopAbs_WIRE).Contains(entity):
                continue
            face = TopoDS.Face(face)
            found += [(status, face) for status in (
                check.Closed2d(face, False),
                check.Orientation(face, False),
                check.SelfIntersect(face, TopoDS_Edge(), TopoDS_Edge(), False),
            )]
    return [(status, context) for status, context in found if status != BRepCheck_NoError]


def topology_errors(shape: Shape) -> tuple[GeometryIssue, ...]:
    """BRepCheck topology/geometry faults, on the smallest entities they affect.

    An entity is reported when ``BRepCheck_Analyzer`` finds it invalid but
    finds every sub-shape valid. Codes are OCCT's ``BRepCheck_*`` status names
    from the shell, face and wire checks that return one directly, or
    ``invalid`` when OCP 8 cannot say which check failed (see
    ``_direct_statuses``). Open shells and reversed solids can have valid
    topology. Closure, signed volume and expensive boolean self-intersection
    testing are separate questions.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.TopAbs import TopAbs_FACE

    wrapped = _wrapped(shape)
    try:
        private = _copy(wrapped)
        analyzer = BRepCheck_Analyzer(private)
        if analyzer.IsValid():
            return ()
        faces = _keys(_shape_map(private, TopAbs_FACE))
        issues = []
        for entity in _keys(_shape_map(private)):
            if analyzer.IsValid(entity):
                continue
            if any(not sub.IsSame(entity) and not analyzer.IsValid(sub) for sub in _keys(_shape_map(entity))):
                continue
            found = _direct_statuses(entity, faces)
            if not found:
                issues.append(GeometryIssue("invalid", (_cast(entity),)))
            for status, context in found:
                affected = (entity,) if context is None else (entity, context)
                issues.append(GeometryIssue(status.name, tuple(_cast(s) for s in affected)))
        if not issues:
            raise GeometryError("topology is invalid but the kernel provided no diagnostic")
        return tuple(issues)
    except Exception as exc:
        raise GeometryError(f"topology check failed: {exc}") from exc


def boundary_edges(shell: Shell) -> tuple[Edge, ...]:
    """Free edges of a shell; seams are not boundaries.

    An empty result establishes no free edges, not full manifold validity.
    Geometry is neither sewn nor repaired.
    """
    from build123d import Shell
    from OCP.ShapeAnalysis import ShapeAnalysis_Shell
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    wrapped = _wrapped(shell, Shell)
    try:
        analyzer = ShapeAnalysis_Shell()
        private = _copy(wrapped)
        analyzer.LoadShells(private)
        analyzer.CheckOrientedShells(private, True)
        edges = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
        TopExp.MapShapes_s(analyzer.FreeEdges(), TopAbs_EDGE, edges)
        return tuple(_cast(edges.FindKey(i)) for i in range(1, edges.Extent() + 1))
    except Exception as exc:
        raise GeometryError(f"boundary edge check failed: {exc}") from exc


def self_intersections(shape: Shape) -> tuple[GeometryIssue, ...]:
    """Explicit boolean self-intersection check in the supplied placement.

    This can be expensive. Codes are OCCT's ``BOPAlgo_SelfIntersect``; affected
    entities are owned copies. Inconclusive/failed checks raise an exception.
    """
    from OCP.BOPAlgo import BOPAlgo_CheckStatus

    wrapped = _wrapped(shape)
    try:
        private = _copy(wrapped)
        checker = _argument_check(private, small_edges=False)
        if checker.HasErrors():
            raise GeometryError("self-intersection checker failed")
        issues = []
        for result in _items(checker.Result()):
            status = result.GetCheckStatus()
            if status != BOPAlgo_CheckStatus.BOPAlgo_SelfIntersect:
                raise GeometryError(f"self-intersection check was inconclusive: {status.name}")
            entities = _items(result.GetFaultyShapes1()) + _items(result.GetFaultyShapes2())
            issues.append(GeometryIssue(status.name, tuple(_cast(s) for s in entities or [private])))
        if not checker.IsValid() and not issues:
            raise GeometryError("self-intersection check failed without diagnostics")
        return tuple(issues)
    except Exception as exc:
        raise GeometryError(f"self-intersection check failed: {exc}") from exc


def mass_properties(bodies: Iterable[tuple[Solid, float]]) -> MassProperties:
    """Add uniform-density solids, including overlapping material as supplied.

    Density must be finite and positive, in mass/input-unit³. Inertia is
    about the combined center of mass, expressed in the input coordinate
    axes. For mm and kg/mm³ the outputs are mm³, kg, mm and kg·mm².
    """
    from build123d import Solid, Vector
    from OCP.GProp import GProp_GProps

    combined = GProp_GProps()
    volume, count = 0.0, 0
    for solid, density in bodies:
        wrapped = _wrapped(solid, Solid)
        if isinstance(density, bool) or not isfinite(density) or density <= 0:
            raise ValueError("density must be finite and positive")
        try:
            props = _properties(wrapped)
            if props.Mass() <= 0:
                raise ValueError("mass_properties requires positively oriented solids with positive volume")
            volume += float(props.Mass())
            combined.Add(props, float(density))
            count += 1
        except ValueError:
            raise
        except Exception as exc:
            raise GeometryError(f"mass integration failed: {exc}") from exc
    if not count:
        raise ValueError("mass_properties requires at least one body")
    tensor = combined.MatrixOfInertia()
    inertia = tuple(tuple(float(tensor.Value(i, j)) for j in range(1, 4)) for i in range(1, 4))
    center = Vector(combined.CentreOfMass())
    if not all(isfinite(v) for v in (volume, combined.Mass(), *center, *(v for row in inertia for v in row))):
        raise GeometryError("mass integration returned a nonfinite result")
    return MassProperties(volume, float(combined.Mass()), center, inertia)
