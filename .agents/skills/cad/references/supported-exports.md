# STL and 3MF sidecars

Read this when the user wants STL or 3MF meshes of CAD geometry. DXF uses its own `gen_dxf()` contract (`dxf.md`). A sidecar 3MF holds geometry only; a Bambu Studio project with plates, printer, filament and supports comes from `scripts/print` (`print.md`).

Meshes are sidecars of the STEP, not substitutes: generate and check the STEP first, write the meshes from the same `scripts/step` run, and show or inspect the STEP rather than a mesh.

```bash
python <cad>/scripts/step models/bracket.py -o models/bracket.step --stl bracket.stl --3mf bracket.3mf
```

`--stl` takes a `.stl` path and `--3mf` a `.3mf` path, placed as the skill's Running the tools says. A direct STEP target takes the same flags (`step-generation.md`).

A mesh is only as closed as its solid. When `scripts/step` warns that a part is not a sound or closed solid, or is inside out, its meshes can have zero-area triangles, open edges or inward-facing triangles; repair the source (`repair-loop.md`) before sending the mesh to a slicer. A `could not check` notice leaves the part unverified.

## Mesh tolerance

Meshes are fine by default: every edge is divided until the mesh is within 0.006 of that edge's size of the true surface, and within 0.1 radians of its direction. The two flags only make meshes finer; a value at or above the default changes nothing, so a looser tolerance cannot shrink a file:

```bash
--mesh-tolerance FRACTION    # below 0.006, such as 0.0004 for small curved parts
--mesh-angular-tolerance RAD # below 0.1
```

Use them when facets show on small curved features in the slicer or in visual review. Report the mesh files with the STEP checks; a mesh written as requested is not a separate check.
