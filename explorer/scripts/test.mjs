import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildExplorer } from "./build.mjs";

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
const result = spawnSync(process.execPath, ["--test", ...(suite === "browser" ? ["--test-concurrency=1"] : []), ...files], {
  cwd, stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
