import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeRoot as defaultRuntimeRoot, workbenchRoot, isInside } from "../server/paths.mjs";
import { createTestRuntime, viewStateFile } from "./service-fixture.mjs";

test("runtime roots isolate leases, references, captures and persisted state for the same project/view", { timeout: 30_000 }, async (t) => {
  const first = await createTestRuntime(t), second = await createTestRuntime(t);
  assert.ok(!isInside(defaultRuntimeRoot, first.runtimeRoot));
  const sentinel = path.join(second.runtimeRoot, "unrelated-data");
  await writeFile(sentinel, "Keep this data");
  const viewId = "same-view";
  const a = await first.createService({ projectRoot: workbenchRoot, viewId });
  const b = await second.createService({ projectRoot: workbenchRoot, viewId });
  await a.initialize();
  assert.equal(a.getState().error, "");
  assert.equal(a.getState().runtimeRoot, first.runtimeRoot);
  assert.equal(b.getState().runtimeRoot, second.runtimeRoot);
  const model = await (await fetch(a.url + "api/model")).json();
  const node = model.nodes.find((item) => item.partId);
  const part = model.parts.find((item) => item.id === node.partId);
  await a.execute("select_face", { id: node.id, faceId: part.faces[0].id, topologyRevision: model.topologyRevision });
  const reference = a.getState().selectedReferences[0].reference;
  const descriptor = await a.execute("prepare_clipboard_reference", { reference });
  assert.ok(isInside(first.runtimeRoot, descriptor.filePath));
  assert.equal((await a.execute("inspect_reference", { reference })).snapshotStatus, "available");
  await assert.rejects(b.execute("inspect_reference", { reference }), { code: "reference_unavailable" });
  assert.deepEqual(await readdir(path.join(second.runtimeRoot, "models")), []);
  const stateFile = viewStateFile(first.runtimeRoot, a.projectRoot, viewId);
  const saved = await readFile(stateFile, "utf8");
  await b.execute("set_auto_copy", { enabled: false });
  assert.equal(await readFile(stateFile, "utf8"), saved);
  assert.equal(await readFile(sentinel, "utf8"), "Keep this data");
  assert.equal(a.getState().autoCopy, true);
  const state = a.getState();
  const rendered = await fetch(a.url + "api/rendered", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: state.revision, modelHash: state.documentRevision, topologyRevision: state.topologyRevision }),
  });
  assert.equal(rendered.status, 200);
  const abort = new AbortController();
  const events = await fetch(a.url + "api/events", { signal: abort.signal });
  const reader = events.body.getReader();
  const capture = a.captureImage();
  void capture.catch(() => {});
  try {
    let text = "", request;
    while (!request) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += new TextDecoder().decode(value);
      const match = /event: capture\ndata: ([^\n]+)/.exec(text);
      if (match) request = JSON.parse(match[1]);
    }
    const response = await fetch(a.url + "api/capture-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=" }),
    });
    assert.equal(response.status, 200);
    assert.ok(isInside(first.runtimeRoot, (await capture).path));
    assert.deepEqual(await readdir(path.join(second.runtimeRoot, "captures")), []);
  } finally {
    abort.abort();
    await a.close();
    await capture.catch(() => {});
  }
  const restarted = await first.createService({ projectRoot: workbenchRoot, viewId });
  await restarted.initialize();
  assert.equal((await restarted.execute("inspect_reference", { reference })).reference, reference);
  assert.equal(restarted.getState().selectedReferences[0].reference, reference);
  await first.dispose();
  await assert.rejects(stat(first.runtimeRoot), { code: "ENOENT" });
  assert.equal(await readFile(sentinel, "utf8"), "Keep this data");
});
