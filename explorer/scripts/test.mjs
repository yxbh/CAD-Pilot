import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// How long each test file's tests took on this platform's CI runners (tests/durations.json, which scripts/durations.mjs
// refreshes from a CI run). Shards take the files longest first, each to the shard with the least time so far; a file
// not listed counts as the median of its kind, browser or core.
const measured = JSON.parse(await readFile(new URL("../tests/durations.json", import.meta.url), "utf8"))[process.platform] ?? {};
function estimate(file) {
  const kind = Object.entries(measured).filter(([name]) => isBrowser(name) === isBrowser(file)).map(([, seconds]) => seconds).sort((a, b) => a - b);
  return measured[file] ?? kind[Math.floor(kind.length / 2)] ?? 1;
}
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

// With --durations, each run also reports its files' times (scripts/durations-reporter.mjs) and the file gets them all.
const reports = options.values.durations ? await mkdtemp(path.join(tmpdir(), "explorer-durations-")) : null;
// A test that sets no timeout of its own fails after two minutes, so a hang names itself instead of holding a CI job
// until the job's own limit.
function run(name, files, concurrency) {
  if (!files.length) return 0;
  const reporters = reports ? [
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=./scripts/durations-reporter.mjs", `--test-reporter-destination=${path.join(reports, `${name}.json`)}`,
  ] : [];
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=120000", ...reporters, ...concurrency, ...files.map((file) => `tests/${file}`)], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
// Browser scenarios render with software WebGL and build Python fixtures, so only a few files run at once: a quarter
// of the cores, at most three. Each test process starts one Python host and Chromium for its scenarios
// (tests/python-host.mjs). A 3- or 4-core CI runner runs the files one at a time, all in one process, so its whole
// shard shares a single host. Core files use Node's default concurrency.
const browserFilesAtOnce = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 4)));
const browserOptions = browserFilesAtOnce === 1 ? ["--test-isolation=none"] : [`--test-concurrency=${browserFilesAtOnce}`];
const statuses = [
  run("core", files.filter((file) => !isBrowser(file)), []),
  run("browser", files.filter(isBrowser), browserOptions),
];
if (reports) {
  const seconds = {};
  // A run that was stopped may have left no report, or part of one; its exit status already fails the check.
  for (const name of await readdir(reports)) {
    try {
      Object.assign(seconds, JSON.parse(await readFile(path.join(reports, name), "utf8")).seconds);
    } catch {}
  }
  await writeFile(options.values.durations, `${JSON.stringify({ platform: process.platform, seconds })}\n`);
  await rm(reports, { recursive: true, force: true });
}
process.exitCode = statuses.find((status) => status !== 0) ?? 0;
