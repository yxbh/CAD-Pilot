import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/test.mjs", import.meta.url));
const list = (part) => JSON.parse(execFileSync(process.execPath, [script, "shard", part, "--list"], { encoding: "utf8" }).trim().split("\n").at(-1));

test("CI's shards run every Explorer test file exactly once", async () => {
  const files = (await readdir(new URL(".", import.meta.url))).filter((name) => /\.test\.(mjs|ts)$/.test(name)).sort();
  for (const count of [1, 4]) {
    const shards = Array.from({ length: count }, (_, index) => list(`${index + 1}/${count}`));
    assert.deepEqual(shards.flat().sort(), files, `${count} shards`);
  }
});
