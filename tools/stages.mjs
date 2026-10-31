// Runs check stages. A stage starts as soon as the stages it needs have passed, so independent stages run at the
// same time. Each stage's output is written live to <logs>/<stage>.log and printed in one piece when the stage ends,
// then a summary. SIGINT, SIGTERM or SIGHUP (a closed terminal) stops every running stage's whole process tree, prints
// what each had written and exits 130, 143 or 129. Stages run in their own process groups, so a SIGKILL of the runner
// alone, which nothing can catch, leaves them running.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const MARK = { passed: "✔", failed: "✖", interrupted: "✖", skipped: "–" };
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
const seconds = (start) => `${((performance.now() - start) / 1000).toFixed(1)} s`;

function stop(child, signal) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  else {
    try { process.kill(-child.pid, signal); } catch {} // The group may already have exited.
  }
}

export async function runStages(stages, { cwd, logs, github = Boolean(process.env.GITHUB_ACTIONS) }) {
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const running = new Set();
  let interrupted = null;

  function report(name, heading, output, passed) {
    // Passing output folds away in the Actions log; anything else stays open and is annotated.
    console.log(github && passed ? `::group::${heading}` : `── ${heading} ──`);
    const text = Buffer.concat(output).toString();
    process.stdout.write(text.endsWith("\n") || !text ? text : `${text}\n`);
    if (github) console.log(passed ? "::endgroup::" : `::error::${heading}`);
  }

  function run({ name, command, args }) {
    const start = performance.now();
    console.log(`▶ ${name}`);
    const log = createWriteStream(path.join(logs, `${name.replace(/[^\w.]+/g, "-")}.log`));
    return new Promise((resolve) => {
      // Its own process group (POSIX), so stopping the stage reaches everything it started. Output is read as UTF-8,
      // so Python is told to write it whatever the Windows code page.
      const child = spawn(command, args, {
        cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      const output = [];
      const collect = (chunk) => { output.push(chunk); log.write(chunk); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      running.add(child);
      let finished = false;
      const finish = (passed, error) => {
        if (finished) return;
        finished = true;
        running.delete(child);
        if (error) collect(Buffer.from(`${error.message}\n`));
        log.end();
        const status = interrupted ? "interrupted" : passed ? "passed" : "failed";
        report(name, `${MARK[status]} ${name} ${status} after ${seconds(start)}`, output, status === "passed");
        resolve({ name, status, detail: `${status} after ${seconds(start)}` });
      };
      child.once("error", (error) => finish(false, error));
      child.once("close", (code) => finish(code === 0));
    });
  }

  const handlers = Object.keys(SIGNAL_EXIT).map((signal) => {
    const handler = () => {
      interrupted = signal;
      for (const child of running) stop(child, "SIGTERM");
      setTimeout(() => { for (const child of running) stop(child, "SIGKILL"); }, 5000).unref();
    };
    process.once(signal, handler);
    return [signal, handler];
  });

  const start = performance.now();
  const results = new Map();
  for (const stage of stages) {
    results.set(stage.name, Promise.all((stage.needs ?? []).map((need) => results.get(need))).then((done) => {
      const blocked = done.filter((result) => result.status !== "passed").map((result) => result.name);
      if (blocked.length) return { name: stage.name, status: "skipped", detail: `skipped: needs ${blocked.join(", ")}` };
      if (interrupted) return { name: stage.name, status: "skipped", detail: "skipped: interrupted" };
      return run(stage);
    }));
  }
  const summary = await Promise.all(results.values());
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  console.log("\nSummary");
  const width = Math.max(18, ...summary.map(({ name }) => name.length));
  for (const { name, status, detail } of summary) console.log(`  ${MARK[status]} ${name.padEnd(width)} ${detail}`);
  console.log(`Total ${seconds(start)}; stage logs in ${path.relative(cwd, logs) || logs}`);
  // An exit code rather than process.exit(), so piped output is flushed before the process ends.
  process.exitCode = interrupted ? SIGNAL_EXIT[interrupted] : summary.every((result) => result.status === "passed") ? 0 : 1;
}
