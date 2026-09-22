import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTestRuntime, viewStateFile } from "./service-fixture.mjs";

test("local server rejects missing capability and cross-origin writes", async (t) => {
  const { createService: createExplorerServer } = await createTestRuntime(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "cad-prototype-http-"));
  const service = await createExplorerServer({ projectRoot: root, viewId: "http-test", log: () => {} });
  try {
    const url = new URL(service.url);
    assert.equal((await fetch(service.url + "api/state")).status, 200);
    assert.equal((await fetch(url.origin + "/api/state")).status, 403);
    const denied = await fetch(service.url + "api/command", {
      method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json" },
      body: JSON.stringify({ name: "fit_view", input: {} }),
    });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /Local Explorer/);
    const invalid = await fetch(service.url + "api/command", { method: "POST", body: "not json" });
    assert.equal(invalid.status, 400);
    assert.equal(service.getState().revision, 0);
  } finally {
    await service.close();
    await rm(root, { recursive: true });
  }
});

test("file actions cannot read outside the configured root or execute source", async (t) => {
  const { createService: createExplorerServer } = await createTestRuntime(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "cad-prototype-files-"));
  const service = await createExplorerServer({ projectRoot: root, viewId: "files-test", log: () => {} });
  try {
    const source = path.join(root, "generator.py");
    await writeFile(source, "raise RuntimeError('must not run')\n");
    await assert.rejects(service.execute("load_file", { file: source }), /Choose a .step/);
    await assert.rejects(service.execute("load_file", { file: import.meta.filename }), /inside the selected project root/);
    const upload = await fetch(service.url + "api/upload", {
      method: "POST", headers: { "x-file-name": "generator.py" }, body: "print('not allowed')",
    });

    test("failed uploads preserve the prior model and leave no durable failed-attempt input", async (t) => {
      const runtime = await createTestRuntime(t);
      const service = await runtime.createService({ viewId: "failed-upload", log: () => {} });
      await service.initialize();
      assert.equal(service.getState().error, "");
      const previous = service.getState();
      const inputs = await readdir(path.join(runtime.runtimeRoot, "inputs"));
      const models = await readdir(path.join(runtime.runtimeRoot, "models"));
      const response = await fetch(service.url + "api/upload", {
        method: "POST", headers: { "x-file-name": "broken.step" }, body: "not a STEP",
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "conversion_failed");
      assert.deepEqual(await readdir(path.join(runtime.runtimeRoot, "inputs")), inputs);
      assert.deepEqual(await readdir(path.join(runtime.runtimeRoot, "models")), models);
      const current = service.getState();
      assert.equal(current.loading, false);
      assert.equal(current.documentRevision, previous.documentRevision);
      assert.equal(current.topologyRevision, previous.topologyRevision);
      assert.match(current.error, /STEP conversion failed/);
      const saved = JSON.parse(await readFile(viewStateFile(runtime.runtimeRoot, service.projectRoot, "failed-upload"), "utf8"));
      assert.equal(saved.modelCache, `${previous.topologyRevision}.json`);
      assert.equal(path.basename(saved.inputFile), `${previous.documentRevision}.step`);
    });
    assert.equal(upload.status, 400);
  } finally {
    await service.close();
    await rm(root, { recursive: true });
  }
});
