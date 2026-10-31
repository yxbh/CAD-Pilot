// Splits the workbench's test files across CI's jobs (tools/check.mjs --share). A job runs three lanes side by side,
// each a check stage: its Python tests, its Explorer browser scenarios and its other Explorer tests, so it takes about as
// long as its slowest lane plus the build. Each file weighs what it added to its lane's time on that platform's runners
// (tests/durations.json and explorer/tests/durations.json, which tools/durations.mjs refreshes from CI); the files go
// longest first, each to a job where it leaves the slowest job quickest; among those to the one with the least in its
// own lane, so that each lane is spread evenly, and then the least in all, so that lanes' heaviest files part. A file
// not measured yet counts as the median of its lane.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBrowser, testFiles } from "../explorer/scripts/test-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");

// The files pytest collects: test_*.py and *_test.py under pyproject.toml's testpaths, not descending into the folders
// its default norecursedirs names. tests/test_shares.py checks this against pytest's own collection.
const NORECURSE = /^(\..*|.*\.egg|_darcs|build|CVS|dist|node_modules|venv|\{arch\})$/;
export function pythonTestFiles() {
  const testpaths = JSON.parse(/^testpaths\s*=\s*(\[.*\])\s*$/m.exec(read("pyproject.toml"))[1]);
  const files = [];
  const walk = (folder) => {
    for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
      const name = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!NORECURSE.test(entry.name)) walk(name);
      } else if (/^test_.*\.py$|_test\.py$/.test(entry.name)) files.push(name);
    }
  };
  testpaths.forEach(walk);
  return files.sort();
}

export const explorerTestFiles = testFiles;

const LANES = ["python", "core", "browser"];
const laneOf = (suite, file) => (suite === "python" ? "python" : isBrowser(file) ? "browser" : "core");

export function shares(count, { platform = process.platform, python = pythonTestFiles(), explorer = explorerTestFiles() } = {}) {
  const measured = {
    python: JSON.parse(read("tests/durations.json"))[platform] ?? {},
    explorer: JSON.parse(read("explorer/tests/durations.json"))[platform] ?? {},
  };
  const medians = {};
  for (const [suite, times] of Object.entries(measured)) {
    for (const [file, seconds] of Object.entries(times)) (medians[laneOf(suite, file)] ??= []).push(seconds);
  }
  for (const [lane, times] of Object.entries(medians)) medians[lane] = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const files = [...python.map((file) => ["python", file]), ...explorer.map((file) => ["explorer", file])]
    .map(([suite, file]) => ({ lane: laneOf(suite, file), file, seconds: measured[suite][file] ?? medians[laneOf(suite, file)] ?? 1 }))
    .sort((a, b) => b.seconds - a.seconds || a.lane.localeCompare(b.lane) || a.file.localeCompare(b.file));
  const jobs = Array.from({ length: count }, () => ({ ...Object.fromEntries(LANES.map((lane) => [lane, []])), load: Object.fromEntries(LANES.map((lane) => [lane, 0])) }));
  const slowestLane = (load) => Math.max(...Object.values(load));
  for (const { lane, file, seconds } of files) {
    const slowest = Math.max(...jobs.map((job) => slowestLane(job.load)));
    const after = (job) => ({ ...job.load, [lane]: job.load[lane] + seconds });
    const total = (load) => Object.values(load).reduce((sum, seconds) => sum + seconds, 0);
    const cost = (job) => [Math.max(slowest, slowestLane(after(job))), after(job)[lane], total(after(job))];
    const chosen = jobs.reduce((best, job) => {
      const [mine, theirs] = [cost(job), cost(best)];
      const first = mine.findIndex((value, index) => value !== theirs[index]);
      return first >= 0 && mine[first] < theirs[first] ? job : best;
    });
    chosen.load = after(chosen);
    chosen[lane].push(file);
  }
  for (const job of jobs) for (const lane of LANES) job[lane].sort();
  return jobs;
}
