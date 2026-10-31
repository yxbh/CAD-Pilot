"""Load a design generator as its own project would import it.

The tools run from the design root. A generator can import modules beside it,
modules at the design root and, in a ``src/`` layout, the project's packages,
with no ``sys.path`` code of its own. Each load reads the generator and those
project modules afresh, so a second generator with a same-named sibling module,
or an edit during a long-lived worker, never runs stale code. Third-party
packages come from the Python running the tools, so a project with its own
environment runs the tools with that environment's interpreter (it already has
build123d).
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import site
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType


class GeneratorImportError(RuntimeError):
    """A generator imports a module this interpreter cannot find."""


class MissingGeneratorError(RuntimeError):
    """A generator file does not define the function asked for."""


_TOOLS_DIR = Path(__file__).resolve().parents[1]


def project_import_paths(script_path: Path, *, root: Path | None = None) -> list[Path]:
    """The folders a generator imports from: its own, the design root, and the root's ``src/``."""
    root = (root or Path.cwd()).resolve()
    candidates = [script_path.resolve().parent, root, root / "src"]
    paths: list[Path] = []
    for path in candidates:
        if path.is_dir() and path not in paths:
            paths.append(path)
    return paths


@contextlib.contextmanager
def _project_imports(script_path: Path) -> Iterator[None]:
    """The project's folders first on the import path while its code runs, then the tools' own path back."""
    saved = list(sys.path)
    sys.path[:0] = [str(path) for path in project_import_paths(script_path)]
    try:
        yield
    finally:
        sys.path[:] = saved


def _installed_folders() -> tuple[str, ...]:
    """Folders whose modules belong to the interpreter or the tools, never to the project, even inside its root."""
    folders = {sys.prefix, sys.base_prefix, site.getusersitepackages(), *site.getsitepackages(), str(_TOOLS_DIR)}
    return tuple({os.path.join(form, "") for folder in folders for form in (folder, os.path.realpath(folder))})


def _forget_project_modules(script_path: Path) -> None:
    """Drop modules imported from the project's folders, so this load imports them from disk again.

    The folders go on ``sys.path`` resolved, so their modules' files carry resolved paths and a prefix test suffices.
    """
    project = tuple(os.path.join(str(path), "") for path in project_import_paths(script_path))
    installed = _installed_folders()
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if isinstance(file, str) and file.startswith(project) and not file.startswith(installed):
            del sys.modules[name]


def _module_name(script_path: Path) -> str:
    safe = "".join(char if char.isalnum() else "_" for char in script_path.as_posix())
    return f"_cad_generator_{safe}"


def missing_module_message(exc: ModuleNotFoundError, *, display_path: str) -> str:
    name = exc.name or str(exc)
    return (
        f"{display_path} imports {name!r}, which {sys.executable} cannot find. "
        "Run the cad tools from the design root; the generator's folder, the design root and its src/ folder "
        "are importable. If the project has its own Python environment, run the tools with that "
        "environment's interpreter (for example `uv run python <cad>/scripts/step ...`)."
    )


def load_generator(script_path: Path, *, display_path: str | None = None) -> ModuleType:
    """The generator's module, freshly executed so module state never carries between reads."""
    resolved = script_path.resolve()
    module_spec = importlib.util.spec_from_file_location(_module_name(resolved), resolved)
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"Failed to load generator module from {display_path or resolved.as_posix()}")
    module = importlib.util.module_from_spec(module_spec)
    _forget_project_modules(resolved)
    sys.modules[module_spec.name] = module
    try:
        with _project_imports(resolved):
            # Compile the source itself: a cached .pyc is checked only against the source's whole-second mtime and
            # size, so an edit of the same length within a second would otherwise run the old code. dont_inherit
            # keeps this file's own __future__ imports out of the generator's code.
            exec(compile(resolved.read_bytes(), str(resolved), "exec", dont_inherit=True), module.__dict__)
    except ModuleNotFoundError as exc:
        sys.modules.pop(module_spec.name, None)
        raise GeneratorImportError(missing_module_message(exc, display_path=display_path or resolved.name)) from exc
    except BaseException:
        sys.modules.pop(module_spec.name, None)
        raise
    return module


def call_generator(module: ModuleType, name: str, *, script_path: Path, display_path: str | None = None) -> object:
    """Call ``module.name()``, turning a lazy import the interpreter lacks into a plain explanation."""
    function = getattr(module, name, None)
    if not callable(function):
        raise MissingGeneratorError(f"{display_path or script_path.name} does not define {name}()")
    try:
        with _project_imports(script_path):  # lazy imports inside the generator see the project too
            return function()
    except ModuleNotFoundError as exc:
        raise GeneratorImportError(missing_module_message(exc, display_path=display_path or script_path.name)) from exc
