// Refreshes tests/durations.json, the per-platform test-file times scripts/test.mjs balances CI's shards by, from what
// CI's Explorer jobs recorded (their check logs keep a .durations.json per stage): those of the latest successful check
// run on main, or the mean over the runs given, since a file's time on one runner can be a third off its time on
// another. Needs the GitHub CLI, signed in.
import { execFileSync } from "node:child_process";
import { glob, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: node scripts/durations.mjs [<run id>...]";
const args = process.argv.slice(2);
if (!args.every((arg) => /^\d+$/.test(arg))) {
  console.error(USAGE);
  process.exit(2);
}
const explorerRoot = fileURLToPath(new URL("../", import.meta.url));
const table = path.join(explorerRoot, "tests", "durations.json");
const gh = (...ghArgs) => execFileSync("gh", ghArgs, { cwd: explorerRoot, encoding: "utf8" }).trim();
const runs = args.length ? args : [gh("run", "list", "--workflow", "check.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId")];
if (!runs[0]) throw new Error("No successful check run on main to read durations from.");

const folder = await mkdtemp(path.join(tmpdir(), "explorer-durations-"));
try {
  // Per platform and file, the seconds each run recorded.
  const recorded = {};
  for (const run of runs) {
    gh("run", "download", run, "--pattern", "check-logs-explorer-*", "--dir", path.join(folder, run));
    for await (const file of glob("**/*.durations.json", { cwd: path.join(folder, run) })) {
      const { platform, seconds } = JSON.parse(await readFile(path.join(folder, run, file), "utf8"));
      for (const [name, value] of Object.entries(seconds)) ((recorded[platform] ??= {})[name] ??= []).push(value);
    }
  }
  const named = `${runs.length === 1 ? "run" : "runs"} ${runs.join(", ")}`;
  if (!Object.keys(recorded).length) throw new Error(`The check logs of ${named} hold no Explorer test durations.`);
  const measured = Object.fromEntries(Object.entries(recorded).map(([platform, files]) => [
    platform, Object.fromEntries(Object.entries(files).map(([name, values]) => [name, values.reduce((sum, value) => sum + value, 0) / values.length])),
  ]));
  // A file the runs did not measure on a platform, such as one in a shard that stopped early, keeps its earlier time
  // there; a file that no longer exists is dropped.
  const previous = JSON.parse(await readFile(table, "utf8").catch(() => "{}"));
  const files = (await readdir(path.join(explorerRoot, "tests"))).filter((name) => /\.test\.(mjs|ts)$/.test(name)).sort();
  const durations = Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(measured)])].sort().map((platform) => [
    platform,
    Object.fromEntries(files.flatMap((file) => {
      const seconds = measured[platform]?.[file] ?? previous[platform]?.[file];
      return seconds === undefined ? [] : [[file, Math.round(seconds * 10) / 10]];
    })),
  ]));
  await writeFile(table, `${JSON.stringify(durations, null, 2)}\n`);
  const counts = Object.entries(measured).map(([platform, seconds]) => `${platform} ${files.filter((file) => file in seconds).length} of ${files.length} files`);
  console.log(`Wrote ${path.relative(process.cwd(), table)} from ${named}: ${counts.join(", ")}`);
} finally {
  await rm(folder, { recursive: true, force: true });
}
