"""Load a design generator as its own project would import it.

The tools run from the design root. A generator can import modules beside it,
modules at the design root and, in a ``src/`` layout, the project's packages,
with no ``sys.path`` code of its own. Each load reads the generator and those
project modules afresh from their source, never from cached bytecode, so a
second generator with a same-named sibling module, or an edit during a
long-lived worker or within the same second, never runs stale code. Third-party
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
from collections.abc import Callable, Iterator
from importlib import machinery
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


class _SourceLoader(machinery.SourceFileLoader):
    """Compiles a project file from its source on every load and writes no bytecode.

    A cached ``.pyc`` is matched to its source only by whole-second mtime and size, so an edit of the same length
    within a second would otherwise run the old code. ``source_to_code`` compiles with ``dont_inherit``, which keeps
    this file's own ``__future__`` imports out of the project's code.
    """

    def get_code(self, fullname: str):
        path = self.get_filename(fullname)
        return self.source_to_code(self.get_data(path), path)


# The interpreter's own file loaders, in its order, with project sources compiled afresh.
_PROJECT_LOADERS = (
    (machinery.ExtensionFileLoader, machinery.EXTENSION_SUFFIXES),
    (_SourceLoader, machinery.SOURCE_SUFFIXES),
    (machinery.SourcelessFileLoader, machinery.BYTECODE_SUFFIXES),
)


def _installed_folders() -> tuple[str, ...]:
    """Folders whose modules belong to the interpreter or the tools, never to the project, even inside its root."""
    folders = {sys.prefix, sys.base_prefix, site.getusersitepackages(), *site.getsitepackages(), str(_TOOLS_DIR)}
    return tuple({os.path.join(form, "") for folder in folders for form in (folder, os.path.realpath(folder))})


def _in_project(folders: list[Path]) -> Callable[[object], bool]:
    """Whether a file or folder belongs to the project: under its import folders, not the interpreter's or the tools'.

    The folders go on ``sys.path`` resolved, so the paths of their packages and modules start with them.
    """
    project = tuple(os.path.join(str(path), "") for path in folders)
    installed = _installed_folders()

    def belongs(path: object) -> bool:
        if not isinstance(path, str):
            return False
        path = os.path.join(path, "")
        return path.startswith(project) and not path.startswith(installed)

    return belongs


@contextlib.contextmanager
def _project_imports(script_path: Path) -> Iterator[None]:
    """The project's folders first on the import path while its code runs, and read with ``_SourceLoader``.

    A path hook gives the project's folders, and its packages' folders, a finder that uses ``_SourceLoader``. Cached
    finders for them are dropped on the way in and out, so the hook is asked and the tools' own imports afterwards
    get the interpreter's usual finders again.
    """
    folders = project_import_paths(script_path)
    belongs = _in_project(folders)

    def project_finder(path: str) -> machinery.FileFinder:
        if not belongs(path):
            raise ImportError("not a project folder")  # the next path hook takes it
        return machinery.FileFinder(path, *_PROJECT_LOADERS)

    def forget_finders() -> None:
        for path in [path for path in sys.path_importer_cache if belongs(path)]:
            del sys.path_importer_cache[path]

    saved_path, saved_hooks = list(sys.path), list(sys.path_hooks)
    sys.path[:0] = [str(path) for path in folders]
    sys.path_hooks.insert(0, project_finder)
    forget_finders()
    try:
        yield
    finally:
        sys.path[:] = saved_path
        sys.path_hooks[:] = saved_hooks
        forget_finders()


def _forget_project_modules(script_path: Path) -> None:
    """Drop modules imported from the project's folders, so this load imports them from disk again."""
    belongs = _in_project(project_import_paths(script_path))
    for name, module in list(sys.modules.items()):
        if belongs(getattr(module, "__file__", None)):
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
    name = _module_name(resolved)
    module_spec = importlib.util.spec_from_file_location(name, resolved, loader=_SourceLoader(name, str(resolved)))
    module = importlib.util.module_from_spec(module_spec)
    _forget_project_modules(resolved)
    sys.modules[module_spec.name] = module  # registered like an import, so its dataclasses can find their module
    try:
        with _project_imports(resolved):
            module_spec.loader.exec_module(module)
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
