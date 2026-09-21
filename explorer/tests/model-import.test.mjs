import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareModelSnapshot, validateStepPath } from "../server/model-import.mjs";
import { inspectionModel } from "./inspection-fixtures.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cad-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploadDir = path.join(root, "inputs"), modelDir = path.join(root, "models");
  await Promise.all([uploadDir, modelDir].map((dir) => mkdir(dir)));
  const source = path.join(root, "source.step");
  const bytes = "Synthetic source for the mocked converter; not a CAD fixture.";
  await writeFile(source, bytes);
  const resolved = await validateStepPath(source, await realpath(root));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const model = { ...inspectionModel(sha), cleanup: { degenerateEdges: 10, zeroAreaTriangles: 2 } };
  return { resolved, uploadDir, modelDir, model, bytes, displayName: "Chosen name.step" };
}

test("snapshot preparation keeps immutable cache bytes and returns fresh measurements separately", async (t) => {
  const input = await fixture(t);
  const python = async (script, [source, flag, output]) => {
    assert.equal(script, "convert.py");
    assert.equal(flag, "--output");
    assert.equal(await readFile(source, "utf8"), input.bytes);
    await writeFile(output, JSON.stringify(input.model));
  };
  const first = await prepareModelSnapshot({ ...input, python });
  assert.equal(first.model.source.name, input.displayName);
  assert.equal(first.inputName, input.displayName);
  assert.equal(first.modelCache, `${first.model.topologyRevision}.json`);
  assert.equal(await readFile(first.inputFile, "utf8"), input.bytes);
  assert.deepEqual(first.measuredCleanup, { topologyRevision: first.model.topologyRevision, counts: input.model.cleanup });

  const cache = path.join(input.modelDir, first.modelCache);
  const legacy = structuredClone(first.model);
  delete legacy.cleanup;
  legacy.warnings = ["Zero-area tessellation triangles were omitted."];
  const oldBytes = JSON.stringify(legacy);
  await writeFile(cache, oldBytes);
  const second = await prepareModelSnapshot({ ...input, python, displayName: "Renamed source.step" });
  assert.equal(await readFile(cache, "utf8"), oldBytes);
  assert.equal(second.model.topologyRevision, first.model.topologyRevision);
  assert.equal(second.inputName, "Renamed source.step");
  assert.deepEqual(second.measuredCleanup, first.measuredCleanup);
  assert.deepEqual(await readdir(input.modelDir), [first.modelCache]);
});

test("failed or mismatched conversion cannot publish a cache and removes its temporary output", async (t) => {
  const input = await fixture(t);
  for (const failure of ["converter", "json", "identity"]) {
    const python = async (_script, [, , output]) => {
      if (failure === "identity") {
        const model = structuredClone(input.model);
        model.source.sha256 = "b".repeat(64);
        await writeFile(output, JSON.stringify(model));
      } else {
        await writeFile(output, "{");
        if (failure === "converter") throw new Error("Native conversion failed");
      }
    };
    await assert.rejects(prepareModelSnapshot({ ...input, python }),
      failure === "identity" ? { code: "revision_mismatch" } : failure === "converter" ? /Native conversion failed/ : SyntaxError);
    assert.deepEqual(await readdir(input.modelDir), [], failure);
  }
});
