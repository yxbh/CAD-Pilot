import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { buildExplorer } from "./incremental-build.mjs";

const [suite, ...options] = process.argv.slice(2);
if (!["core", "browser"].includes(suite)) throw new Error("Choose the core or browser test suite");
const cwd = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../tests/", import.meta.url)))
  .filter((name) => /\.test\.(mjs|ts)$/.test(name) && name.endsWith("-browser.test.mjs") === (suite === "browser"))
  .sort().map((name) => `tests/${name}`);
if (!files.length) throw new Error(`No tests found for ${suite}`);
// Browser suites and the launcher's background viewers serve the built page. tools/check.mjs builds once before
// running both suites at the same time, so they must not rebuild into the same folder.
if (!options.includes("--no-build")) await buildExplorer();
// Each browser scenario drives its own Chromium with software WebGL, so only a few run at once: half the cores, at
// most three. Core files use Node's default concurrency.
const concurrency = suite === "browser" ? [`--test-concurrency=${Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)))}`] : [];
const result = spawnSync(process.execPath, ["--test", ...concurrency, ...files], {
  cwd, stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
