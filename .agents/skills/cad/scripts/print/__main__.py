from __future__ import annotations

import sys
from pathlib import Path

try:
    if __package__ in {None, ""}:
        scripts_dir = Path(__file__).resolve().parents[1]
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        from print.cli import main
    else:
        from .cli import main
except ModuleNotFoundError as error:
    if (error.name or "").split(".")[0] in {"", "print", "common"}:
        raise
    # The mesh and CAD libraries come with the workbench's environment, which a design project's may lack.
    raise SystemExit(
        f"error: scripts/print needs {error.name}, which {sys.executable} cannot import; run it with the workbench's "
        "Python interpreter (the cad skill's Running the tools)"
    ) from None


if __name__ == "__main__":
    raise SystemExit(main())
