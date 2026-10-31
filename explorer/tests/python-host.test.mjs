import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPython } from "./python-host.mjs";

async function scripts(t, sources) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cad-explorer-host-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const paths = {};
  for (const [name, source] of Object.entries(sources)) {
    paths[name] = path.join(folder, `${name}.py`);
    await writeFile(paths[name], source);
  }
  return paths;
}

test("scripts run one after another in one Python process, as from a command line", { timeout: 60_000 }, async (t) => {
  const { report, fail, hang } = await scripts(t, {
    report: "import os, sys\nprint(os.getpid(), *sys.argv[1:])\nprint('note', file=sys.stderr)\n",
    fail: "import sys\nprint('half done')\nraise SystemExit('broken input')\n",
    hang: "import time\ntime.sleep(60)\n",
  });
  const first = await runPython(report, ["--output", "a b"]);
  const [pid, ...args] = first.stdout.trim().split(" ");
  assert.deepEqual(args, ["--output", "a", "b"]);
  assert.equal(first.stderr, "note\n");
  assert.equal((await runPython(report)).stdout.trim(), pid, "the second script reuses the process");

  await assert.rejects(runPython(fail), (error) => error.code === 1 && error.stdout === "half done\n" && /broken input/.test(error.stderr));
  await assert.rejects(runPython(hang, [], { timeout: 1_000 }), /did not finish within 1 s/);
  assert.notEqual((await runPython(report)).stdout.trim(), pid, "a host that timed out is replaced");
});
