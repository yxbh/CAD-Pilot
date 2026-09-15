import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExplorerServer } from "../server/server.mjs";

test("local server rejects missing capability and cross-origin writes", async () => {
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

test("file actions cannot read outside the configured root or execute source", async () => {
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
    assert.equal(upload.status, 400);
  } finally {
    await service.close();
    await rm(root, { recursive: true });
  }
});
