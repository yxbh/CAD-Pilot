# Print handoff

Read this when the user wants to print: a Bambu Studio project 3MF, a slice check, a check of a print orientation, or a fit coupon. Use the fdm-design skill for the design reasoning behind orientation, supports and fits; this file covers the tool.

## Tool

`scripts/print` writes one Bambu Studio project per print job, checks each part in its print orientation, and can slice the project with the installed Bambu Studio's command line. Run it with the workbench's Python interpreter from the design project's root, like `scripts/step`:

```bash
python <cad>/scripts/print project prints/jig.print.json --slice
python <cad>/scripts/print project outputs/bracket.step --rotate 180 0 0 --slice
python <cad>/scripts/print slice prints/jig.3mf
python <cad>/scripts/print check outputs/bracket.step --rotate 0 90 0
python <cad>/scripts/print coupon -o prints/pin-ladder.step --diameter 10 --clearances 0.1 0.2 0.3 0.4
python <cad>/scripts/print profile
python <cad>/scripts/print presets H2D 0.4 PETG
```

`<cad>` is this skill's directory. `--format json` gives machine-readable output; `--help` on each command lists every option. Bambu Studio must be installed; set `bambu_studio` in the print profile or the `BAMBU_STUDIO` environment variable when it is not in its usual place.

## The personal print profile

Printer, process, build plate, filaments, colours and supports are stored once per user in `~/.cad-pilot/print-profile.json`, outside every repository. Every job uses it; a job's `profile` table overrides it for that project.

```json
{
  "printer": "Bambu Lab H2D 0.4 nozzle",
  "process": "0.20mm Standard @BBL H2D",
  "bed_type": "High Temp Plate",
  "filament": "PETG",
  "filaments": {
    "PETG": {"preset": "Bambu PETG Basic @BBL H2D 0.4 nozzle", "colour": "#9E9E9E"},
    "PLA": {"preset": "Bambu PLA Basic @BBL H2D", "colour": "#FFFFFF"}
  },
  "support": {"type": "tree(auto)", "interface_filament": "PLA"},
  "process_settings": {"resolution": "0.003", "slice_closing_radius": "0.01"}
}
```

- `printer`, `process` and each filament `preset` are Bambu Studio system preset names; `presets` lists the installed ones, and `profile` checks that every name exists.
- `bed_type` is one of Cool Plate, Engineering Plate, High Temp Plate (smooth PEI), Textured PEI Plate or Supertack Plate. Projects refuse a filament that Bambu gives no bed temperature on that plate.
- `filament` names the default entry of `filaments`; parts pick another by its key.
- `support.type` is `tree(auto)` or `normal(auto)`. `interface_filament` names a filament printed as the support's contact layer under parts in another material, such as PLA under PETG, which peels off cleanly.
- `process_settings` are Bambu process settings applied to every project, written as text the way Bambu Studio writes them (`"wall_loops": "4"`, not `4`, which Bambu ignores). Bambu Studio shows them, and the support settings, as changes to the process preset.

When the file is missing, ask the user, one plain question at a time, which printer and nozzle, quality, filament and colour, build plate and supports they use, then write it and run `profile`. Do not infer these from 3MFs in Downloads, another project or the example above.

## Print jobs

A job file, conventionally `<name>.print.json` beside the project's print outputs, lists named plates and the part files on each. Paths are relative to the job file. One job writes one 3MF, by default `<name>.3mf` beside the job, or its `output`.

```json
{
  "name": "F2 jig",
  "output": "prints/f2-jig.3mf",
  "profile": {"filaments": {"PETG": {"colour": "#688197"}}},
  "plates": [
    {"name": "Fit test - print first", "parts": [
      {"file": "../outputs/coupon.step", "rotate": [180, 0, 0]},
      {"file": "../outputs/pin-ladder.step"}
    ]},
    {"name": "Frame", "parts": [{"file": "../outputs/frame.step"}]},
    {"name": "Posts", "parts": [{"file": "../outputs/post.step", "rotate": [180, 0, 0], "copies": 4, "support": false}]}
  ]
}
```

- Named plates hold exactly their parts. When they do not fit, the command fails and names the parts, rather than moving them to another plate or file. A job with `parts` instead of `plates` packs them onto as few plates as they need, named after the job.
- Part fields: `file` (STEP, STP or STL), `name` (default: the file name), `rotate` (`[x, y, z]` degrees about the fixed axes, applied X, then Y, then Z), `copies`, `filament` (a profile filament key), `colour` (`#RRGGBB`, a filament slot of its own), `support` (default true) and `turn` (default true: the layout may turn the part a quarter turn about Z to fit).
- A turned part is set down with its lowest point on the bed. Keep the model's functional frame in source; the job holds the print placement.
- A STEP file prints as one object. Several solids in it print where the file places them, so give an assembly's parts their own files.
- Supports are on in every project with the profile's type, and Bambu Studio adds them only where the orientation needs them. Turn them off for a part only with a reason the user accepts; the report warns when a part that needs support has it off. Parts that need support and are printed in another material than the interface get the interface with no gap. A plate whose parts use two filaments gets a prime tower of the preset's tower width, placed on the bed inside the area every nozzle reaches and clear of the bed's excluded areas, and the layout keeps parts clear of it.

## Orientation checks

`project` checks every part in its job orientation, and `check` checks one part in any orientation, with the profile's layer height, line width and support angle. Each check reports numbers with locations in the model's own coordinates and heights above the bed:

- Bed contact: area and number of separate contact islands; undersides a little above the bed, which print on support or air, usually a bed face split into two heights.
- Overhangs: area tilted past 45 degrees from vertical (a review trigger), and area past the slicer's support angle (needs support), by region.
- Flat undersides: a bridge, held from below on opposite sides, with its span; an overhang, held on one side, with how far it reaches out; or an island, held nowhere. Each reports the material above it, so a thin wall laid on its side shows as a thin shelf.
- Walls thinner than two line widths in sampled layer outlines, with their thickness and the heights they run through. The raster pitch bounds the thickness error, and thin places shorter than 1 mm, such as chamfer and fillet edges, are counted rather than listed.

These are measurements of one orientation, not a printability verdict. Compare orientations with `check --rotate` before choosing one, and keep fit faces off bridges and support contact.

## Slice check

`--slice` or `slice` slices every plate with Bambu Studio's command line, in a temporary data folder that leaves the app's own settings alone, and reports each plate's estimated time, filament per slot, support time, whether it printed a prime tower, and Bambu's warnings. Every plate is reported. When a run fails, crashes or logs crossing toolpaths, the plates not yet accounted for are sliced one at a time, so each problem lands on its own plate. The exit code is 1 when any plate failed or has crossing toolpaths, which the app only warns about. When the command line crashes on macOS, the report names the function it crashed in, from the system's crash report. Slicing opens no window. The times and weights are the slicer's estimates, not a measured print.

`slice` also checks projects saved by Bambu Studio itself, which carry their full settings like the projects this tool writes.

## Fit coupons

`coupon` writes a STEP of a bar with round holes for a part of the nominal `--diameter`, one hole per diametral clearance, each marked with as many dimples as its place in the list; `--peg` also writes a peg at the nominal diameter. Print it flat with the real mating part or the peg, record which dimple count fits, and keep that result with the project's notes and print configuration.

## Reporting

- Give the user the 3MF path every time; the tool prints it last as `3MF: <path>`. Open the project in Bambu Studio with `--open` when the user wants to see it or print it.
- Report the profile used, each plate's parts, the orientation numbers and flags that matter for the design, and the slice results. Name a check that did not run as not checked.
- Never send G-code to a printer or publish a model without the user's explicit approval.

## Limits

- Bambu Studio and its system presets only; presets the user saved in the app are not read.
- A project holds at most 36 plates.
- Part meshes must be closed solids. STEP faces are meshed to within 0.01 mm.
- The layout packs each part's footprint rectangle.
