"""Experiment only: where a scenario's wall time goes, by Playwright call and by scenario line."""
import collections
import linecache
import sys
import time
from pathlib import Path

TESTS = str(Path(__file__).resolve().parent)
SKIP = ("browser_session.py", "_timing.py", "browser_host.py", "browser_smoke.py")
current = None


def install():
    from playwright._impl import _sync_base
    original = _sync_base.SyncBase._sync

    def _sync(self, coro):
        start = time.perf_counter()
        try:
            return original(self, coro)
        finally:
            if current is not None:
                spent = time.perf_counter() - start
                name = getattr(coro, "cr_code", None)
                method = f"{type(self).__name__}.{name.co_name if name else '?'}"
                frame, where, outer = sys._getframe(1), None, None
                while frame:
                    file = frame.f_code.co_filename
                    if file.startswith(TESTS) and not file.endswith(SKIP):
                        line = f"{Path(file).name}:{frame.f_lineno} {linecache.getline(file, frame.f_lineno).strip()[:90]}"
                        where = where or line
                        if frame.f_code.co_name != "<module>":
                            outer = line
                    frame = frame.f_back
                for table, key in ((current["lines"], where), (current["outer"], outer), (current["methods"], method)):
                    entry = table[key]
                    entry[0] += 1
                    entry[1] += spent

    _sync_base.SyncBase._sync = _sync


def begin():
    global current
    current = {"start": time.perf_counter(), "lines": collections.defaultdict(lambda: [0, 0.0]),
               "outer": collections.defaultdict(lambda: [0, 0.0]), "methods": collections.defaultdict(lambda: [0, 0.0])}


def end(script, stream):
    global current
    data, current = current, None
    total = time.perf_counter() - data["start"]
    out = [f"[timing] {script}: {total:.2f} s"]
    if data["methods"]:
        out.append("[timing]   by method: " + ", ".join(f"{k} {v[1]:.1f}s/{v[0]}" for k, v in sorted(data["methods"].items(), key=lambda kv: -kv[1][1])[:12]))
        for title, table in (("innermost", data["lines"]), ("outermost", data["outer"])):
            out.append(f"[timing]   by {title} line:")
            for key, (count, spent) in sorted(table.items(), key=lambda kv: -kv[1][1])[:14]:
                out.append(f"[timing]     {spent:6.2f}s {count:4d}x  {key}")
    print("\n".join(out), file=stream)
