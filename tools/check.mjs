// Runs every workbench check; see stages.mjs for how stages are scheduled, reported and interrupted.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStages } from "./stages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;
const options = process.argv.slice(2);
if (options.some((option) => option !== "--quick")) {
  console.error("Usage: node tools/check.mjs [--quick]\n  --quick  leave out the browser scenarios, for a short loop while working");
  process.exit(2);
}
const quick = options.includes("--quick");
// The Python environment is synced once (inexactly, like `uv run`) before the suites that use it start together;
// the Explorer is built once before its two suites, which then must not rebuild into the same folder. pytest keeps
// each test module and class on one worker, so a class's shared fixture is still built once.
const STAGES = [
  { name: "python env", command: "uv", args: ["sync", "--inexact"] },
  { name: "explorer build", command: node, args: ["explorer/scripts/build.mjs"] },
  { name: "python", command: "uv", args: ["run", "--no-sync", "pytest", "-q", "-n", "4", "--dist", "loadscope", "--durations", "10"], needs: ["python env"] },
  { name: "explorer core", command: node, args: ["explorer/scripts/test.mjs", "core", "--no-build"], needs: ["python env", "explorer build"] },
  { name: "explorer browser", command: node, args: ["explorer/scripts/test.mjs", "browser", "--no-build"], needs: ["python env", "explorer build"], full: true },
].filter((stage) => !(quick && stage.full));

await runStages(STAGES, { cwd: root, logs: path.join(root, ".local", "check") });
