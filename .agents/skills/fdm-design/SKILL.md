---
name: fdm-design
description: 'Design and review parts for FDM/FFF 3D printing. Use before modeling or changing anything that will be 3D printed, and when choosing print orientation, filament or supports; sizing walls, bridges and overhangs; planning fits and clearances, screw holes, heat-set inserts or snap-fits; preparing a Bambu Studio print or reading slicer results; or calibrating a printer''s hole and contour compensation. Complements the cad and visual-review skills; it does not certify printability or control a printer.'
---

# FDM Design and Review

## Scope

Use this skill alongside the cad and visual-review skills, not instead of them. It supplies design-for-additive-manufacturing reasoning, not an automatic printability validator. The cad skill's print handoff (`references/print.md`) owns the personal print profile, Bambu Studio projects, orientation and slice checks, and coupons.

## Workflow

1. Understand the job in plain language: what it holds or mates to, where force acts, assembly and removal access, expected cycles, heat, sunlight, moisture, and the consequences of failure. Use a marked view or a simple question when the load path or feature is unclear. For a rough visual concept, proceed with labelled assumptions rather than a long questionnaire, and do not call that concept print-ready.
2. Read the user's print profile as the print handoff describes, with the hole and contour compensation measured for each filament on each printer, and the project's confirmed printer, nozzle, filament, slicer preset and calibration records. A profile for another printer, spool, nozzle, orientation or slicer setup is not evidence for this one, and pasted research does not tell you the user's hardware.
3. Choose a provisional print orientation and material before committing to details, comparing strength, bed contact, surface finish, support removal and critical interfaces. Keep the functional model frame separate from the print placement, which the print job holds.
4. Apply the checklist below to the relevant features, recording numerical values with units, source, applicability and evidence status. Rules of thumb are proposals, never universal limits.
5. Check the generated geometry, not the parameters: a constant named `wall_thickness` does not establish the thinnest wall after Booleans, fillets and export. Use section views for hidden features.
6. Hand the print off with the cad skill's `scripts/print`, which checks each part in its print orientation, writes the Bambu Studio project and slices it. Until a slice check has run, label slicer checks not checked; its times and weights are estimates. Review the plates in Bambu Studio for what the command line cannot judge, such as seams and support access.
7. After the checks in Before Printing, propose the smallest physical test needed: a fit coupon, insert boss, snap tab, bridge sample or load-representative feature.

## Design Checklist

### Orientation and Strength

- Identify tension, bending, impact, torsion and sustained loads. FDM strength depends on layer bonding, toolpaths, material and process: keep critical tensile loads from pulling layers apart. A diagonal print or gyroid infill does not make a part isotropic.
- Balance orientation against the accuracy of holes and mating faces, bed adhesion, warping and accessible supports; do not always choose the largest flat face or rotate every structural part by a fixed angle.
- Consider ribs, smooth load transitions, local perimeter changes or splitting into separately oriented parts. Added walls or infill are design choices, not a load rating; a valid solid, a material name or an unvalidated simulation does not establish structural safety.

### Walls, Floors and Small Features

- Use the slicer preset's actual extrusion widths and layer heights, not the nozzle diameter. Perimeter count times line width is only a starting estimate; gap fill, variable-width paths and thin-wall algorithms change the result, so inspect toolpaths for missing or single-line features.
- Choose wall and floor thickness for function and stiffness, then check that the slicer produces the intended walls and solid layers. Do not impose a universal minimum wall, force dimensions onto layer-height multiples, or change fit-critical dimensions to round a layer count.
- Inspect screw-boss roots, slots, vents, lettering, rib runouts and areas thinned by later cuts. Sampled wall checks can miss local minima; record the method, resolution and location rather than claiming exhaustive coverage.

### Overhangs, Bridges and Supports

- Angles here are from vertical: 0 degrees is an upright wall, 90 a horizontal underside. A 45-degree flag is a review trigger, never a pass/fail threshold.
- Distinguish unsupported islands and cantilevers from bridges anchored at both ends; span, direction, anchor length, cooling, material and speed all matter, and no bridge length holds for every printer.
- Compare reorientation, a printable slope or chamfer, a different opening profile, splitting the part, and supports. Preserve a required opening envelope and ask before changing its functional shape.
- Keep supports on where the chosen orientation needs them; turn them off for a part only with a reason the user accepts. An interface layer in another material, such as PLA under PETG, separates cleanly when the print profile sets one.
- Check that supports can be reached and removed, especially inside ducts, blind cavities and enclosed assemblies, and keep their contact off fit-critical or cosmetic surfaces where possible.
- Bed-facing roundovers make difficult lower overhangs; compare a chamfer or another orientation, but do not remove a load-bearing fillet or mating datum only to ease printing.

### Fits, Holes and Tolerance Budgets

- **The model states the fit; only measured compensation corrects shrinkage.** Model each hole, pin and mating face at the size the fit needs, such as an M3 clearance hole at 3.4 mm, and never add an allowance for how the printer or filament prints. Plastic contracts as it cools, so holes print small and outer edges can print off size; the X-Y hole and contour compensation measured for the filament on that printer, which `scripts/print` writes into each project, corrects that. Until it is measured, holes print a little small: offer a calibration coupon rather than enlarging the model. A fit coupon finds the clearance a fit needs and prints with the measured compensation; a calibration coupon measures the compensation and prints with it at 0. The cad skill's `references/print.md` describes both.
- Separate nominal hardware size, intended clearance or interference, and manufacturing tolerance. Ask whether parts should slide, rotate, snap, clamp or stay pressed together; do not use one clearance for every interface.
- Say whether a gap is per side, radial, diametral or total: a 10.0 mm shaft in a 10.4 mm hole has 0.4 mm diametral or 0.2 mm radial clearance (an example, not a recommended fit). Check tolerance extremes: if the shaft can be 10.1 mm and the hole 10.2 mm, the worst case is 0.1 mm.
- Compensation reaches only openings a layer encloses, such as a hole vertical as printed. Horizontal bores may sag or go out of round: keep the true clearance envelope under a self-supporting roof, or plan drilling or reaming and a representative coupon.
- Holes under about 1 mm, close to the nozzle's own width, print unreliably whatever the compensation, and a hole that opens to the outside at some heights, such as one with a slot to the edge, gets a small step where compensation stops. The orientation check reports both.
- Tessellation must resolve the smallest critical feature; a smooth preview does not prove exported hole accuracy.

### First Layers and Bed Fit

- First-layer spreading (elephant foot) can obstruct mating surfaces near the bed. The process's elephant-foot compensation corrects it, and the project report gives the value in force: check a printed first layer before changing it, do not also model a bottom relief, and check thin features and brims, which the compensation thins.
- Check the oriented part with supports, brim, purge structures and machine clearances against the usable build area, not a nominal rectangle; excluded regions and multi-tool modes shrink it.
- Consider tall or narrow parts, small contact patches, large flat corners and material-specific adhesion; fitting the bed does not establish adhesion or freedom from warping.

### Fasteners, Inserts and Snap-Fits

- For heat-set inserts, get the exact supplier part and its recommended receiving hole and installation guidance; thread size alone does not set the outer diameter, pilot hole, taper, depth or boss. Check the remaining boss wall, screw length and bottoming, tool access and heat near other features, and test a coupon in the chosen filament: insertion success does not prove pull-out or torque strength.
- Captive nuts and screw joints need installation access, retention and a load path that does not split layers. Thread-forming screws, clearance bolts, printed threads and inserts need different holes; identify which is intended.
- Snap-fits and flexures need a defined deflection, engagement, release path, cycle count, orientation and material behaviour; avoid abrupt root corners, and compare a longer arm or another mechanism when strain is high. Test representative tabs for insertion force, permanent set, cycling and creep; a printed living hinge does not behave like a moulded one.

### Material and Process Selection

- Choose material after the service conditions and printer capability are known. PLA, PETG, ASA/ABS, PA, PC and TPU are families with widely varying formulations; prefer the manufacturer's technical data and a tested preset over a generic table.
- Printing temperatures are not service limits, and glass-transition or heat-deflection results are not continuous-use ratings under load. Consider creep, fatigue, impact, UV, moisture, dimensional change and cleaning chemicals where relevant, and the printer's enclosure, temperature limits, abrasive-filament compatibility and drying needs.
- Give one reasoned recommendation and a fallback when useful. Never invent universal shrink factors, safe loads or insert installation temperatures.

## Before Printing

Before a print whose fit or size matters, and always before a calibration coupon, ask the user to confirm:

- The filament is dry. Damp filament, PETG and nylon especially, strings, bubbles and prints rough, off-size walls; dry it as its maker advises when in doubt.
- Flow dynamics are calibrated for this filament on this printer and nozzle, with Bambu Studio's flow dynamics calibration or the printer's own at the start of a print. Uncalibrated flow bulges corners and changes wall widths.
- The elephant-foot compensation in force suits the first layer.

These are the user's checks; the tools do not verify them. Measured compensation holds only for the filament and settings it was measured with: measure again after changing the filament's brand or the nozzle, or when the project report warns that the resolution or closing radius has changed.

## Evidence and Handoff

Report each requirement as checked pass, checked fail, not checked, or not applicable with a reason, under the cad skill's reporting rules. A waived failure remains a failure with an accepted trade-off, not a pass; do not weaken a requirement to make a report green. Report these layers separately, with the model revision and the actual printer, material and settings where known:

- Geometry: solid validity, intended body count, units, measured critical features, clearances, and the limits of any sampling.
- Slicer: orientation and usable bed fit, missing walls or features, bridge direction, unsupported islands, support removal, first layers and complete toolpaths. Say whether a 3MF is geometry only (the `scripts/step --3mf` sidecar) or a Bambu Studio project from `scripts/print`, the compensation each part sliced with (measured or unmeasured), and whether its slice check ran.
- Physical: coupon measurements, real assembly, insert retention, cycling or load and temperature trials actually performed, with their conditions; do not extrapolate them to untested safety claims.

Stop and ask when a missing fit-critical measurement, conflicting constraints or serious failure consequences prevent a responsible next step. Do not certify load-bearing, pressure-retaining, electrical, medical or food-contact suitability from these checks, and do not change live printer settings.

Start from the equipment and material notes already confirmed; no structured profile or calibration exercise is needed before useful design work. When a print yields a reusable result, record the feature, printer, nozzle, material, settings, orientation, measurement and outcome in the project's notes; measured hole and contour compensation belongs to the printer and filament, so it goes in the print profile, with the user's agreement. Check applicability before reusing a result for another configuration.

## Sources and Boundaries

This is original CAD-Pilot guidance informed by the sources below; the community skills reviewed for it are recorded in the skills registry.

- [Prusa: Modeling with 3D printing in mind](https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135): orientation, supported geometry, walls, fit variability, and iteration.
- [Prusa: Elephant foot compensation](https://help.prusa3d.com/article/elephant-foot-compensation_114487): first-layer spreading, compensation, and thin-feature/brim interactions.
- [Prusa: PETG](https://help.prusa3d.com/article/petg_2059): cooling/layer-adhesion trade-offs, bridging and support behavior, formulation differences, and build-surface compatibility. Do not adopt its example temperatures as another filament's preset or service rating.
- [SPIROL: Threaded inserts for plastics](https://www.spirol.com/product/threaded-inserts-for-plastics/): insert families, installation methods, and supplier-specific hole/tolerance/boss selection. Molded-plastic performance does not establish FDM retention strength.
- [Formlabs: Snap-fit joints](https://formlabs.com/blog/designing-3d-printed-snap-fit-enclosures/): snap-fit types, deflection/material dependence, orientation, and iteration. Use its qualitative FDM considerations, not SLA/SLS settings or blanket clearance/strength figures.

Sources reviewed 2026-09-14. Fetch the exact printer, filament, and insert supplier documentation when a design depends on them. Manufacturer examples apply only under their stated conditions; these references do not turn unknown user hardware into a confirmed profile.