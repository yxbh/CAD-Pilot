# Positioning logic, joints, and mating

Read this file when geometry has mating interfaces, repeated features, assembly children, axes, datums, motion, or user-specified alignment. This is the authoritative reference for assembly positioning, build123d joints, explicit `Location` transforms, CLI `inspect mate`, and positioning report content.

## Core rule

Positioning is authored in source and validated after generation. Do not position parts by visually dragging or by editing exported STEP geometry. Use build123d parameters, local coordinate systems, `Location` transforms, `Plane`/`Axis` datums, source-level `Joint` objects when useful, and labeled assembly children.

## Terminology

Use these terms carefully:

- **build123d joints** are source-level objects such as `RigidJoint`, `RevoluteJoint`, `LinearJoint`, `CylindricalJoint`, and `BallJoint`. They are attached to `Solid` or `Compound` objects and can reposition parts with `connect_to()`.
- **CLI `inspect mate`** is a validation tool. It computes a read-only translation delta between selected `@cad[...]` references. It does not edit source code or patch exported STEP files.
- **Mating intent** is the design relationship: flush, centered, coaxial, offset, hinge-like, slider-like, or otherwise datum-driven.

There is no general instruction to ignore the CLI because build123d has joints. Use build123d joints to express and compute source assembly placement where appropriate, then use CLI inspection to validate the generated STEP.

## Assembly structure

Build assemblies from datums rather than arbitrary numbers:

```text
root component
→ part-local coordinate systems
→ named datums / joint locations
→ parameterized Locations or source-level build123d joints
→ labeled Compound assembly
→ refs/measure/frame/mate and Python checks on the saved STEP
```

A numeric `Location(...)` should correspond to a stated datum, offset, clearance, screw axis, face contact, or joint relationship.

## Part-local positioning

For each part, define a local coordinate convention before modeling:

```text
- Origin: center, base datum, mounting interface, or functional axis.
- XY plane: main sketch/base plane unless another datum is dominant.
- +Z: extrusion/up direction.
- Named dimensions: offsets, hole spacing, boss spacing, clearances.
- Datum features: mating faces, screw axes, centerlines, locating tabs, rails.
```

Good defaults:

- Symmetric standalone parts: origin at body center.
- Plates: origin at footprint center; thickness along Z.
- Enclosures: origin at footprint center; base/lid mating surfaces controlled by Z parameters.
- Shaft/knob/axisymmetric parts: origin on rotational axis.
- Mating adapter plates: origin on the primary mounting datum or center of the bolt pattern.

## Feature placement inside a part

Use named parameters and local coordinates:

```python
hole_offset_x = 30
hole_offset_y = 17.5
hole_positions = [
    (-hole_offset_x, -hole_offset_y),
    ( hole_offset_x, -hole_offset_y),
    (-hole_offset_x,  hole_offset_y),
    ( hole_offset_x,  hole_offset_y),
]

with Locations(*hole_positions):
    Hole(radius=hole_diameter / 2)
```

Avoid untraceable placement constants inside geometry calls. Put all meaningful offsets into parameters.

## Joints or explicit transforms

Choose whichever makes the intended relationship easiest to read and keep correct when a dimension changes. Neither is required by the size or complexity of the assembly.

- An explicit transform built from named parameters, such as `Pos(0, 0, base_height + gap) * lid`, is direct and easy to check. It suits static layouts, rows or patterns of repeated parts, and placements that follow from one or two datums.
- A build123d joint names a datum on each part and lets `connect_to()` solve the placement. It suits relationships between reusable mount points, components that already expose joints, and hinge, slider, screw-like or ball poses driven by an angle or position parameter.

Either way, compose placements with `.moved()` or `Location * shape`, not `.located()`, which replaces a rotation applied earlier; see the placement pitfalls in `build123d-modeling.md`.

## Mirrored parts

A mirrored part is new geometry, not another placement of the original. In build123d 0.13 the `part.mirror(plane)` method keeps the original's label and joint objects but does not mirror the joint locations; the `mirror()` function and the builder's `mirror()` return a part with no label and no joints. Either way, give the mirrored part its own label, define its datums or joints after mirroring, and check its features where they actually landed.

## build123d joint pattern

Use build123d joints inside the Python source when they clarify placement. The exact joint locations should be named or derived from parameters.

```python
from build123d import *

base_height = 30.0
lid_thickness = 3.0
gasket_gap = 0.5

# base and lid are generated Solid or Compound objects.
base = make_base()
lid = make_lid()
base.label = "base"
lid.label = "lid"

# Fixed datum on the base: lid seats on this plane.
RigidJoint(
    label="lid_seat",
    to_part=base,
    joint_location=Location((0, 0, base_height / 2 + gasket_gap)),
)

# Datum on the moving lid: underside of the lid.
RigidJoint(
    label="underside",
    to_part=lid,
    joint_location=Location((0, 0, -lid_thickness / 2)),
)

# Reposition lid so lid.underside matches base.lid_seat.
base.joints["lid_seat"].connect_to(lid.joints["underside"])

assembly = Compound(label="enclosure", children=[base, lid])
```

`connect_to()` is a source-generation operation. It repositions the moving part for the generated model; it is not a persistent external constraint in the exported STEP file.

## Joint type selection

Use the simplest joint that expresses the source-level relationship:

- `RigidJoint`: fixed placement, face-to-face seating, mounting datums, imported components with known interfaces.
- `RevoluteJoint`: hinge or rotational pose; drive with an angle parameter for a static STEP pose.
- `LinearJoint`: slider, latch, telescoping component; drive with a position parameter.
- `CylindricalJoint`: combined axial translation and rotation, such as screw-like or pin-in-slot relationships.
- `BallJoint`: gimbal or spherical orientation relationship.

When only final static placement matters and no meaningful joint datum exists, use explicit `Location` transforms and validate them.

## Assembly positioning workflow

1. Choose the fixed/root component.
2. Define part-local frames and datums before modeling child placement.
3. Identify functional datums such as mating faces, screw axes, hinge axes, sliding axes, locating tabs, gasket offsets, or contact planes.
4. Name source-level joints or mating datums on each child.
5. Use build123d joints where they improve source clarity, otherwise use parameterized `Location` transforms.
6. Build a labeled `Compound` assembly.
7. Generate the assembly through the Python source, not by re-importing the generated STEP:

```bash
python scripts/step path/to/assembly.py
python scripts/inspect refs path/to/assembly.step --facts --planes --positioning
```

Passing a generated assembly STEP directly treats it as imported native STEP and does not preserve source-level composition semantics.

## CLI mating validation

After generation, use CLI inspection to validate the STEP result:

```bash
python scripts/inspect refs path/to/assembly.step \
  --facts --planes --positioning
```

Then select moving and target references from the returned `@cad[...]` refs and compute read-only deltas:

```bash
python scripts/inspect mate \
  --moving '@cad[path/to/assembly.step#moving_selector]' \
  --target '@cad[path/to/assembly.step#target_selector]' \
  --mode flush \
  --axis z
```

Use `--mode flush` for coplanar face alignment. Use `--mode center` for centerline, plane-center, or symmetrical alignment where supported by the selected references. If the returned delta is outside tolerance, edit the build123d source placement or joint location, regenerate, and rerun inspection.

## What `mate` and `measure` show

`mate --mode flush` and `measure` reduce each selection to one coordinate along one axis: a plane's coordinate, or a point such as a circle centre or origin, falling back to the centre of the selection's bounding box. `mate --mode center` compares two such points. Read the results with these limits:

- **One axis is one axis.** A zero flush delta along Z shows the two faces lie in the same Z plane. It does not show that they overlap sideways, that the parts are centred in X and Y, or that the faces are parallel. Check each of those separately: another `mate` or `measure` per axis, or a Python check.
- **Check face direction.** Faces that seat against each other point in opposite directions. `mate` and `measure` report `vectorRelationship`; for contact it should be `opposed`. `parallel` means both faces point the same way, which usually means the wrong face was selected or a part is upside down; `mate` then also reports `rotationRequired: true`. Assert the relation you expect instead of accepting either.
- **A bounding box is an envelope.** Its size is not a hole diameter or a wall thickness, and its centre is not a datum. Measure a hole from its circle edge's or cylinder face's radius, which `refs --detail` reports under `params`, and a wall as the distance between its two faces.
- **Hole patterns use true centres.** Compare circle centres when checking spacing or symmetry, not the centres of faces or parts. `refs --detail` reports a circle edge's `params.center` (its detail-level `center` field is not the circle centre), and `measure` from a circle edge uses the true centre.
- **Clearance is a minimum distance.** The gap between two parts is the smallest distance between their surfaces, not the offset between two chosen faces along one axis. Measure it in Python on the saved STEP (see `inspection-and-validation.md`). A minimum distance of zero means touching or overlapping; overlap volume tells the two apart.
- **One pose proves one pose.** A hinge, slider or lid checked in one position is only checked there. Check each pose that matters, or say which were not checked.
- **Mirrored parts need their own checks.** Re-select references on a mirrored part rather than reusing the original's; see Mirrored parts above.

## Frame validation

Use `frame` to inspect an occurrence or selector's world frame:

```bash
python scripts/inspect frame '@cad[path/to/assembly.step#selector]'
```

Use this when:

- a child appears in the wrong orientation
- a mating face is offset in world coordinates
- an axis is expected to align with X/Y/Z
- repeated parts should share orientation
- a downstream task needs a stable coordinate frame

## Measurement validation

Use `measure` for scalar checks:

```bash
python scripts/inspect measure \
  --from '@cad[path/to/assembly.step#selector_a]' \
  --to '@cad[path/to/assembly.step#selector_b]' \
  --axis z
```

Examples:

- lid bottom face to base top face should be 0 mm along Z, with an `opposed` vector relationship, for flush contact
- two screw axes should have matching X and Y positions, measured on each axis from the circle centres
- bracket mounting face should sit a specified distance from a datum plane
- spacer height should equal requested offset

## Source-level positioning corrections

When a positioning check fails, fix one of these in source:

- child `Location` translation
- child `Location` rotation
- build123d joint location or axis
- part-local origin convention
- feature offset parameter
- sketch plane
- workplane selection
- assembly hierarchy
- symmetric placement signs

Then regenerate. Do not patch the exported STEP directly.

## Reporting positioning

In the final response, report only checks that were run, each with the geometry, value and threshold:

```text
Positioning/joints:
- source used RigidJoint lid_seat → underside
- base top / lid underside: Z delta 0.00 mm (limit 0.01 mm), faces opposed
- screw boss circle centres: X and Y offsets ≤ 0.01 mm on all four (limit 0.05 mm)
- lid lip to base inner walls: minimum clearance between those faces 0.48 mm (required ≥ 0.40 mm); no overlap between the bodies
- lid occurrence frame: +Z up, origin at assembly centerline
- hinge: checked closed only; open pose not checked
```

The numbers above are illustrative. Take each threshold from the user's requirement or a confirmed tolerance, and say when a threshold is your own provisional choice.

If no positioning-sensitive features exist, say:

```text
Positioning: not applicable beyond centered part-local origin.
```

If a mate or alignment was intended but not checked, say `not checked`; do not imply success.
