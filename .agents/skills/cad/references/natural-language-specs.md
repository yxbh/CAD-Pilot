# Natural-language CAD specs

Read this file when turning a user's prose, reference photo or technical drawing into a CAD brief. Do not require the user to provide JSON or fill in a template. If the user supplied JSON voluntarily, extract the same information but continue the workflow in prose notes and build123d source. Direct inspection or export requests need no modeling brief.

## Goal

Record what is needed to build and check the requested geometry before writing source or running tools. A simple part may need one sentence; a complex assembly may need a checklist of dimensions and interfaces.

The brief should answer:

- What is being modeled, and what is it for?
- Is it a part, assembly, modification, inspection task, or secondary output request?
- Which dimensions and units were given, and where did each come from (prose, photo, drawing, measurement)?
- Which values are missing, and does each one materially affect the result?
- Which features are required?
- Which faces, axes, origins, joints, or interfaces control positioning?
- What output files are requested?
- What must be checked before success is reported?

## Brief format

Use concise Markdown notes, not a user-facing structured schema. Include only the lines that matter for the task.

```text
CAD brief:
- Model: <part or assembly name, and what it is for>
- Output: STEP primary; secondary outputs if requested
- Units: <explicit or assumed>
- Coordinate convention: <origin, base plane, up axis>
- Given dimensions: <values and their source>
- Functional features: <holes, slots, ribs, bosses, pockets, shells, text, etc.>
- Positioning/mating: <interfaces, datums, child placements, transform or joint choice, alignment rules>
- Provisional assumptions: <inferred values, each in a named parameter, for the user to confirm>
- Open questions: <missing or conflicting values that materially affect the result>
- Checks: <bbox, solid count, labels, measurements, clearances, refs>
```

## Clarification policy

Critical dimensions, fit, clearances, wall thickness, material, printer and nozzle are unknown until the user confirms them. Ask when a missing or conflicting value materially affects the result. Ask one focused question at a time, in plain words. When the user may not know the answer, offer two or three rough alternatives, or a quick first pass to react to.

Usually ask when:

- A physical object has no overall size, or its only size source is an unscaled image.
- A part must fit, mate with or hold something whose dimensions are not given.
- A fit or clearance matters and the process, material or printer is unknown.
- Dimensioned sources disagree.
- The part is safety-critical, load-bearing, pressure-bearing, food-contact, medical, or compliance-bound.
- The requested output depends on an absent source file or missing imported geometry.

Usually proceed with a provisional assumption when:

- Origin, orientation or sketch plane can be chosen and reported.
- A cosmetic detail does not affect fit or function, such as how rounded a non-mating outside edge is. Put it in a named parameter and list it so the user can change it.
- The user wants a conceptual first pass, where rough alternatives help them decide.

A published standard value, such as a clearance-hole table or a material's typical shrinkage, is a starting proposal for the user's process, not a confirmed requirement or measured calibration. Label it as provisional. For printed fits, use the fdm-design skill.

## Reference images

- Establish whether the user wants to reproduce the object in the image or use it as inspiration. Ask when the wording does not make it clear. A reproduction is compared against the image; an inspired design only needs to keep what the user likes about it.
- An image without a known dimension or scale reference gives proportions, not sizes. Do not take fit dimensions from it. Get the overall size from the user, a known object in the picture, or a measurement, and scale the proportions from that.
- Record each dimension estimated from an image as a provisional assumption, and say how it was estimated.
- Camera angle, perspective and lens distortion change apparent proportions. A straight-on view gives the most reliable profile; treat a three-quarter view as approximate.
- For a reproduction, capture the model from a viewpoint close to the image's and compare the two (see `rendering-and-explorer.md`).

## Technical drawings

- Read the units, projection convention (first or third angle), scale, revision and notes first. Identify each view and section, then map its dimensions to model axes.
- Use stated dimensions over proportions measured from the drawing image. A dimension scaled off the image is an estimate, not a verified callout; record it as provisional.
- Keep every callout's full meaning: multiplicity such as `4X`, `TYP.` (applies to every similar feature), thread designations, counterbores, countersinks, and depths shown only in a section view. Track each one as a requirement to check later.
- When dimensioned sources disagree (two views, a note and a view, or the drawing and the user's prose), do not silently pick one. Resolve the conflict from other constraints when one reading is clearly wrong; otherwise ask. Record the decision.
- Derive unspecified geometry from the stated constraints where possible.
- After generation, check the specified dimensions against the saved STEP, and report any that were not verified.

## Example: simple part

User says:

```text
Make a 100 mm by 60 mm by 6 mm mounting plate with rounded corners, four M4 clearance holes 10 mm in from the corners, and a 20 by 12 mm rectangular cutout in the center.
```

Agent brief:

```text
CAD brief:
- Model: mounting_plate, single STEP part.
- Units: millimeters.
- Origin: center of plate; base plane XY; +Z is thickness direction.
- Body: rounded rectangular plate, 100 × 60 × 6 mm (given).
- Holes: four M4 clearance through-holes; centres read as 10 mm from both adjacent edges (given wording "10 mm in from the corners").
- Cutout: centered rectangular through-cut, 20 × 12 mm (given).
- Provisional: hole diameter 4.5 mm from the ISO 273 medium series, to confirm or adjust for the printer's hole fit; corner radius not given and cosmetic, so a named parameter listed for the user to confirm.
- Checks: one positive-volume solid, bbox 100 × 60 × 6 mm, four hole circles at the stated centres with the chosen radius, one center cutout, label mounting_plate.
```

## Example: assembly

User says:

```text
Design a two-piece enclosure, 120 by 80 by 35 mm, with a lid that sits on top and four screw bosses aligned between base and lid.
```

Agent brief:

```text
CAD brief:
- Model: enclosure assembly with base and lid.
- Units: millimeters.
- Assembly origin: center of enclosure footprint; +Z upward.
- Base: hollow lower shell, exterior 120 × 80 mm footprint (given); height is the 35 mm total (given) minus the lid thickness.
- Lid: separate plate seated on the base.
- Bosses: four screw bosses aligned between base and lid.
- Open questions: what goes inside; wall and lid thickness; screw size and how the screws hold (thread-forming, heat-set insert or nut). These set fit and printability, so ask before detailing. A rough first pass can use clearly labelled placeholder parameters.
- Positioning: base top face and lid underside are mating datums; screw axes must align. Use an explicit transform or a build123d joint, whichever states the relationship more clearly.
- Checks: labeled base and lid; overall bbox 120 × 80 × 35 mm; lid underside on the base top with opposed normals and zero gap; screw-axis circle centres matching in XY; minimum clearance wherever parts must not touch.
```

## Example: shape from a photo

User says:

```text
Here's a photo of a vase I like. Can you make a slip-casting mold for something like it?
```

Agent brief:

```text
CAD brief:
- Model: revolved vase body and a mold around it; inspired by the photo, not a reproduction.
- Units: millimeters.
- Origin: on the rotation axis at the vase's foot; +Z up.
- From the photo: profile proportions only (height-to-width ratio, shoulder and neck position, foot). The photo has no scale reference.
- Open questions: finished height or width; the clay body's total shrinkage, which sets how much larger the mold cavity must be; how many mold pieces and where they split. Ask for the finished size first, and offer two profile variants if the user is unsure about the shape.
- Provisional: profile points traced from the photo and scaled to the confirmed size, in named parameters.
- Checks: closed positive-volume solids; cavity height and maximum diameter equal the confirmed finished size scaled for the confirmed shrinkage; each mold piece labelled.
```

## Success criteria

A brief is ready for modeling when it contains enough information to define:

- source file path
- STEP target path
- units
- local coordinate system
- named parameters, with provisional values marked
- feature plan
- labels
- expected bounding box or key measurements
- open questions that block detailing, if any
- STEP to show in Explorer
