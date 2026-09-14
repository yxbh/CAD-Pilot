---
name: fdm-design
description: 'Design and review parts for FDM/FFF 3D printing. Use before modeling or revising printable parts, selecting orientation or filament, assessing walls, bridges and overhangs, planning fit clearances, heat-set inserts or snap-fits, reviewing slicer results, or recording printer calibration. Complements the CAD and visual-review skills; it does not certify printability or control a printer.'
---

# FDM Design and Review

## Scope

Use this skill alongside the chosen CAD engine and visual-review workflow, not as a replacement for them. It supplies design-for-additive-manufacturing reasoning, not an automatic printability validator. Respect existing project layouts and instructions; there is no required printer-profile filename or folder. Do not modify imported CAD guidance to apply these rules.

## Workflow

1. Understand the job in plain language: what it holds or mates to, where force acts, assembly/removal access, expected cycles, heat, sunlight, moisture, and the consequences of failure. Use a marked view or a simple question when the load path or feature is unclear.
2. Read the project's confirmed printer, nozzle, filament, slicer preset, and calibration records. Missing values are unknown. A profile for another printer, spool, nozzle, orientation, or slicer setup is not evidence for this one. Do not infer the user's hardware from pasted research.
3. Ask for facts that materially affect fit, function, or safe use. For a rough visual concept, proceed with explicitly labeled assumptions; do not block all co-design on a long questionnaire. Do not call that concept print-ready.
4. Choose a provisional print orientation and material before committing to details. Compare strength, bed contact, surface finish, support removal, and critical interfaces. Keep the functional model frame separate from the print-placement transform.
5. Apply the design checklist below to relevant features. Record numerical values with units, their source, applicability, and evidence status. Upstream defaults are proposals, not calibration or universal limits.
6. Generate and inspect actual geometry with the CAD tools. Check the selected features after booleans, fillets, and export; a constant named wall_thickness does not establish the thinnest wall in the final part. Use section views for hidden features and share the affected area for ambiguous changes.
7. Review the sliced result with the actual printer/material/process preset when available. Until slicing is performed, label slicer checks not checked. Do not invent a slicer command, estimate runtime as measured, or claim the current workbench build runs slicing.
8. Propose the smallest physical test needed: a fit coupon, insert boss, snap tab, bridge sample, or load-representative feature. Record the result and configuration before promoting a provisional allowance to measured calibration. Report evidence and remaining uncertainty separately.

## Design Checklist

### Orientation and Strength

- Identify tension, bending, impact, torsion, and sustained loads. FDM strength depends on layer bonding, toolpaths, material, and process; avoid critical tensile loads pulling layers apart where possible. A diagonal print or gyroid infill does not guarantee isotropic strength.
- Balance orientation against accuracy of holes and mating faces, bed adhesion, warping, and accessible supports. Do not always choose the largest flat face or automatically rotate every structural part by a fixed angle.
- Consider ribs, smooth load transitions, local perimeter changes, or splitting into separately oriented parts. Added walls or infill are design choices, not a load rating. Do not promise structural safety from a valid solid, a material name, or an unvalidated simulation.

### Walls, Floors, and Small Features

- Use actual extrusion widths and layer heights from the selected slicer preset, not nozzle diameter alone. For a fixed-width strategy, perimeter count times line width is a starting estimate; overlap, gap fill, variable-width paths, and thin-wall algorithms change the result. Inspect toolpaths for missing or single-line features.
- Select CAD wall and floor thickness for function and required stiffness; then check that the slicer produces the intended walls and solid layers. Do not impose a universal minimum wall, force every dimension onto a layer-height multiple, or change fit-critical dimensions just to round a layer count.
- Inspect screw-boss roots, slots, vents, lettering, rib runouts, and areas thinned by later cuts. Sampled wall-thickness checks can miss local minima; record method, resolution, and the measured location rather than claiming exhaustive coverage.

### Overhangs, Bridges, and Supports

- Define the angle convention when discussing limits: here a wall tilted 0 degrees from vertical is upright and 90 degrees is a horizontal underside. A 45-degree flag can be a provisional review trigger, never a universal pass/fail threshold.
- Distinguish unsupported islands and cantilevers from bridges anchored at both ends. Assess span, bridge direction, anchor length, cooling, material, speed, and sag allowance. There is no universal supported bridge length for all printers.
- Compare reorientation, a printable slope/chamfer, a different opening profile, splitting the part, and supports. Preserve the required opening envelope and ask before changing its functional shape.
- Check whether supports can be reached and removed, especially inside ducts, blind cavities, and enclosed assemblies. Keep support contact away from fit-critical or cosmetic surfaces where possible; document the trade-off instead of automatically choosing tree supports.
- Bed-facing roundovers can create difficult lower overhangs; compare a chamfer or changed orientation. Do not remove a load-bearing fillet or mating datum solely for easier printing without reviewing the consequence.

### Fits, Holes, and Tolerance Budgets

- Separate nominal hardware size, intended clearance/interference, manufacturing tolerance, and printer compensation. Ask whether parts should slide, rotate, snap, clamp, or remain permanently pressed together. Do not use one global clearance for every interface.
- State whether a gap is per side, radial, diametral, or total. For concentric round parts, hole diameter minus shaft diameter is diametral clearance; radial clearance is half that value. Check tolerance extremes, not only nominal dimensions.
- As an arithmetic example, a 10.0 mm shaft in a 10.4 mm hole has 0.4 mm diametral or 0.2 mm radial clearance. This is not a recommended fit allowance. If the shaft can be 10.1 mm and the hole 10.2 mm, worst-case diametral clearance is only 0.1 mm.
- Holes, slots, and bosses can print differently by size and axis. Horizontal bores may sag or become noncircular; preserve the true clearance envelope if using a self-supporting roof, or plan accessible drilling/reaming and a representative coupon.
- Record CAD allowances and slicer XY/hole/first-layer compensation together so they are not accidentally applied twice. Tessellation should resolve the smallest critical feature adequately; a smooth preview does not prove exported hole accuracy.

### First Layers and Bed Fit

- First-layer spreading (elephant foot) can obstruct mating surfaces near the bed. Inspect the calibrated first-layer setup before proposing a bottom relief or slicer compensation. Check thin features and brim attachment; do not stack compensation blindly.
- Check the oriented part plus supports, brim, purge structures, and required machine clearances against the actual usable build area. A nominal rectangular build volume is insufficient for excluded regions, multi-tool modes, or sequential-print clearance.
- Consider tall/narrow stability, small contact patches, large flat corners, contraction, and material-specific adhesion. A mesh being inside the bed envelope does not establish adhesion or freedom from warping.

### Fasteners, Inserts, and Snap-Fits

- For heat-set inserts, obtain the exact supplier part/drawing and its recommended receiving-hole geometry and installation guidance. Thread size alone does not determine insert outer diameter, pilot hole, taper, depth, or boss dimensions. Do not reuse a single M3 boss recipe across insert families.
- Check remaining boss wall, root reinforcement, screw length/bottoming, insertion-tool access, retention direction, and heat exposure of nearby features. Use a coupon for the chosen filament/process; insertion success does not prove pull-out strength or torque resistance.
- Captive nuts and screw joints need installation access, retention, and a load path that does not split layers. Thread-forming screws, clearance bolts, printed threads, and inserts require different hole designs; identify which is intended.
- Snap-fits and flexures require a defined deflection, engagement, release path, cycle count, print orientation, and material behavior. Avoid abrupt root corners; compare a longer compliant arm or different mechanism when strain is high. Generic gap or infill values do not validate a snap-fit.
- Test representative tabs for insertion force, permanent deformation, repeated cycling, and creep under sustained deflection. Do not assume a printed living hinge will behave like an injection-molded one.

### Material and Process Selection

- Choose material after understanding service conditions and printer capability. PLA, PETG, ASA/ABS, PA, PC, and TPU describe families with widely varying formulations. Prefer the exact manufacturer's technical data and tested preset over a generic temperature/strength table.
- Distinguish printing temperatures from service limits; glass transition and heat-deflection test results are not continuous-use ratings under arbitrary load. Consider creep over time, fatigue, impact, UV, moisture conditioning, dimensional change, and cleaning chemicals where relevant.
- Check enclosure, nozzle/bed temperature limits, abrasive-filled-filament compatibility, drying/storage, bed-surface compatibility, and manufacturer ventilation guidance. Filled materials may improve stiffness without improving toughness or interlayer strength.
- Give one reasoned material recommendation and a fallback when useful. Keep unspecified values unknown; never invent universal shrink factors, safe loads, or insert installation temperatures.

## Evidence and Handoff

Use separate statuses for each requirement: checked pass, checked fail, not checked, or not applicable with a reason. Label assumptions as provisional. A waived failure remains a failure with an accepted trade-off, not a pass. Do not weaken a requirement merely to make a report green.

Report these layers separately, identifying the model revision and actual printer/material/settings used where known:

- Geometry: solid validity, intended body count, units, measured critical features, clearances, export/reimport checks, and limitations of any sampling.
- Slicer: actual orientation and usable bed fit, missing walls/features, bridge direction, unsupported islands, support removal, first layers, and complete part toolpaths. Record whether the exported 3MF is geometry-only or a verified slicer project; CAD-Pilot's 3MF export is not a configured print preset.
- Physical: coupon measurements, real assembly, insert retention, cycling, or appropriate load/temperature trials actually performed. State the test conditions and do not extrapolate them to untested safety claims.

Stop and ask when a missing fit-critical measurement, conflicting constraints, or significant failure consequences prevent a responsible next step. Do not certify load-bearing, pressure-retaining, electrical, medical, or food-contact suitability from these checks. Do not send G-code, change live printer settings, or start a print without explicit user approval.

## Learning From Prints

Start with the confirmed equipment and material notes already available; do not require a structured profile or calibration exercise before useful design work. When a print yields a reusable result, record the relevant model/feature, printer, nozzle, material, settings, orientation, measurement, and what worked or failed in the project's existing notes. Keep assumptions distinct from measurements, and check applicability before reusing a result for a different configuration. Introduce more structure only when repeated use needs it.

## Sources and Boundaries

This is original CAD-Pilot guidance informed by the sources below, not an imported OpenSCAD skill. The community skills were reviewed, not installed. Their fixed workflow and numeric defaults are not adopted as universal rules.

- [Prusa: Modeling with 3D printing in mind](https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135): orientation, supported geometry, walls, fit variability, and iteration.
- [Prusa: Elephant foot compensation](https://help.prusa3d.com/article/elephant-foot-compensation_114487): first-layer spreading, compensation, and thin-feature/brim interactions.
- [Prusa: PETG](https://help.prusa3d.com/article/petg_2059): cooling/layer-adhesion trade-offs, bridging and support behavior, formulation differences, and build-surface compatibility. Do not adopt its example temperatures as another filament's preset or service rating.
- [SPIROL: Threaded inserts for plastics](https://www.spirol.com/product/threaded-inserts-for-plastics/): insert families, installation methods, and supplier-specific hole/tolerance/boss selection. Molded-plastic performance does not establish FDM retention strength.
- [Formlabs: Snap-fit joints](https://formlabs.com/blog/designing-3d-printed-snap-fit-enclosures/): snap-fit types, deflection/material dependence, orientation, and iteration. Use its qualitative FDM considerations, not SLA/SLS settings or blanket clearance/strength figures.
- [swh/openscad-skill](https://github.com/swh/openscad-skill/blob/8c6313f44ffcad340c818a50347ab464eb2f59d7/openscad-bosl2/SKILL.md): reviewed for FDM-oriented workflow, orientation, material choice, and slicer handoff; not imported because it couples these to BOSL2 and personal defaults.
- [andreahaku/openscad_claude_skill](https://github.com/andreahaku/openscad_claude_skill/blob/c47ef2359a3329da45c3c2e6caa3c286133c2844/SKILL.md): reviewed for measured-profile separation and fit feedback; not imported because it imposes an OpenSCAD/Linux-oriented workflow and mixes provisional numeric rules into modeling guidance.

Sources reviewed 2026-09-14. Fetch the exact printer, filament, and insert supplier documentation when a design depends on them. Manufacturer examples apply only under their stated conditions; these references do not turn unknown user hardware into a confirmed profile.