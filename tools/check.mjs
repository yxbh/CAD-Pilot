// Runs every workbench check. Stages start as soon as the stages they need have passed, so independent suites run
// at the same time; each stage's output is printed in one piece when it ends, then a summary.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;
// The Python environment is synced once (inexactly, like `uv run`) before the suites that use it start together;
// the Explorer is built once before its two suites, which then must not rebuild into the same folder.
const STAGES = [
  { name: "python env", command: "uv", args: ["sync", "--inexact"] },
  { name: "explorer build", command: node, args: ["explorer/scripts/build.mjs"] },
  { name: "python", command: "uv", args: ["run", "--no-sync", "pytest", "-q"], needs: ["python env"] },
  { name: "explorer core", command: node, args: ["explorer/scripts/test.mjs", "core", "--no-build"], needs: ["python env", "explorer build"] },
  { name: "explorer browser", command: node, args: ["explorer/scripts/test.mjs", "browser", "--no-build"], needs: ["python env", "explorer build"] },
];
const MARK = { passed: "✔", failed: "✖", skipped: "–" };
const github = Boolean(process.env.GITHUB_ACTIONS);
const seconds = (start) => `${((performance.now() - start) / 1000).toFixed(1)} s`;
const running = new Map();

function report(name, heading, output, passed) {
  // Passing output folds away in the Actions log; failures stay open and are annotated.
  console.log(github && passed ? `::group::${heading}` : `── ${heading} ──`);
  const text = Buffer.concat(output).toString();
  process.stdout.write(text.endsWith("\n") || !text ? text : `${text}\n`);
  if (github) console.log(passed ? "::endgroup::" : `::error::${name} failed`);
}

function run({ name, command, args }) {
  const start = performance.now();
  console.log(`▶ ${name}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    running.set(name, { child, output });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    const finish = (passed, error) => {
      if (!running.delete(name)) return;
      if (error) output.push(Buffer.from(`${error.message}\n`));
      const status = passed ? "passed" : "failed";
      report(name, `${MARK[status]} ${name} ${status} in ${seconds(start)}`, output, passed);
      resolve({ name, status, detail: `${status} in ${seconds(start)}` });
    };
    child.once("error", (error) => finish(false, error));
    child.once("close", (code) => finish(code === 0));
  });
}

// A cancelled run (Ctrl+C, or a CI timeout) still shows what each unfinished stage had printed.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const [name, { child, output }] of running) {
      child.kill();
      report(name, `✖ ${name} interrupted`, output, false);
    }
    process.exit(130);
  });
}

const start = performance.now();
const results = new Map();
for (const stage of STAGES) {
  const needs = stage.needs ?? [];
  results.set(stage.name, Promise.all(needs.map((need) => results.get(need))).then((done) => {
    const failed = done.filter((result) => result.status !== "passed").map((result) => result.name);
    return failed.length ? { name: stage.name, status: "skipped", detail: `skipped: needs ${failed.join(", ")}` } : run(stage);
  }));
}
const summary = await Promise.all(results.values());
console.log("\nSummary");
for (const { name, status, detail } of summary) console.log(`  ${MARK[status]} ${name.padEnd(18)} ${detail}`);
console.log(`Total ${seconds(start)}`);
process.exitCode = summary.every((result) => result.status === "passed") ? 0 : 1;
