import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareModelSnapshot, validateStepPath } from "../server/model-import.mjs";
import { PrototypeError } from "../server/protocol.mjs";
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
  return { resolved, uploadDir, modelDir, model, sourceText: bytes, displayName: "Chosen name.step" };
}

test("snapshot preparation keeps immutable cache bytes and returns fresh measurements separately", async (t) => {
  const input = await fixture(t);
  const python = async (script, [source, flag, output]) => {
    assert.equal(script, "convert.py");
    assert.equal(flag, "--output");
    assert.equal(await readFile(source, "utf8"), input.sourceText);
    await writeFile(output, JSON.stringify(input.model));
  };
  const first = await prepareModelSnapshot({ ...input, python });
  assert.equal(first.model.source.name, input.displayName);
  assert.equal(first.inputName, input.displayName);
  assert.equal(first.modelCache, `${first.model.topologyRevision}.json`);
  assert.equal(await readFile(first.inputFile, "utf8"), input.sourceText);
  assert.deepEqual(first.measuredCleanup, { topologyRevision: first.model.topologyRevision, counts: input.model.cleanup });

  const cache = path.join(input.modelDir, first.modelCache);
  const legacy = structuredClone(first.model);
  delete legacy.cleanup;
  legacy.warnings = ["Zero-area tessellation triangles were omitted."];
  const oldBytes = JSON.stringify(legacy);
  await writeFile(cache, oldBytes);
  const beforeCache = await stat(cache), beforeSource = await stat(first.inputFile);
  const second = await prepareModelSnapshot({ ...input, python, displayName: "Renamed source.step" });
  assert.equal(await readFile(cache, "utf8"), oldBytes);
  assert.equal(second.model.topologyRevision, first.model.topologyRevision);
  assert.equal(second.inputName, "Renamed source.step");
  assert.deepEqual(second.measuredCleanup, first.measuredCleanup);
  assert.deepEqual(await readdir(input.modelDir), [first.modelCache]);
  assert.equal((await stat(cache)).mtimeMs, beforeCache.mtimeMs);
  assert.equal((await stat(first.inputFile)).mtimeMs, beforeSource.mtimeMs);
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
    assert.deepEqual(await readdir(input.uploadDir), [], failure);
  }
});

test("concurrent imports publish complete snapshots without replacing an existing winner", async (t) => {
  const input = await fixture(t);
  const python = async (_script, [, , output]) => writeFile(output, JSON.stringify(input.model));
  const results = await Promise.all(Array.from({ length: 4 }, () => prepareModelSnapshot({ ...input, python })));
  assert.equal(new Set(results.map((result) => result.modelCache)).size, 1);
  assert.deepEqual(await readdir(input.modelDir), [results[0].modelCache]);
  assert.equal(await readFile(results[0].inputFile, "utf8"), input.sourceText);
  assert.deepEqual(JSON.parse(await readFile(path.join(input.modelDir, results[0].modelCache), "utf8")), results[0].model);
});

test("preexisting source or cache corruption is reported rather than overwritten", async (t) => {
  const input = await fixture(t);
  const python = async (_script, [, , output]) => writeFile(output, JSON.stringify(input.model));
  const imported = await prepareModelSnapshot({ ...input, python });
  const cache = path.join(input.modelDir, imported.modelCache);
  const goodCache = await readFile(cache, "utf8");
  await writeFile(cache, "{}");
  await assert.rejects(prepareModelSnapshot({ ...input, python }), { code: "invalid_model" });
  assert.equal(await readFile(cache, "utf8"), "{}");
  assert.equal(await readFile(imported.inputFile, "utf8"), input.sourceText);
  await writeFile(cache, goodCache);
  await writeFile(imported.inputFile, "Damaged shared snapshot");
  await assert.rejects(prepareModelSnapshot({ ...input, python }), { code: "snapshot_mismatch" });
  assert.equal(await readFile(imported.inputFile, "utf8"), "Damaged shared snapshot");
  assert.equal(await readFile(cache, "utf8"), goodCache);
  assert.deepEqual(await readdir(input.modelDir), [imported.modelCache]);
});

test("conversion and cleanup failures retain the primary code/status and expose both diagnostics", async (t) => {
  const input = await fixture(t);
  const primary = new PrototypeError("conversion_timeout", "STEP conversion exceeded two minutes", 408);
  const cleanup = Object.assign(new Error("Temporary directory is locked"), { code: "EPERM" });
  await assert.rejects(prepareModelSnapshot({
    ...input, python: async () => { throw primary; },
  }, { remove: async () => { throw cleanup; } }), (error) => {
    assert.ok(error instanceof PrototypeError);
    assert.equal(error.code, primary.code);
    assert.equal(error.status, primary.status);
    assert.match(error.message, /STEP conversion exceeded two minutes/);
    assert.match(error.message, /Temporary directory is locked/);
    assert.deepEqual(error.cause.errors, [primary, cleanup]);
    return true;
  });
  assert.deepEqual(await readdir(input.uploadDir), []);
});

test("cleanup failure after promotion does not unlink shared validated artifacts", async (t) => {
  const input = await fixture(t);
  const python = async (_script, [, , output]) => writeFile(output, JSON.stringify(input.model));
  await assert.rejects(prepareModelSnapshot({ ...input, python }, {
    remove: async () => { throw new Error("Cleanup unavailable"); },
  }), { code: "import_cleanup_failed", status: 500 });
  const cache = (await readdir(input.modelDir)).find((file) => file.endsWith(".json"));
  assert.ok(cache);
  const model = JSON.parse(await readFile(path.join(input.modelDir, cache), "utf8"));
  assert.equal(await readFile(path.join(input.uploadDir, `${model.source.sha256}.step`), "utf8"), input.sourceText);
});

test("uploaded bytes use the same private preparation without a prior retained input", async (t) => {
  const input = await fixture(t);
  const imported = await prepareModelSnapshot({
    ...input, resolved: undefined, bytes: Buffer.from(input.sourceText),
    python: async (_script, [source, , output]) => {
      assert.deepEqual(await readdir(input.uploadDir), []);
      assert.equal(await readFile(source, "utf8"), input.sourceText);
      await writeFile(output, JSON.stringify(input.model));
    },
  });
  assert.equal(await readFile(imported.inputFile, "utf8"), input.sourceText);
  assert.deepEqual(await readdir(input.modelDir), [imported.modelCache]);
});
