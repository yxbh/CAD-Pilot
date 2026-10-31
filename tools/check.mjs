// Runs every workbench check; see stages.mjs for how stages are scheduled, reported and interrupted.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStages } from "./stages.mjs";

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

await runStages(STAGES, { cwd: root, logs: path.join(root, ".local", "check") });
