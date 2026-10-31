# DXF output

Read this only when the user wants DXF or another 2D drawing output from CAD geometry. DXF is secondary: build and check the `gen_step()` geometry first, and do not treat DXF layers as STEP part or assembly structure.

A DXF target is a Python source defining both `gen_step()` (discovery uses the CAD source catalog) and `gen_dxf()`, which returns an ezdxf document (or `{"document": document}`):

```python
def gen_dxf():
    document = ezdxf.new()
    ...
    return document
```

```bash
python <cad>/scripts/dxf path/to/source.py [-o drawings/source.dxf]
```

It writes `<source>.dxf` beside the source unless `-o` names another path (one target only). Report the DXF beside the primary STEP and its checks, with the drawing-layer content when available.
