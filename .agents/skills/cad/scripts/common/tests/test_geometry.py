import unittest
from unittest import mock

from build123d import Compound, Pos, Rot, Shell, Solid, Vector, Vertex, Wire
from OCP.TopoDS import TopoDS

from common.geometry import (
    GeometryError,
    boundary_edges,
    closest_points,
    is_sound,
    mass_properties,
    overlap_volume,
    self_intersections,
    topology_errors,
)


def _open_solid():
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Solid
    wrapped, builder = TopoDS_Solid(), BRep_Builder()
    builder.MakeSolid(wrapped)
    builder.Add(wrapped, Shell(Solid.make_box(10, 10, 10).faces()[1:]).wrapped)
    return Solid(wrapped)


def _infinite_plane():
    # A nonempty face with no edges or vertices.
    from build123d import Face
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Pln

    return Face(BRepBuilderAPI_MakeFace(gp_Pln()).Face())


def _bow_tie_face():
    from build123d import Face
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace

    wire = Wire.make_polygon([(0, 0, 0), (10, 10, 0), (10, 0, 0), (0, 10, 0)], close=True)
    return Face(BRepBuilderAPI_MakeFace(wire.wrapped, True).Face())


def _overlapping_boxes():
    box = Solid.make_box(10, 10, 10)
    return Compound([box, Pos(5, 0, 0) * box])


class _Results(list):
    """An OCCT list stand-in: sized, iterable."""

    def Size(self):
        return len(self)

class ClosestPointsTests(unittest.TestCase):
    def test_vertices_and_separated_solids_have_witnesses_in_world_frame(self):
        a, b = Vertex(1, 2, 3), Vertex(4, 6, 3)
        result = closest_points(a, b)
        self.assertAlmostEqual(result.distance, 5)
        self.assertLess((result.point_a - Vector(1, 2, 3)).length, 1e-8)
        self.assertLess((result.point_b - Vector(4, 6, 3)).length, 1e-8)
        a = Solid.make_box(2, 3, 4)
        result = closest_points(a, Pos(10, 0, 0) * a)
        self.assertAlmostEqual(result.distance, 8)
        self.assertAlmostEqual((result.point_b - result.point_a).length, result.distance)

    def test_contact_overlap_and_containment_are_zero(self):
        a = Solid.make_box(10, 10, 10)
        for b in (Pos(10, 0, 0) * a, Pos(5, 0, 0) * a, Pos(2, 2, 2) * Solid.make_box(1, 1, 1)):
            self.assertAlmostEqual(closest_points(a, b).distance, 0)
        # Surface distance is a different query, even with nested solids.
        b = Pos(2, 2, 2) * Solid.make_box(1, 1, 1)
        self.assertAlmostEqual(closest_points(a.shell(), b.shell()).distance, 2)

    def test_nonempty_surface_without_vertices_is_measurable(self):
        self.assertAlmostEqual(closest_points(_infinite_plane(), Vertex(0, 0, 5)).distance, 5)

    def test_compound_containment_counts_solid_interiors_in_both_orders(self):
        outer = Solid.make_box(10, 10, 10)
        inner = Pos(2, 2, 2) * Solid.make_box(1, 1, 1)
        for a in (outer, Compound([outer]), Compound([Compound([outer]), Vertex(30, 0, 0)])):
            for b in (inner, Compound([inner])):
                for left, right in ((a, b), (b, a)):
                    with self.subTest(left=type(left).__name__, right=type(right).__name__):
                        result = closest_points(left, right)
                        self.assertEqual(result.distance, 0)
                        self.assertLess((result.point_a - result.point_b).length, 1e-8)
                        self.assertTrue(outer.is_inside(result.point_a))
                        self.assertTrue(inner.is_inside(result.point_b))

    def test_nested_compound_locations_and_disconnected_members(self):
        outer = Solid.make_box(10, 10, 10)
        frame = Pos(100, -50, 12) * Rot(0, 0, 30)
        a = frame * Compound([Compound([outer]), Pos(50, 0, 0) * outer])
        b = frame * Compound([Pos(2, 2, 2) * Solid.make_box(1, 1, 1)])
        self.assertEqual(closest_points(a, b).distance, 0)
        c = frame * Compound([Pos(70, 0, 0) * Solid.make_box(1, 1, 1)])
        result = closest_points(a, c)
        self.assertAlmostEqual(result.distance, 10)
        self.assertAlmostEqual((result.point_a - result.point_b).length, 10)

    def test_compounds_preserve_loose_geometry_and_shell_boundaries(self):
        from build123d import Edge

        far = Pos(100, 100, 100) * Solid.make_box(1, 1, 1)
        for loose in (Vertex(0, 0, 0), Edge.make_line((-2, 0, 0), (2, 0, 0)), _infinite_plane()):
            for a, b in ((Compound([far, loose]), Vertex(0, 0, 5)),
                         (Vertex(0, 0, 5), Compound([far, loose]))):
                self.assertAlmostEqual(closest_points(a, b).distance, 5)
        outer = Solid.make_box(10, 10, 10)
        inner = Pos(2, 2, 2) * Solid.make_box(1, 1, 1)
        self.assertAlmostEqual(closest_points(Compound([outer.shell()]), Compound([inner.shell()])).distance, 2)

    def test_a_solid_cavity_is_not_containment(self):
        outer = Solid.make_box(10, 10, 10)
        hollow = (outer - Pos(2, 2, 2) * Solid.make_box(6, 6, 6)).solids()[0]
        inner = Pos(4, 4, 4) * Solid.make_box(1, 1, 1)
        for a, b in ((Compound([hollow]), inner), (inner, Compound([hollow]))):
            self.assertAlmostEqual(closest_points(a, b).distance, 2)

    def test_empty_or_failed_queries_do_not_return_a_distance(self):
        with self.assertRaises(ValueError):
            closest_points(Compound(), Vertex(0, 0, 0))
        query = mock.Mock()
        query.IsDone.return_value = False
        with mock.patch("OCP.BRepExtrema.BRepExtrema_DistShapeShape", return_value=query):
            with self.assertRaises(GeometryError):
                closest_points(Vertex(0, 0, 0), Vertex(1, 1, 1))


class MassPropertiesTests(unittest.TestCase):
    def test_density_volume_and_centroidal_inertia(self):
        props = mass_properties([(Solid.make_box(2, 4, 6), 3)])
        self.assertAlmostEqual(props.volume, 48)
        self.assertAlmostEqual(props.mass, 144)
        self.assertLess((props.center_of_mass - Vector(1, 2, 3)).length, 1e-8)
        for i, expected in enumerate((624, 480, 240)):
            self.assertAlmostEqual(props.inertia[i][i], expected)
        self.assertAlmostEqual(props.inertia[0][1], 0)

    def test_rotation_changes_tensor_axes_but_translation_does_not(self):
        body = Solid.make_box(2, 4, 6)
        props = mass_properties([(Pos(100, 30, -8) * Rot(0, 0, 45) * body, 3)])
        self.assertAlmostEqual(props.inertia[0][0], 552)
        self.assertAlmostEqual(props.inertia[1][1], 552)
        self.assertAlmostEqual(props.inertia[0][1], 72)
        self.assertAlmostEqual(props.inertia[1][0], 72)
        self.assertAlmostEqual(props.inertia[2][2], 240)

    def test_parallel_axis_and_mixed_density(self):
        body = Solid.make_box(2, 2, 2)
        props = mass_properties([(body, 1), (Pos(6, 0, 0) * body, 2)])
        self.assertAlmostEqual(props.volume, 16)
        self.assertAlmostEqual(props.mass, 24)
        self.assertLess((props.center_of_mass - Vector(5, 1, 1)).length, 1e-8)
        self.assertAlmostEqual(props.inertia[0][0], 16)
        self.assertAlmostEqual(props.inertia[1][1], 208)
        self.assertAlmostEqual(props.inertia[2][2], 208)
        self.assertAlmostEqual(mass_properties([(body, 1), (body, 1)]).mass, 16)

    def test_invalid_inputs_are_not_laundered(self):
        body = Solid.make_box(1, 1, 1)
        for density in (0, -1, float("nan"), float("inf"), True):
            with self.subTest(density=density), self.assertRaises(ValueError):
                mass_properties([(body, density)])
        with self.assertRaises(ValueError):
            mass_properties([])
        with self.assertRaises(TypeError):
            mass_properties([(Compound([body]), 1)])


class OverlapVolumeTests(unittest.TestCase):
    def setUp(self):
        self.a = Solid.make_box(10, 10, 10)

    def test_disjoint_touching_partial_coincident_and_contained(self):
        for b, expected in [
            (Pos(20, 0, 0) * self.a, 0),
            (Pos(10, 0, 0) * self.a, 0),
            (Pos(5, 0, 0) * self.a, 500),
            (self.a, 1000),
            (Pos(1, 1, 1) * Solid.make_box(2, 2, 2), 8),
        ]:
            with self.subTest(expected=expected):
                self.assertAlmostEqual(overlap_volume(self.a, b), expected, places=6)

    def test_overlapping_bounding_boxes_do_not_imply_interference(self):
        self.assertEqual(overlap_volume(Solid.make_sphere(5), Pos(8, 8, 0) * Solid.make_sphere(5)), 0)

    def test_thin_overlap_has_no_design_threshold(self):
        self.assertAlmostEqual(overlap_volume(self.a, Pos(9.99999, 0, 0) * self.a), .001, places=6)

    def test_compounds_are_not_silently_treated_as_one_solid(self):
        with self.assertRaises(TypeError):
            overlap_volume(Compound([self.a]), self.a)

    def test_negative_orientation_is_not_reported_as_zero(self):
        from OCP.TopoDS import TopoDS
        reversed_solid = Solid(TopoDS.Solid(self.a.wrapped.Reversed()))
        with self.assertRaisesRegex(ValueError, "positively oriented"):
            overlap_volume(reversed_solid, self.a)

    def test_failed_boolean_is_not_reported_as_zero(self):
        boolean = mock.Mock()
        boolean.IsDone.return_value = False
        with mock.patch("OCP.BRepAlgoAPI.BRepAlgoAPI_Common", return_value=boolean):
            with self.assertRaisesRegex(GeometryError, "did not complete"):
                overlap_volume(self.a, self.a)

    def test_boolean_inputs_have_independent_native_topology(self):
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
        seen = []
        def common(left, right):
            seen.extend((left, right))
            return BRepAlgoAPI_Common(left, right)
        with mock.patch("OCP.BRepAlgoAPI.BRepAlgoAPI_Common", side_effect=common):
            overlap_volume(self.a, self.a)
        self.assertFalse(seen[0].IsPartner(self.a.wrapped))
        self.assertFalse(seen[1].IsPartner(self.a.wrapped))
        self.assertFalse(seen[0].IsPartner(seen[1]))
        self.assertAlmostEqual(self.a.volume, 1000)


class GeometryDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.box = Solid.make_box(10, 10, 10)

    def test_open_shell_and_reversed_solid_are_not_topology_errors(self):
        self.assertEqual(topology_errors(self.box), ())
        opened = Shell(self.box.faces()[1:])
        self.assertEqual(topology_errors(opened), ())
        reversed_solid = Solid(TopoDS.Solid(self.box.wrapped.Reversed()))
        self.assertEqual(topology_errors(reversed_solid), ())
        self.assertLess(reversed_solid.volume, 0)

    def test_open_solid_reports_native_fault_and_entities(self):
        issues = topology_errors(_open_solid())
        self.assertTrue(issues)
        self.assertTrue(all(issue.code.startswith("BRepCheck_") and issue.entities for issue in issues))
        self.assertTrue(any("NotClosed" in issue.code or "Unorientable" in issue.code for issue in issues))

    def test_a_fault_is_reported_on_the_smallest_entity_with_its_context(self):
        # OCP 8 cannot read BRepCheck's status lists; the wire check in its
        # face's context still names the fault.
        face = _bow_tie_face()
        issues = topology_errors(face)
        self.assertEqual(["BRepCheck_SelfIntersectingWire"], [issue.code for issue in issues])
        self.assertEqual(["Wire", "Face"], [type(entity).__name__ for entity in issues[0].entities])
        self.assertFalse(issues[0].entities[1].wrapped.IsPartner(face.wrapped))

    def test_an_open_solid_is_reported_on_the_solid_as_not_closed(self):
        issues = topology_errors(Compound([_open_solid(), Pos(20, 0, 0) * self.box]))
        self.assertEqual([("BRepCheck_NotClosed", "Solid")], [(i.code, type(i.entities[0]).__name__) for i in issues])

    def test_free_edges_exclude_closed_shell_seams(self):
        self.assertEqual(boundary_edges(self.box.shell()), ())
        self.assertEqual(boundary_edges(Solid.make_cylinder(5, 10).shell()), ())
        opened = Shell(self.box.faces()[1:])
        free = boundary_edges(opened)
        self.assertEqual(len(free), 4)
        self.assertAlmostEqual(sum(edge.length for edge in free), 40)
        self.assertFalse(free[0].wrapped.IsPartner(opened.edges()[0].wrapped))

    def test_boundary_check_requires_a_shell(self):
        with self.assertRaises(TypeError):
            boundary_edges(self.box)

    def test_self_intersections_return_localized_owned_entities(self):
        self.assertEqual(self_intersections(self.box), ())
        self.assertEqual(self_intersections(Compound([self.box, Pos(20, 0, 0) * self.box])), ())
        source = _overlapping_boxes()
        issues = self_intersections(source)
        self.assertTrue(issues)
        self.assertTrue(all(i.code == "BOPAlgo_SelfIntersect" and i.entities for i in issues))
        self.assertTrue(any(entity.shape_type != "Compound" for i in issues for entity in i.entities))
        # The entities are owned copies: none shares topology with the caller's shape.
        self.assertFalse(any(entity.wrapped.IsPartner(face.wrapped)
                             for i in issues for entity in i.entities for face in source.faces()))

    def test_checker_failure_and_inconclusive_result_raise(self):
        checker = mock.Mock()
        checker.HasErrors.return_value = True
        with mock.patch("OCP.BRepAlgoAPI.BRepAlgoAPI_Check", return_value=checker):
            with self.assertRaises(GeometryError):
                self_intersections(self.box)
        checker.HasErrors.return_value = False
        checker.IsValid.return_value = False
        from OCP.collections import List_BOPAlgo_CheckResult
        checker.Result.return_value = List_BOPAlgo_CheckResult()
        with mock.patch("OCP.BRepAlgoAPI.BRepAlgoAPI_Check", return_value=checker):
            with self.assertRaisesRegex(GeometryError, "without diagnostics"):
                self_intersections(self.box)

    def test_self_intersection_check_runs_the_kernel_once(self):
        # BRepAlgoAPI_Check(shape, bTestSE, bTestSI) performs the check in its
        # constructor; a further Perform() repeats the whole boolean analysis.
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Check as real_check
        performs = []

        class Counted:
            def __init__(self, *args):
                self._checker = real_check(*args)

            def Perform(self, *args):
                performs.append(args)
                return self._checker.Perform(*args)

            def __getattr__(self, name):
                return getattr(self._checker, name)

        with mock.patch("OCP.BRepAlgoAPI.BRepAlgoAPI_Check", Counted):
            issues = self_intersections(_overlapping_boxes())
        self.assertEqual(performs, [])
        self.assertTrue(issues)
        self.assertTrue(all(i.code == "BOPAlgo_SelfIntersect" and i.entities for i in issues))


class IsSoundTests(unittest.TestCase):
    """``is_sound``: the boolean kernel's argument check, a pass/fail verdict."""

    CHECKER = "OCP.BRepAlgoAPI.BRepAlgoAPI_Check"

    def test_verdicts_match_the_kernel(self):
        self.assertIs(is_sound(Solid.make_box(10, 10, 10)), True)
        self.assertIs(is_sound(_overlapping_boxes()), False)   # BRepCheck-valid, self-intersecting
        self.assertIs(is_sound(_open_solid()), False)          # BRepCheck-invalid

    def test_null_and_empty_shapes_are_not_sound(self):
        # A gate in a model body must not crash on an empty intermediate: the
        # boolean kernel rejects it as an argument (BOPAlgo_BadType), a verdict.
        from OCP.BRep import BRep_Builder
        from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid, TopoDS_Wire

        def empty(topods, make):
            make(topods)
            return topods

        builder = BRep_Builder()
        null = Solid()
        null.wrapped = TopoDS_Solid()  # a null native shape
        shapes = (Solid(), null, Compound([]), Solid(empty(TopoDS_Solid(), builder.MakeSolid)),
                  Shell(empty(TopoDS_Shell(), builder.MakeShell)), Wire(empty(TopoDS_Wire(), builder.MakeWire)))
        self.assertEqual([is_sound(shape) for shape in shapes], [False] * len(shapes))

    def test_failed_and_inconclusive_checks_raise(self):
        from OCP.BOPAlgo import BOPAlgo_CheckStatus
        box = Solid.make_box(10, 10, 10)
        checker = mock.Mock()
        checker.HasErrors.return_value = True
        with mock.patch(self.CHECKER, return_value=checker):
            with self.assertRaisesRegex(GeometryError, "checker failed"):
                is_sound(box)
        checker.HasErrors.return_value = False
        for status in (BOPAlgo_CheckStatus.BOPAlgo_CheckUnknown, BOPAlgo_CheckStatus.BOPAlgo_OperationAborted):
            result = mock.Mock()
            result.GetCheckStatus.return_value = status
            checker.Result.return_value = _Results([result])
            with self.subTest(status=status.name), mock.patch(self.CHECKER, return_value=checker):
                with self.assertRaisesRegex(GeometryError, "inconclusive"):
                    is_sound(box)


class OcctListIterationTests(unittest.TestCase):
    def test_items_never_exhausts_the_binding_iterator(self):
        # Exhausting a pybind iterator over an OCCT list unwinds a C++
        # exception (milliseconds each on macOS); _items takes Size() elements.
        from common.geometry import _items

        class Guarded:
            def __init__(self, values):
                self.values = values

            def Size(self):
                return len(self.values)

            def __iter__(self):
                yield from self.values
                raise AssertionError("iterated past Size()")

        self.assertEqual(_items(Guarded(["a", "b"])), ["a", "b"])
        self.assertEqual(_items(Guarded([])), [])

    def test_items_match_full_iteration_of_real_checker_lists(self):
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Check
        from common.geometry import _items
        checker = BRepAlgoAPI_Check(_overlapping_boxes().wrapped, False, True)
        results = list(checker.Result())
        self.assertTrue(results)
        self.assertEqual(len(_items(checker.Result())), len(results))
        for result in results:
            for faulty in (result.GetFaultyShapes1(), result.GetFaultyShapes2()):
                expected = list(faulty)
                got = _items(faulty)
                self.assertEqual(len(got), len(expected))
                self.assertTrue(all(a.IsEqual(b) for a, b in zip(got, expected)))


if __name__ == "__main__":
    unittest.main()
