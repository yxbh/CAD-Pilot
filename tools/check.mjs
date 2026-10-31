// Runs every workbench check; see stages.mjs for how stages are scheduled, reported and interrupted.
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStages } from "./stages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;
const USAGE = `Usage: node tools/check.mjs [--quick | --share <i>/<n>]
  (none)           every stage
  --quick          leave out the browser scenarios, for a short loop while working
  --share <i>/<n>  share i of n of the Python and Explorer test files, as CI splits them across its jobs`;
const options = process.argv.slice(2);
const mode = options[0] ?? "full";
const [index, count] = mode === "--share" && /^\d+\/\d+$/.test(options[1] ?? "") ? options[1].split("/").map(Number) : [];
const share = index >= 1 && index <= count ? options[1] : null;
if (!(share ? options.length === 2 : options.length <= 1 && ["full", "--quick"].includes(mode))) {
  console.error(USAGE);
  process.exit(2);
}
// Sized from the cores this machine has: up to four pytest workers.
const workers = String(Math.max(1, Math.min(4, availableParallelism())));
const logs = path.join(root, ".local", "check");
// The Python environment is synced once (inexactly, like `uv run`) before the suites that use it start together;
// the Explorer is built once before its suites, which then must not rebuild into the same folder. conftest.py keeps
// a class with setUpClass on one pytest worker and spreads every other test. Every test stage also records its test
// files' times beside the logs, where tools/durations.mjs reads them from a CI run.
const durations = (...parts) => path.join(logs, `${parts.join("-").replace(/\W+/g, "-")}.durations.json`);
const env = { name: "python env", command: "uv", args: ["sync", "--inexact"] };
const build = { name: "explorer build", command: node, args: ["explorer/scripts/build.mjs"] };
const explorer = (name, ...args) => ({
  name, command: node, needs: [env.name, build.name],
  args: ["explorer/scripts/test.mjs", ...args, "--no-build", "--durations", durations("explorer", ...args)],
});
// In a CI share the Python tests start once the Explorer is built: the Explorer's share waits on the build, so the
// build gets the runner's few cores to itself.
const python = {
  name: share ? `python ${share}` : "python", command: "uv", needs: share ? [env.name, build.name] : [env.name],
  args: [
    "run", "--no-sync", "pytest", "-q", "-n", workers, "--durations", "30",
    ...(share ? ["--share", share] : []), "--record-durations", durations("python", ...(share ? [share] : [])),
  ],
};
const STAGES = {
  full: [env, build, python, explorer("explorer core", "core"), explorer("explorer browser", "browser")],
  "--quick": [env, build, python, explorer("explorer core", "core")],
  "--share": [env, build, python, explorer(`explorer ${share}`, "shard", share)],
}[mode];

await runStages(STAGES, { cwd: root, logs });
