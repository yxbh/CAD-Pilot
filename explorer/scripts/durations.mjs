// Refreshes tests/durations.json, the per-platform test-file times scripts/test.mjs balances CI's shards by, from what
// CI's Explorer jobs recorded (their check logs keep a .durations.json per stage): those of the latest successful check
// run on main, or of the run given. Needs the GitHub CLI, signed in.
import { execFileSync } from "node:child_process";
import { glob, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: node scripts/durations.mjs [<run id>]";
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !/^\d+$/.test(args[0]))) {
  console.error(USAGE);
  process.exit(2);
}
const explorerRoot = fileURLToPath(new URL("../", import.meta.url));
const table = path.join(explorerRoot, "tests", "durations.json");
const gh = (...ghArgs) => execFileSync("gh", ghArgs, { cwd: explorerRoot, encoding: "utf8" }).trim();
const run = args[0] ?? gh("run", "list", "--workflow", "check.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId");
if (!run) throw new Error("No successful check run on main to read durations from.");

const folder = await mkdtemp(path.join(tmpdir(), "explorer-durations-"));
try {
  gh("run", "download", run, "--pattern", "check-logs-explorer-*", "--dir", folder);
  const measured = {};
  for await (const file of glob("**/*.durations.json", { cwd: folder })) {
    const { platform, seconds } = JSON.parse(await readFile(path.join(folder, file), "utf8"));
    Object.assign((measured[platform] ??= {}), seconds);
  }
  if (!Object.keys(measured).length) throw new Error(`Run ${run} recorded no Explorer test durations.`);
  // A platform the run did not measure keeps its earlier times.
  const durations = { ...JSON.parse(await readFile(table, "utf8").catch(() => "{}")), ...measured };
  const sorted = Object.fromEntries(Object.keys(durations).sort().map((platform) => [platform, Object.fromEntries(
    Object.entries(durations[platform]).sort(([a], [b]) => a.localeCompare(b)).map(([file, seconds]) => [file, Math.round(seconds * 10) / 10]),
  )]));
  await writeFile(table, `${JSON.stringify(sorted, null, 2)}\n`);
  const counts = Object.entries(measured).map(([platform, seconds]) => `${platform} ${Object.keys(seconds).length} files`);
  console.log(`Wrote ${path.relative(process.cwd(), table)} from run ${run}: ${counts.join(", ")}`);
} finally {
  await rm(folder, { recursive: true, force: true });
}
