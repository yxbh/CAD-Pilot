import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { explorerRoot } from "../server/paths.mjs";

// Everything the type-check (tsconfig "include") and the page bundle read, plus the installed package tree.
const INPUTS = [
  "index.html", "package.json", "tsconfig.json", "vite.config.ts",
  "src/**/*", "shared/**/*", "tests/*.test.ts", "node_modules/.package-lock.json",
];
const stamp = path.join(explorerRoot, "dist", ".inputs.sha256");

async function inputDigest() {
  const files = [];
  for await (const entry of glob(INPUTS, { cwd: explorerRoot, withFileTypes: true })) {
    if (entry.isFile()) files.push(path.relative(explorerRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(`${file}\0`).update(await readFile(path.join(explorerRoot, file))).update("\0");
  return hash.digest("hex");
}

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(explorerRoot, "node_modules", script), ...args], { cwd: explorerRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Explorer build failed: ${script} ${args.join(" ")}`);
}

// Type-checks and bundles the page unless the last successful build used the same inputs.
export async function buildExplorer() {
  const digest = await inputDigest();
  if (await readFile(stamp, "utf8").catch(() => "") === digest) {
    console.log("Explorer build is up to date.");
    return;
  }
  await access(path.join(explorerRoot, "node_modules", ".package-lock.json")).catch(() => {
    throw new Error("Explorer packages are not installed. In the workbench, run: npm --prefix explorer install");
  });
  run("typescript/bin/tsc", ["--noEmit"]);
  run("vite/bin/vite.js", ["build"]);
  await writeFile(stamp, digest);
}
