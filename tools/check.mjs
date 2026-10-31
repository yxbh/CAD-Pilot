// Runs every workbench check; see stages.mjs for how stages are scheduled, reported and interrupted.
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStages } from "./stages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;
const USAGE = `Usage: node tools/check.mjs [--quick | --python | --explorer <i>/<n>]
  (none)              every stage
  --quick             leave out the browser scenarios, for a short loop while working
  --python            only the Python suites
  --explorer <i>/<n>  only share i of n of the Explorer core and browser tests, as CI splits them`;
const options = process.argv.slice(2);
const shard = options[0] === "--explorer" && /^\d+\/\d+$/.test(options[1] ?? "") ? options[1] : null;
const mode = shard ? "explorer" : options[0] ?? "full";
if (!(shard ? options.length === 2 : options.length <= 1 && ["full", "--quick", "--python"].includes(mode))) {
  console.error(USAGE);
  process.exit(2);
}
// Sized from the cores this machine has: up to four pytest workers.
const workers = String(Math.max(1, Math.min(4, availableParallelism())));
// The Python environment is synced once (inexactly, like `uv run`) before the suites that use it start together;
// the Explorer is built once before its suites, which then must not rebuild into the same folder. conftest.py keeps
// a class with setUpClass on one pytest worker and spreads every other test.
const env = { name: "python env", command: "uv", args: ["sync", "--inexact"] };
const build = { name: "explorer build", command: node, args: ["explorer/scripts/build.mjs"] };
const explorer = (name, ...args) => ({ name, command: node, args: ["explorer/scripts/test.mjs", ...args, "--no-build"], needs: [env.name, build.name] });
const python = {
  name: "python", command: "uv", needs: [env.name],
  args: ["run", "--no-sync", "pytest", "-q", "-n", workers, "--durations", "30"],
};
const STAGES = {
  full: [env, build, python, explorer("explorer core", "core"), explorer("explorer browser", "browser")],
  "--quick": [env, build, python, explorer("explorer core", "core")],
  "--python": [env, python],
  explorer: [env, build, explorer(`explorer ${shard}`, "shard", shard)],
}[mode];

await runStages(STAGES, { cwd: root, logs: path.join(root, ".local", "check") });
