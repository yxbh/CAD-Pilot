import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const suite = process.argv[2];
if (!["core", "browser"].includes(suite)) throw new Error("Choose the core or browser test suite");
const cwd = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../tests/", import.meta.url)))
  .filter((name) => /\.test\.(mjs|ts)$/.test(name) && name.endsWith("-browser.test.mjs") === (suite === "browser"))
  .sort().map((name) => `tests/${name}`);
if (!files.length) throw new Error(`No tests found for ${suite}`);
const result = spawnSync(process.execPath, ["--test", ...(suite === "browser" ? ["--test-concurrency=1"] : []), ...files], {
  cwd, stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
