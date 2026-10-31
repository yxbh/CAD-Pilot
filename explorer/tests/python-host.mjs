import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { explorerRoot, workbenchPython } from "../server/paths.mjs";

// One browser_host.py per test process runs the Playwright scenarios and their Python fixtures one after another, so
// Playwright, Chromium and imports such as build123d start once rather than for every script.
const MARK = "cad-explorer-test-host ";
let host = null;
let queue = Promise.resolve();

function stop(child) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

function start() {
  const child = spawn(workbenchPython, ["-B", path.join(explorerRoot, "tests", "browser_host.py")], {
    cwd: explorerRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const started = { child, waiting: null, log: "" };
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.startsWith(MARK)) started.waiting?.resolve(JSON.parse(line.slice(MARK.length)));
      else started.log += `${line}\n`;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { started.log += chunk; });
  child.once("exit", (code, signal) => {
    if (host === started) host = null;
    started.waiting?.reject(new Error(`The Python test host exited (${signal ?? code}).\n${started.log}`));
  });
  // An idle host never keeps a finished test process alive; it is stopped when the process exits.
  for (const stream of [child, child.stdin, child.stdout, child.stderr]) stream.unref();
  process.once("exit", () => stop(child));
  return started;
}

async function run(script, args, timeout) {
  host ??= start();
  const current = host;
  current.log = "";
  const result = new Promise((resolve, reject) => { current.waiting = { resolve, reject }; });
  const timer = setTimeout(() => {
    current.waiting?.reject(new Error(`${script} did not finish within ${timeout / 1000} s.\n${current.log}`));
    // The next script starts a new host rather than waiting on this one to exit.
    if (host === current) host = null;
    stop(current.child);
  }, timeout);
  for (const stream of [current.child, current.child.stdin, current.child.stdout, current.child.stderr]) stream.ref();
  try {
    current.child.stdin.write(`${JSON.stringify({ script, args })}\n`);
    return await result;
  } finally {
    clearTimeout(timer);
    current.waiting = null;
    if (host === current) for (const stream of [current.child, current.child.stdin, current.child.stdout, current.child.stderr]) stream.unref();
  }
}

// Runs a script from explorer/tests as `python <script> <args>` would, with stdout and stderr, and rejects like
// execFile when it fails. Calls run one at a time.
export function runPython(script, args = [], { timeout = 210_000 } = {}) {
  const job = queue.then(async () => {
    const result = await run(script, args, timeout);
    if (result.code !== 0) {
      throw Object.assign(new Error(`${script} ${args.join(" ")} failed with exit code ${result.code}\n${result.stderr}`), result);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  });
  queue = job.catch(() => {});
  return job;
}
