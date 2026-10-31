// Splits the workbench's test files across CI's jobs (tools/check.mjs --share): each job gets Python and Explorer test
// files that together take about as long as any other job's. A file weighs what it added to its job's time on that
// platform's runners (tests/durations.json and explorer/tests/durations.json, which tools/durations.mjs refreshes from
// CI); the files go longest first, each to the job with the least time so far. A file not measured yet counts as the
// median of its kind: Python, Explorer browser scenario or other Explorer test.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// The Explorer's test files, named as explorer/scripts/test.mjs takes them.
export const explorerTestFiles = () => readdirSync(path.join(root, "explorer", "tests")).filter((name) => /\.test\.(mjs|ts)$/.test(name)).sort();

export function shares(count, { platform = process.platform, python = pythonTestFiles(), explorer = explorerTestFiles() } = {}) {
  const measured = {
    python: JSON.parse(read("tests/durations.json"))[platform] ?? {},
    explorer: JSON.parse(read("explorer/tests/durations.json"))[platform] ?? {},
  };
  const kind = (suite, file) => (suite === "explorer" && file.endsWith("-browser.test.mjs") ? "browser" : suite);
  const medians = {};
  for (const [suite, times] of Object.entries(measured)) {
    for (const [file, seconds] of Object.entries(times)) (medians[kind(suite, file)] ??= []).push(seconds);
  }
  for (const [name, times] of Object.entries(medians)) medians[name] = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const files = [...python.map((file) => ["python", file]), ...explorer.map((file) => ["explorer", file])]
    .map(([suite, file]) => ({ suite, file, seconds: measured[suite][file] ?? medians[kind(suite, file)] ?? 1 }))
    .sort((a, b) => b.seconds - a.seconds || a.suite.localeCompare(b.suite) || a.file.localeCompare(b.file));
  const jobs = Array.from({ length: count }, () => ({ seconds: 0, python: [], explorer: [] }));
  for (const { suite, file, seconds } of files) {
    const lightest = jobs.reduce((best, job) => (job.seconds < best.seconds ? job : best));
    lightest.seconds += seconds;
    lightest[suite].push(file);
  }
  for (const job of jobs) job.python.sort(), job.explorer.sort();
  return jobs;
}
