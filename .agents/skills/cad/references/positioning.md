# Positioning, joints and mating

Read this when geometry has mating interfaces, repeated features, assembly children, axes, datums, motion or user-specified alignment.

## Core rule

Positioning is authored in source and validated after generation. Never position parts by dragging in a viewer or by editing exported STEP. Use parameters, part-local coordinate systems, `Location` transforms, `Plane`/`Axis` datums, build123d joints where useful, and labelled assembly children. Every numeric placement corresponds to a stated datum, offset, clearance, screw axis, face contact or joint relationship.

- **build123d joints** (`RigidJoint`, `RevoluteJoint`, `LinearJoint`, `CylindricalJoint`, `BallJoint`) are source objects attached to a part; `connect_to()` repositions the moving part once, during generation. They are not constraints in the exported STEP.
- **`inspect mate`** is read-only validation of the exported STEP: a translation delta between `@cad[...]` selections. It edits nothing and is not `Joint.connect_to()`.

## Assembly structure

1. Choose the fixed root part.
2. Define each part's local frame before placing children: origin at the body centre for symmetric parts and plates, on the rotation axis for shafts and knobs, on the primary mounting datum or bolt-pattern centre for adapters; +Z for extrusion.
3. Name the functional datums: mating faces, screw, hinge and sliding axes, locating tabs, gasket offsets, contact planes.
4. Place children from those datums with named parameters, using an explicit transform or a joint, whichever states the relationship more clearly.
5. Build a labelled `Compound`, generate it from the Python source, and validate it with `refs --positioning`, `frame`, `measure`, `mate`, `clearance` and Python checks on the saved STEP.

Put every meaningful offset in a parameter, including feature placement inside a part:

```python
hole_offset_x, hole_offset_y = 30, 17.5
with Locations(*[(sx * hole_offset_x, sy * hole_offset_y) for sx in (-1, 1) for sy in (-1, 1)]):
    Hole(radius=hole_diameter / 2)
```

## Joints or explicit transforms

Choose whichever makes the intended relationship easiest to read and keep correct when a dimension changes. Neither is required by the size or complexity of the assembly.

- An explicit transform built from named parameters, such as `Pos(0, 0, base_height + gap) * lid`, is direct and easy to check. It suits static layouts, rows or patterns of repeated parts, and placements that follow from one or two datums.
- A build123d joint names a datum on each part and lets `connect_to()` solve the placement. It suits relationships between reusable mount points, components that already expose joints, and hinge, slider, screw-like or ball poses driven by an angle or position parameter.

Either way, compose placements with `.moved()` or `Location * shape`, not `.located()`; see the placement pitfalls in `build123d-modeling.md`, which also covers mirrored parts.

```python
base, lid = make_base(), make_lid()
base.label, lid.label = "base", "lid"
RigidJoint(label="lid_seat", to_part=base, joint_location=Location((0, 0, base_height / 2 + gasket_gap)))
RigidJoint(label="underside", to_part=lid, joint_location=Location((0, 0, -lid_thickness / 2)))
base.joints["lid_seat"].connect_to(lid.joints["underside"])  # moves the lid; the base stays fixed
assembly = Compound(label="enclosure", children=[base, lid])
```

Use the simplest joint for the relationship: `RigidJoint` for fixed seating and mounting datums, `RevoluteJoint` for a hinge pose driven by an angle, `LinearJoint` for a slider or latch driven by a position, `CylindricalJoint` for screw-like or pin-in-slot motion, `BallJoint` for spherical orientation.

## What `mate` and `measure` show

`mate --mode flush` and `measure` reduce each selection to one coordinate along one axis: a plane's coordinate, or a point such as a circle centre or origin, falling back to the centre of the selection's bounding box. `mate --mode center` compares two such points.

- **One axis is one axis.** A zero flush delta along Z shows the two faces lie in the same Z plane, not that they overlap sideways, that the parts are centred in X and Y, or that the faces are parallel. Check each separately.
- **Check face direction.** Faces that seat against each other point in opposite directions. `mate` and `measure` report `vectorRelationship`, which should be `opposed` for contact; `parallel` usually means the wrong face was selected or a part is upside down, and `mate` then also reports `rotationRequired: true`. Assert the relation you expect.
- **A bounding box is an envelope.** Its size is not a hole diameter or wall thickness, and its centre is not a datum.
- **Hole patterns use true centres.** `refs --detail` reports a circle edge's `params.center` (its detail-level `center` field is not the circle centre), and `measure` from a circle edge uses the true centre.
- **Clearance is a minimum distance** between surfaces, not an offset between two chosen faces along one axis; use `inspect clearance`.

If a delta is out of tolerance, fix the smallest responsible source item: a child `Location` translation or rotation, a joint location or axis, a part-local origin, a feature offset, a sketch plane, the hierarchy or a symmetric sign. Then regenerate and take fresh selectors.

## Reporting positioning

```text
Positioning/joints:
- source used RigidJoint lid_seat → underside
- base top / lid underside: Z delta 0.00 mm (limit 0.01 mm), faces opposed
- screw boss circle centres: X and Y offsets ≤ 0.01 mm on all four (limit 0.05 mm)
- lid occurrence frame: +Z up, origin at assembly centerline
- hinge: checked closed only; open pose not checked
```

The numbers are illustrative; take each threshold from the user's requirement or a confirmed tolerance. With no positioning-sensitive features, say `Positioning: not applicable beyond centred part-local origin.` An intended mate nobody checked is `not checked`.
