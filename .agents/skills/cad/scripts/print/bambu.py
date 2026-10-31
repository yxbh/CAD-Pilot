"""Bambu Studio: where it is installed, its system presets, and its command line."""

from __future__ import annotations

import difflib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


VENDOR = "BBL"
PRESET_KINDS = {"machine": "machine_list", "process": "process_list", "filament": "filament_list"}
# A preset's own bookkeeping, which presets it includes do not pass on.
OWN_KEYS = {"name", "type", "from", "instantiation", "inherits", "setting_id"}
# Bambu Studio's build plates and the filament setting that holds each one's bed temperature.
# A filament whose temperature for a plate is 0 cannot be printed on it.
BED_TEMPERATURE_KEYS = {
    "Cool Plate": "cool_plate_temp",
    "Engineering Plate": "eng_plate_temp",
    "High Temp Plate": "hot_plate_temp",
    "Textured PEI Plate": "textured_plate_temp",
    "Supertack Plate": "supertack_plate_temp",
}


# macOS writes one report per crash here; Bambu Studio's command line segfaults on many inputs its
# window would never produce, so the crashing function is the best clue to which.
CRASH_REPORTS = Path.home() / "Library" / "Logs" / "DiagnosticReports"


class BambuStudioError(RuntimeError):
    pass


@dataclass(frozen=True)
class CliRun:
    returncode: int
    output: str
    pid: int

    @property
    def crashed(self) -> bool:
        return self.returncode < 0

    def failure(self) -> str:
        """Why the run failed: the function it crashed in, or the last error it logged."""
        if self.crashed:
            frame = crash_frame(self.pid)
            return f"Bambu Studio crashed (signal {-self.returncode})" + (f" in {frame}" if frame else "")
        return last_error(self.output) or f"Bambu Studio exited with code {self.returncode}"


def last_error(output: str) -> str:
    lines = [line for line in output.splitlines() if "[error]" in line and "Invalid T command" not in line]
    return lines[-1].split("[error]", 1)[1].strip() if lines else ""


def crash_frame(pid: int, *, wait: float = 5.0) -> str | None:
    """The function a crashed process stopped in, from its macOS crash report (written within seconds)."""
    if sys.platform != "darwin":
        return None
    deadline = time.monotonic() + wait
    while True:
        reports = sorted(CRASH_REPORTS.glob("BambuStudio-*.ips"), key=lambda path: path.stat().st_mtime, reverse=True)
        for report in reports[:5]:
            try:
                body = json.loads(report.read_text(encoding="utf-8").partition("\n")[2])
                if body.get("pid") != pid:
                    continue
                frames = body["threads"][body.get("faultingThread", 0)]["frames"]
            except (OSError, ValueError, KeyError, IndexError, TypeError):
                continue
            symbol = next((frame["symbol"] for frame in frames if frame.get("symbol")), None)
            return symbol.split("(", 1)[0] if symbol else None
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def _candidates(configured: str | None) -> list[Path]:
    if configured:
        return [Path(configured).expanduser()]
    if env := os.environ.get("BAMBU_STUDIO"):
        return [Path(env).expanduser()]
    if sys.platform == "darwin":
        return [Path("/Applications/BambuStudio.app"), Path.home() / "Applications/BambuStudio.app"]
    if sys.platform == "win32":
        roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")]
        return [Path(root) / "Bambu Studio" / "bambu-studio.exe" for root in roots if root]
    found = shutil.which("bambu-studio")
    return [Path(found)] if found else []


def _executable(path: Path) -> Path:
    if path.suffix == ".app":
        return path / "Contents" / "MacOS" / "BambuStudio"
    if path.is_dir():
        for name in ("bambu-studio.exe", "bambu-studio", "BambuStudio"):
            if (path / name).is_file():
                return path / name
    return path


def _profiles(executable: Path) -> Path | None:
    for resources in (executable.parents[1] / "Resources", executable.parent / "resources"):
        if (resources / "profiles" / f"{VENDOR}.json").is_file():
            return resources / "profiles" / VENDOR
    return None


@dataclass(frozen=True)
class Presets:
    """The system presets an installation ships, by kind and name, as its index lists them."""

    root: Path
    paths: dict[str, dict[str, str]]

    @classmethod
    def load(cls, root: Path) -> "Presets":
        index = json.loads((root.parent / f"{root.name}.json").read_text(encoding="utf-8"))
        paths = {kind: {entry["name"]: entry["sub_path"] for entry in index.get(key, [])} for kind, key in PRESET_KINDS.items()}
        return cls(root, paths)

    def names(self, kind: str) -> list[str]:
        return sorted(self.paths[kind])

    def require(self, kind: str, name: str) -> None:
        if name not in self.paths[kind]:
            close = difflib.get_close_matches(name, self.paths[kind], n=3, cutoff=0.6)
            hint = f"; did you mean {' or '.join(repr(c) for c in close)}?" if close else ""
            raise BambuStudioError(f"Bambu Studio has no {kind} preset {name!r}{hint} (list them with: presets)")

    def flat(self, kind: str, name: str, _seen: tuple[str, ...] = ()) -> dict:
        """A preset as Bambu Studio reads it: its parents, then the presets it includes (Bambu's
        printers take their start, end and filament-change G-code from those), then its own keys."""
        self.require(kind, name)
        if name in _seen:
            raise BambuStudioError(f"Bambu {kind} preset {name!r} inherits from itself")
        source = json.loads((self.root / self.paths[kind][name]).read_text(encoding="utf-8"))
        seen = (*_seen, name)
        result = self.flat(kind, source["inherits"], seen) if source.get("inherits") else {}
        for included in source.get("include") or []:
            result.update({key: value for key, value in self.flat(kind, included, seen).items() if key not in OWN_KEYS})
        result.update({key: value for key, value in source.items() if key != "include"})
        return result

    def preset_file(self, kind: str, name: str) -> dict:
        """A flattened system preset in the form --load-settings and --load-filaments take."""
        flat = {key: value for key, value in self.flat(kind, name).items() if key != "inherits"}
        return {**flat, "name": name, "from": "system", "instantiation": "true"}


@dataclass(frozen=True)
class BambuStudio:
    executable: Path
    app: Path
    profiles: Path

    @classmethod
    def locate(cls, configured: str | None = None) -> "BambuStudio":
        candidates = _candidates(configured)
        for candidate in candidates:
            executable = _executable(candidate)
            profiles = _profiles(executable) if executable.is_file() else None
            if profiles is not None:
                return cls(executable, candidate, profiles)
        tried = ", ".join(str(path) for path in candidates) or "nothing on PATH"
        raise BambuStudioError(
            f"Bambu Studio not found (tried {tried}). Install it, or set bambu_studio in the print profile "
            "or the BAMBU_STUDIO environment variable to the app or its executable."
        )

    def presets(self) -> Presets:
        return Presets.load(self.profiles)

    def run(self, arguments: list[str], work: Path, *, timeout: float = 1800) -> CliRun:
        """Run the command line with its own data folder, so the app's settings stay untouched.
        Output paths are absolute: it resolves relative ones from somewhere other than its cwd."""
        command = [str(self.executable), "--datadir", str(work / "data"), "--debug", "2", *arguments]
        with subprocess.Popen(
            command, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace"
        ) as process:
            try:
                output, _ = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise BambuStudioError(f"Bambu Studio did not finish within {timeout:g} s") from None
        return CliRun(process.returncode, output, process.pid)

    def resolved_settings(self, printer: str, process: str, filaments: list[str]) -> dict:
        """The full project settings for these system presets, merged by Bambu Studio itself:
        it expands each filament's per-nozzle values, which a plain merge would get wrong."""
        presets = self.presets()
        with tempfile.TemporaryDirectory(prefix="cad-print-") as temp:
            work = Path(temp)
            files: list[str] = []
            for index, (kind, name) in enumerate(
                [("machine", printer), ("process", process), *(("filament", name) for name in filaments)]
            ):
                path = work / f"{index}-{kind}.json"
                path.write_text(json.dumps(presets.preset_file(kind, name)), encoding="utf-8")
                files.append(str(path))
            exported = work / "settings.json"
            result = self.run(
                ["--load-settings", ";".join(files[:2]), "--load-filaments", ";".join(files[2:]), "--export-settings", str(exported)],
                work,
                timeout=120,
            )
            if result.returncode != 0 or not exported.is_file():
                raise BambuStudioError(f"Bambu Studio could not resolve the presets: {result.failure()}")
            return json.loads(exported.read_text(encoding="utf-8"))

    def open(self, path: Path) -> None:
        """Open a project in the Bambu Studio app, reusing its window when it is already running."""
        if sys.platform == "darwin" and self.app.suffix == ".app":
            subprocess.run(["open", "-a", str(self.app), str(path)], check=True)
        else:
            subprocess.Popen([str(self.executable), str(path)], start_new_session=True)

