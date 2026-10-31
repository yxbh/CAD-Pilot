"""Soundness checks of a generated part's solids, for ``scripts/step``.

Cheap checks run in process on the generated shapes: faces that enclose no
volume, open shells and inside-out solids. The boolean kernel's argument check,
the one ``common.geometry.is_sound`` runs, can take minutes on a few shapes,
such as a swept coil whose turns overlap, so it runs in a worker process that
can be abandoned once a part uses up its time budget. The worker starts as soon
as the STEP is written, so it overlaps the mesh exports. It checks an exact
binary copy of the generated solids; when the kernel cannot finish on one, it
retries that solid as read back from the written STEP, where the kernel
completes some checks it abandons on freshly modelled shapes. Each unique solid
is checked once: placed copies of a solid share a check.

The budgets are wall-clock time. ``CAD_SOLID_CHECK_TIME_SCALE`` (a number of at
least 1) stretches the defaults where other work competes for the CPU, as in the
workbench's parallel test runs.
"""

from __future__ import annotations

import collections
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path


PART_BUDGET_SECONDS = 10.0
TOTAL_BUDGET_SECONDS = 30.0
TIME_SCALE_VARIABLE = "CAD_SOLID_CHECK_TIME_SCALE"
_MARK = "cad-solid-check "
_SCRIPTS_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class CheckedSolid:
    label: str
    verdict: str  # "sound", "unsound", "inconclusive" or "timeout"
    faults: tuple[str, ...] = ()
    detail: str = ""
    from_step: bool = False  # the verdict is about the solid read back from the written STEP


@dataclass
class KernelReport:
    solids: list[CheckedSolid] = field(default_factory=list)
    unchecked: int = 0
    failure: str | None = None


def part_label(name: str | None, source_ref: str, index: int = 1, count: int = 1) -> str:
    label = f'part "{name}" in {source_ref}' if name else source_ref
    return label if count == 1 else f"{label} (solid {index} of {count})"


def _shape_map(shape, kind) -> list:
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    shapes = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape, kind, shapes)
    return [shapes.FindKey(index) for index in range(1, shapes.Extent() + 1)]


def _prototype_solids(scene) -> list[tuple[str | None, list]]:
    """(name, solids) for each prototype, in the scene's order."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopoDS import TopoDS

    return [
        (scene.prototype_names.get(key) or None, [TopoDS.Solid(s) for s in _shape_map(shape, TopAbs_SOLID)])
        for key, shape in scene.prototype_shapes.items()
    ]


def _labelled_solids(prototypes: list[tuple[str | None, list]], source_ref: str) -> list[tuple[int, int, object, str]]:
    """(prototype index, solid index, solid, label) for each solid, without placed copies of one already listed."""
    from OCP.TopLoc import TopLoc_Location
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    seen = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    labelled = []
    for prototype_index, (name, solids) in enumerate(prototypes):
        kept = []
        for solid_index, solid in enumerate(solids):
            unlocated = solid.Located(TopLoc_Location())
            if not seen.Contains(unlocated):
                seen.Add(unlocated)
                kept.append((solid_index, solid))
        for number, (solid_index, solid) in enumerate(kept, start=1):
            labelled.append((prototype_index, solid_index, solid, part_label(name, source_ref, number, len(kept))))
    return labelled


def cheap_findings(scene, source_ref: str) -> list[str]:
    """Problems found without the boolean kernel, in plain language, one per affected part or solid."""
    from OCP.BRepCheck import BRepCheck_NoError, BRepCheck_Shell
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_FACE, TopAbs_IN, TopAbs_SHELL
    from OCP.TopoDS import TopoDS
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    prototypes = _prototype_solids(scene)
    findings = []
    for _prototype, _solid, solid, label in _labelled_solids(prototypes, source_ref):
        if any(BRepCheck_Shell(TopoDS.Shell(s)).Closed(False) != BRepCheck_NoError for s in _shape_map(solid, TopAbs_SHELL)):
            findings.append(f"{label} is not a closed solid: its shell has open edges")
        classifier = BRepClass3d_SolidClassifier(solid)
        classifier.PerformInfinitePoint(1e-7)
        if classifier.State() == TopAbs_IN:
            findings.append(f"{label} is inside out: its faces point inward, so its volume is negative")
    for (name, solids), shape in zip(prototypes, scene.prototype_shapes.values()):
        enclosed = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
        for solid in solids:
            for face in _shape_map(solid, TopAbs_FACE):
                enclosed.Add(face)
        loose = sum(1 for face in _shape_map(shape, TopAbs_FACE) if not enclosed.Contains(face))
        if loose:
            what = "face does" if loose == 1 else "faces do"
            findings.append(f"{part_label(name, source_ref)} is not a closed solid: {loose} {what} not enclose a volume")
    return findings


class KernelCheck:
    """The boolean kernel's check of a generated part's unique solids, in a worker, within time budgets."""

    def __init__(
        self,
        step_path: Path,
        scene,
        source_ref: str,
        *,
        part_budget: float | None = None,
        total_budget: float | None = None,
        command: list[str] | None = None,
    ) -> None:
        from OCP.BinTools import BinTools
        from OCP.BRep import BRep_Builder
        from OCP.TopoDS import TopoDS_Compound

        prototypes = _prototype_solids(scene)
        labelled = _labelled_solids(prototypes, source_ref)
        scale = max(1.0, float(os.environ.get(TIME_SCALE_VARIABLE) or 1))
        self.part_budget = PART_BUDGET_SECONDS * scale if part_budget is None else part_budget
        self.total_budget = TOTAL_BUDGET_SECONDS * scale if total_budget is None else total_budget
        self._command = command or [sys.executable, "-P", "-m", "common.solid_check"]
        self._process: subprocess.Popen | None = None
        self._brep_path: str | None = None
        self._started = time.monotonic()
        if not labelled:
            return
        builder = BRep_Builder()
        solids = TopoDS_Compound()
        builder.MakeCompound(solids)
        for _prototype, _solid, solid, _label in labelled:
            builder.Add(solids, solid)
        handle, self._brep_path = tempfile.mkstemp(prefix="cad-solid-check-", suffix=".brep")
        os.close(handle)
        if not BinTools.Write_s(solids, self._brep_path):
            self.cancel()
            raise RuntimeError("could not copy the solids for the worker")
        self._request = {
            "brep": self._brep_path,
            "step": str(step_path),
            "layout": [[name, len(solids)] for name, solids in prototypes],
            "targets": [[p, s, label] for p, s, _solid, label in labelled],
        }
        self._launch(start=0)

    def _launch(self, *, start: int) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(_SCRIPTS_DIR), env.get("PYTHONPATH")]))
        self._process = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        self._messages: queue.Queue = queue.Queue()
        self._stderr: collections.deque = collections.deque(maxlen=20)
        threading.Thread(target=self._read_stdout, args=(self._process, self._messages), daemon=True).start()
        self._stderr_reader = threading.Thread(target=self._read_stderr, args=(self._process, self._stderr), daemon=True)
        self._stderr_reader.start()
        try:
            self._process.stdin.write(json.dumps({**self._request, "start": start}))
            self._process.stdin.close()
        except OSError:
            pass  # the worker exited early; the report says so

    @staticmethod
    def _read_stdout(process: subprocess.Popen, messages: queue.Queue) -> None:
        for line in process.stdout:
            if line.startswith(_MARK):
                try:
                    messages.put((time.monotonic(), json.loads(line[len(_MARK):])))
                except ValueError:
                    pass  # a line the worker did not finish writing
        messages.put((time.monotonic(), None))

    @staticmethod
    def _read_stderr(process: subprocess.Popen, lines: collections.deque) -> None:
        for line in process.stderr:
            lines.append(line.rstrip())

    def _stop(self) -> None:
        if self._process is not None and self._process.poll() is None:
            self._process.kill()
            self._process.wait()

    def cancel(self) -> None:
        self._stop()
        if self._brep_path is not None:
            Path(self._brep_path).unlink(missing_ok=True)
            self._brep_path = None

    def report(self) -> KernelReport:
        """Waits for the worker within the budgets: one result per unique solid it finished or abandoned."""
        try:
            return self._collect()
        finally:
            self.cancel()

    def _collect(self) -> KernelReport:
        result = KernelReport()
        if self._process is None:
            return result
        total = len(self._request["targets"])
        total_deadline = self._started + self.total_budget
        current: tuple[int, str, float] | None = None  # index, label and start time of the solid being checked
        finished = 0
        while True:
            deadline = total_deadline if current is None else min(total_deadline, current[2] + self.part_budget)
            try:
                received, message = self._messages.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                self._stop()
                if current is not None and time.monotonic() >= current[2] + self.part_budget:
                    result.solids.append(CheckedSolid(current[1], "timeout"))
                    finished = current[0] + 1
                    current = None
                    if finished < total and time.monotonic() < total_deadline:
                        self._launch(start=finished)
                        continue
                result.unchecked = total - finished
                return result
            if message is None:
                self._process.wait()
                if finished < total:
                    # The worker's last words, such as "Segmentation fault", may still be on their way to the reader.
                    self._stderr_reader.join(timeout=5)
                    detail = self._stderr[-1] if self._stderr else f"exit code {self._process.returncode}"
                    result.failure = f"the check stopped unexpectedly ({detail})"
                    result.unchecked = total - finished
                return result
            if "start" in message:
                current = (message["start"], message["label"], received)
            elif "done" in message:
                result.solids.append(
                    CheckedSolid(
                        message["label"],
                        message["verdict"],
                        tuple(message["faults"]),
                        message["detail"],
                        message["from_step"],
                    )
                )
                finished = message["done"] + 1
                current = None


def _emit(message: dict) -> None:
    print(_MARK + json.dumps(message), flush=True)


def _worker_main() -> int:
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Iterator, TopoDS_Shape

    from common.geometry import GeometryError, _argument_faults

    request = json.load(sys.stdin)
    compound = TopoDS_Shape()
    BinTools.Read_s(compound, request["brep"])
    generated = []
    children = TopoDS_Iterator(compound)
    while children.More():
        generated.append(children.Value())
        children.Next()
    read_back: list | None = None

    def step_solid(prototype_index: int, solid_index: int):
        nonlocal read_back
        if read_back is None:
            from common.step_scene import load_step_scene

            prototypes = _prototype_solids(load_step_scene(Path(request["step"])))
            same_layout = [[name, len(solids)] for name, solids in prototypes] == request["layout"]
            read_back = prototypes if same_layout else []
        return read_back[prototype_index][1][solid_index] if read_back else None

    for index in range(request["start"], len(request["targets"])):
        prototype_index, solid_index, label = request["targets"][index]
        _emit({"start": index, "label": label})
        verdict, faults, detail, from_step = "sound", (), "", False
        try:
            faults = _argument_faults(generated[index])
        except GeometryError as exc:
            verdict, detail = "inconclusive", str(exc)
            solid = step_solid(prototype_index, solid_index)
            if solid is not None:
                _emit({"start": index, "label": label})  # a fresh budget for the retry
                try:
                    faults = _argument_faults(solid)
                    verdict, from_step = "sound", True
                except GeometryError as retry_exc:
                    detail = f"{detail}; read back from the STEP: {retry_exc}"
        if verdict == "sound" and faults:
            verdict = "unsound"
        _emit({"done": index, "label": label, "verdict": verdict, "faults": list(faults), "detail": detail, "from_step": from_step})
    return 0


if __name__ == "__main__":
    raise SystemExit(_worker_main())
