# Photos of printed parts

`scripts/photo` renders part files in Blender so they look like the FDM prints they will be: layer lines stacked the way each part is printed, in its filament's colour, on a studio backdrop. Use it for a cover image, a listing or a handoff where the reader should see the printed object. For looking at geometry, a ray-traced image of a model or anything that needs sections, steps or hidden parts, CAD Explorer's `capture` and `render` are the tools (the visual-review skill).

A photo is a picture, not a check. It does not come from the slicer's toolpaths: seams, support marks, infill showing through, the lines of top and bottom surfaces and the plate's texture on the first layer are not in it (faces square to the print direction come out smooth), and a part that looks right may still not print.

## Running it

```bash
python <cad>/scripts/photo cover.photo.json
python <cad>/scripts/photo cover.photo.json -o drafts/cover-small.png --size 800x600 --samples 32
```

Run it with the workbench's interpreter, like `scripts/print`. It needs [Blender](https://www.blender.org/) 4.2 or later installed: the one on PATH or in its usual place is found, and the `CAD_PILOT_BLENDER` environment variable names another, by its app or its executable. Blender runs in the background and opens no window. The command prints each part's colour and the direction its layers stack in the picture, then `Photo: <path>`. Draft at a small size with few samples, where a picture takes seconds, and render the final one once.

## The scene file

A scene file, conventionally `<name>.photo.json` beside the project's images, lists the part files and where each stands. Paths are relative to the scene file, with either separator. One scene writes one PNG, by default `<name>.png` beside it, or its `output`.

```json
{
  "output": "cover.png",
  "size": [3840, 2880],
  "samples": 600,
  "backdrop": "#2B333F",
  "fill": 0.5,
  "parts": [
    {"file": "../outputs/frame.step", "colour": "#7F7E83"},
    {"file": "../outputs/bracket.step", "colour": "#688197", "printed": [0, 45, 0], "rotate": [180, 0, 0], "at": [120, 0]},
    {"file": "../outputs/post.step", "name": "Post, seated", "colour": "#FF671F", "printed": [180, 0, 0], "at": [0, 0, 12]}
  ]
}
```

- Part fields: `file` (STEP, STP or STL, in millimetres), `name` (default: the file name), `colour` (`#RRGGBB`, default `#70757A`), `printed`, `rotate` and `at`. A file is one printed object: several bodies in a STEP share its colour and print direction, and a mesh that is not a closed solid is refused, as in a print job.
- `printed` is the part's `rotate` from its print job (`[x, y, z]` degrees about the fixed axes, applied X, then Y, then Z; default as modelled). It sets which way the layers run through the part, so copy it from the job the part is printed with. A turn about Z on the bed changes nothing here.
- `rotate` turns the part for the picture, the same way, and `at` places its model origin: `[x, y]` stands the turned part on the floor there, and `[x, y, z]` holds the origin at that height, for a part resting on another. Both differ from a print job's fields of the same names, where `rotate` is the print orientation (`printed` here) and `at` the footprint's low corner, so do not paste a job's part entry in. Parts are not kept apart: lay the scene out as the assembled or exploded model is laid out.
- Scene fields: `view` (`[azimuth, elevation]` in degrees, as CAD Explorer's `--view AZ:EL`, the elevation from 0 to 90; default `[28, 36]`), `size` (`[width, height]` in pixels, default 1920 by 1440), `samples` (light paths per pixel, default 400), `backdrop` (`#RRGGBB`, default `#9E9E9C`, which the lights show as a light grey), `layer_height` (mm, default 0.2: use the print's) and `fill` (the share of the picture's height the parts take, default 0.8; lower it to leave room for a title).
- `-o`, `--size`, `--samples` and `--view` on the command line override the scene's values for one run.

The camera frames all the parts by itself from the view's direction, with a 70 mm lens and a little depth of field, which scales with the scene; the lights are a large soft key from the upper left, a weak fill and a light from behind.

## Colour

A filament maker's hex value is a swatch for a screen, not a measurement of printed plastic, and the two can differ a lot.

- Bambu Studio ships Bambu's swatches in `filaments_color_codes.json` under its `profiles/BBL/filament` resources, by filament line and colour name. They are a good start for opaque, mid-toned colours.
- Saturated and translucent colours print lighter and milkier than their swatch. Where the maker's site shows a printed sample, take the colour from the middle tones of that photo instead, and say which source each colour came from.
- The picture is rendered without the roll-off towards grey that Blender applies to bright colours by default. Lit faces still read lighter than the colour given, and a strongly saturated colour can clip towards a lighter tint where the key light falls on it; shaded faces read darker. Judge a colour by a part's middle tones.
- When the user has photos of their own prints in that filament, those outrank both: match the lit and shaded faces to them.

## How the look is made

- **Layers.** Each part's surface is shaded as the stack of rounded beads it is printed as, one per layer along its print direction, by working out the bead's slope exactly at every point a camera ray reaches and tilting the surface normal by it. Close up this draws the single lines. Where a layer is finer than a pixel, the many rays through each pixel average into the stretched sheen a print has from a distance. A bump or normal map does not do this: it measures the slope across a pixel and turns finer lines into false, coarser patterns.
- **What that implies.** A 0.2 mm layer is about one pixel wide when a 400 mm scene fills a 2000 pixel picture, so single lines show only in close views or large pictures. A part printed leaned over shows rings where its surface runs nearly parallel to the layers; that is the print's real stair-stepping.
- **Finish.** The plastic is satin, with each layer a touch glossier or duller and lighter or darker than its neighbours.

When a picture looks wrong, check the print direction first (the command prints it for each part), then the colour's source, then the size of a layer in pixels.
