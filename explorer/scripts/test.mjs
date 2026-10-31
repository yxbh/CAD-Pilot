import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { buildExplorer } from "./incremental-build.mjs";

const USAGE = "Usage: node scripts/test.mjs core|browser|shard <i>/<n> [--no-build] [--list]";
// Seconds each unit took on CI runners, running alone (the slowest of the macOS, Linux and Windows runners, since the
// slowest sets a run's time), used to give shards similar work. The core suite is one unit and each browser file
// another; a unit not listed counts as the median. Refresh from a run's per-test times when a file's time changes a lot.
const SECONDS = {
  "edge-browser.test.mjs": 76,
  "camera-browser.test.mjs": 75,
  "review-recovery-browser.test.mjs": 59,
  "explode-camera-browser.test.mjs": 55,
  core: 52,
  "import-warnings-browser.test.mjs": 36,
  "studio-views-browser.test.mjs": 33,
  "assembly-browser.test.mjs": 30,
  "cleanup-persistence-browser.test.mjs": 23,
  "section-browser.test.mjs": 19,
  "viewer-browser.test.mjs": 16,
  "render-reports-browser.test.mjs": 15,
};

const args = process.argv.slice(2);
const [mode, part] = args.filter((arg) => !arg.startsWith("--"));
const shard = mode === "shard" && /^(\d+)\/(\d+)$/.exec(part ?? "");
if (!(["core", "browser"].includes(mode) || (shard && +shard[1] >= 1 && +shard[1] <= +shard[2]))) {
  console.error(USAGE);
  process.exit(2);
}
const cwd = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(new URL("../tests/", import.meta.url))).filter((name) => /\.test\.(mjs|ts)$/.test(name)).sort();
const browserFiles = tests.filter((name) => name.endsWith("-browser.test.mjs"));
const coreFiles = tests.filter((name) => !name.endsWith("-browser.test.mjs"));

// Longest first, each to the shard with the least work so far.
function shardUnits(index, count) {
  const known = Object.values(SECONDS).sort((a, b) => a - b);
  const seconds = (unit) => SECONDS[unit] ?? known[Math.floor(known.length / 2)];
  const shards = Array.from({ length: count }, () => ({ seconds: 0, units: [] }));
  for (const unit of ["core", ...browserFiles].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, candidate) => (candidate.seconds < best.seconds ? candidate : best));
    lightest.seconds += seconds(unit);
    lightest.units.push(unit);
  }
  return shards[index - 1];
}

const selected = shard ? shardUnits(+shard[1], +shard[2]) : null;
const units = selected ? selected.units : mode === "core" ? ["core"] : browserFiles;
if (selected) console.log(`Shard ${part}: ${units.join(", ") || "nothing"} (about ${selected.seconds} s on a CI runner)`);
if (args.includes("--list")) {
  console.log(JSON.stringify(units.flatMap((unit) => (unit === "core" ? coreFiles : [unit]))));
  process.exit(0);
}
// Browser suites and the launcher's background viewers serve the built page. tools/check.mjs builds once before
// running suites at the same time, so they must not rebuild into the same folder.
if (!args.includes("--no-build")) await buildExplorer();

// A test that sets no timeout of its own fails after two minutes, so a hang names itself instead of holding a CI job
// until the job's own limit.
function run(files, concurrency) {
  if (!files.length) return 0;
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=120000", ...concurrency, ...files.map((name) => `tests/${name}`)], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
// Each browser scenario drives its own Chromium with software WebGL, plus Python fixtures, so only a few run at once:
// a quarter of the cores, at most three. A 3- or 4-core CI runner runs them one at a time, which its shard allows for.
// Core files use Node's default concurrency.
const browserConcurrency = `--test-concurrency=${Math.max(1, Math.min(3, Math.floor(availableParallelism() / 4)))}`;
const statuses = [
  units.includes("core") ? run(coreFiles, []) : 0,
  run(units.filter((unit) => unit !== "core"), [browserConcurrency]),
];
process.exitCode = statuses.find((status) => status !== 0) ?? 0;
