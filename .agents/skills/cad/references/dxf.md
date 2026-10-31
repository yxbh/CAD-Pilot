# DXF output

Read this only when the user wants DXF or another 2D drawing output from CAD geometry. DXF is secondary: build and check the `gen_step()` geometry first, and do not treat DXF layers as STEP part or assembly structure.

A DXF target is a Python source defining both `gen_step()` (discovery uses the CAD source catalog) and:

```python
def gen_dxf():
    ...
    return document, dxf_output
```

```bash
python <cad>/scripts/dxf path/to/source.py
```

Run it on explicit sources; it takes only the standard help flags. Report the DXF beside the primary STEP and its checks, with the drawing-layer content when available.
