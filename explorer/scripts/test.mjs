import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildExplorer } from "./incremental-build.mjs";

const USAGE = "Usage: node scripts/test.mjs core|browser|shard <i>/<n> [--no-build] [--list] [--durations <file>]";
let options;
try {
  options = parseArgs({ allowPositionals: true, options: { "no-build": { type: "boolean" }, list: { type: "boolean" }, durations: { type: "string" } } });
} catch {
  options = null;
}
const [mode, part] = options?.positionals ?? [];
const shard = mode === "shard" && /^(\d+)\/(\d+)$/.exec(part ?? "");
const count = options?.positionals.length;
if (!((["core", "browser"].includes(mode) && count === 1) || (shard && +shard[1] >= 1 && +shard[1] <= +shard[2] && count === 2))) {
  console.error(USAGE);
  process.exit(2);
}
const cwd = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(new URL("../tests/", import.meta.url))).filter((name) => /\.test\.(mjs|ts)$/.test(name)).sort();
const isBrowser = (file) => file.endsWith("-browser.test.mjs");

// What each test file adds to its shard's time on this platform's CI runners (tests/durations.json, which the
// workbench's tools/durations.mjs refreshes from CI runs). Shards take the files longest first, each to the shard with
// the least time so far; a file not listed counts as the median of its kind, browser or core.
const measured = JSON.parse(await readFile(new URL("../tests/durations.json", import.meta.url), "utf8"))[process.platform] ?? {};
const median = (browser) => {
  const kind = Object.entries(measured).filter(([name]) => isBrowser(name) === browser).map(([, seconds]) => seconds).sort((a, b) => a - b);
  return kind[Math.floor(kind.length / 2)] ?? 1;
};
const medians = { true: median(true), false: median(false) };
const estimate = (file) => measured[file] ?? medians[isBrowser(file)];
function shardFiles(index, count) {
  const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
  for (const file of [...tests].sort((a, b) => estimate(b) - estimate(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, candidate) => (candidate.seconds < best.seconds ? candidate : best));
    lightest.seconds += estimate(file);
    lightest.files.push(file);
  }
  return shards[index - 1];
}

const selected = shard ? shardFiles(+shard[1], +shard[2]) : null;
const files = selected ? selected.files : tests.filter((file) => isBrowser(file) === (mode === "browser"));
if (selected) console.log(`Shard ${part}: ${selected.files.join(", ") || "nothing"} (about ${Math.round(selected.seconds)} s on a CI runner)`);
if (options.values.list) {
  console.log(JSON.stringify(files));
  process.exit(0);
}
// Browser suites and the launcher's background viewers serve the built page. tools/check.mjs builds once before
// running suites at the same time, so they must not rebuild into the same folder.
if (!options.values["no-build"]) await buildExplorer();

// With --durations, each run also reports its files' times (scripts/durations-reporter.mjs), and each file is recorded
// at what it adds to its shard's time: its tests' time over the number of files run at once, plus an equal share of
// the rest of the run's wall-clock time (starting the files' processes, imports and fixtures), which tests do not see.
const reports = options.values.durations ? await mkdtemp(path.join(tmpdir(), "explorer-durations-")) : null;
const timed = {};
// A test that sets no timeout of its own fails after two minutes, so a hang names itself instead of holding a CI job
// until the job's own limit.
function run(name, files, filesAtOnce, concurrency) {
  if (!files.length) return 0;
  const reporters = reports ? [
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=./scripts/durations-reporter.mjs", `--test-reporter-destination=${path.join(reports, `${name}.json`)}`,
  ] : [];
  const start = performance.now();
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=120000", ...reporters, ...concurrency, ...files.map((file) => `tests/${file}`)], { cwd, stdio: "inherit" });
  timed[name] = { wall: (performance.now() - start) / 1000, filesAtOnce };
  if (result.error) throw result.error;
  return result.status ?? 1;
}
// Browser scenarios render WebGL, in software where there is no GPU, and build Python fixtures, so only a few files
// run at once: a quarter of the cores, at most three. Each test process starts one Python host and Chromium for its
// scenarios (tests/python-host.mjs). A 3- or 4-core CI runner runs the files one at a time, all in one process, so its
// whole shard shares a single host. Core files run as many at once as Node runs by default, one fewer than the cores.
const coreFilesAtOnce = Math.max(1, availableParallelism() - 1);
const browserFilesAtOnce = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 4)));
const browserOptions = browserFilesAtOnce === 1 ? ["--test-isolation=none"] : [`--test-concurrency=${browserFilesAtOnce}`];
const statuses = [
  run("core", files.filter((file) => !isBrowser(file)), coreFilesAtOnce, [`--test-concurrency=${coreFilesAtOnce}`]),
  run("browser", files.filter(isBrowser), browserFilesAtOnce, browserOptions),
];
if (reports) {
  const seconds = {};
  for (const [name, { wall, filesAtOnce }] of Object.entries(timed)) {
    let report;
    try {
      report = JSON.parse(await readFile(path.join(reports, `${name}.json`), "utf8"));
    } catch {
      continue; // A run that was stopped may have left no report, or part of one; its exit status fails the check.
    }
    const entries = Object.entries(report.seconds);
    const rest = Math.max(0, wall - entries.reduce((sum, [, value]) => sum + value, 0) / filesAtOnce);
    for (const [file, value] of entries) seconds[file] = value / filesAtOnce + rest / entries.length;
  }
  await mkdir(path.dirname(options.values.durations), { recursive: true });
  await writeFile(options.values.durations, `${JSON.stringify({ platform: process.platform, seconds })}\n`);
  await rm(reports, { recursive: true, force: true });
}
process.exitCode = statuses.find((status) => status !== 0) ?? 0;
