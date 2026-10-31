// Refreshes the per-platform test-file times CI's jobs are split by: explorer/tests/durations.json, which
// explorer/scripts/test.mjs shares the Explorer's test files by, and tests/durations.json, which conftest.py shares the
// Python test files by. They come from what CI's jobs recorded (their check logs keep a .durations.json per test
// stage): those of the latest successful check run on main, or the mean over the runs given, since a file's time on one
// runner can be a third off its time on another. Needs the GitHub CLI, signed in.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: node tools/durations.mjs [<run id>...]";
const args = process.argv.slice(2);
if (!args.every((arg) => /^\d+$/.test(arg))) {
  console.error(USAGE);
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
// The check runner names each test stage's record after its suite (tools/check.mjs), and each suite names its files as
// its runner does: the Explorer's by name in explorer/tests, Python's by path from the workbench root.
const SUITES = {
  explorer: { table: path.join(root, "explorer", "tests", "durations.json"), folder: path.join(root, "explorer", "tests") },
  python: { table: path.join(root, "tests", "durations.json"), folder: root },
};
const gh = (...ghArgs) => execFileSync("gh", ghArgs, { cwd: root, encoding: "utf8" }).trim();
const runs = args.length ? args : [gh("run", "list", "--workflow", "check.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId")];
if (!runs[0]) throw new Error("No successful check run on main to read durations from.");
const named = `${runs.length === 1 ? "run" : "runs"} ${runs.join(", ")}`;

const folder = await mkdtemp(path.join(tmpdir(), "check-durations-"));
try {
  for (const run of runs) gh("run", "download", run, "--pattern", "check-logs-*", "--dir", path.join(folder, run));
  // Every suite's records are read before either table is written, so both tables always come from the same runs.
  const tables = [];
  for (const [suite, { table, folder: files }] of Object.entries(SUITES)) {
    // Per platform and file, the seconds each run recorded.
    const recorded = {};
    for (const run of runs) {
      for await (const file of glob(`check-logs-*/${suite}-*.durations.json`, { cwd: path.join(folder, run) })) {
        const { platform, seconds } = JSON.parse(await readFile(path.join(folder, run, file), "utf8"));
        for (const [name, value] of Object.entries(seconds)) ((recorded[platform] ??= {})[name] ??= []).push(value);
      }
    }
    if (!Object.keys(recorded).length) throw new Error(`The check logs of ${named} hold no ${suite} test durations.`);
    const measured = Object.fromEntries(Object.entries(recorded).map(([platform, times]) => [
      platform, Object.fromEntries(Object.entries(times).map(([name, values]) => [name, values.reduce((sum, value) => sum + value, 0) / values.length])),
    ]));
    // A file the runs did not measure on a platform, such as one in a job that stopped early, keeps its earlier time
    // there; a file that no longer exists is dropped.
    const previous = JSON.parse(await readFile(table, "utf8").catch(() => "{}"));
    const durations = Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(measured)])].sort().map((platform) => {
      const names = [...new Set([...Object.keys(previous[platform] ?? {}), ...Object.keys(measured[platform] ?? {})])].sort();
      return [platform, Object.fromEntries(names.flatMap((name) => {
        const seconds = measured[platform]?.[name] ?? previous[platform]?.[name];
        return existsSync(path.join(files, name)) ? [[name, Math.round(seconds * 10) / 10]] : [];
      }))];
    }));
    const counts = Object.entries(measured).map(([platform, seconds]) => `${platform} ${Object.keys(seconds).length} files`);
    tables.push({ table, durations, counts });
  }
  for (const { table, durations, counts } of tables) {
    await writeFile(table, `${JSON.stringify(durations, null, 2)}\n`);
    console.log(`Wrote ${path.relative(process.cwd(), table)} from ${named}: ${counts.join(", ")}`);
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}
