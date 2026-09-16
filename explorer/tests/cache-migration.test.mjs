import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createExplorerServer, explorerRoot, workbenchRoot, runtimeRoot } from "../server/server.mjs";
import { workbenchPython } from "../server/paths.mjs";
import { initialState, topologyRevision } from "../server/protocol.mjs";
import { createReference } from "../shared/references.mjs";

test("saved part-only snapshots regenerate with face maps and clear stale selection", async () => {
  const runtime = runtimeRoot;
  const viewId = `migration-${randomUUID()}`;
  const key = createHash("sha256").update(`${workbenchRoot}\n${viewId}`).digest("hex").slice(0, 24);
  const legacyKey = createHash("sha256").update(viewId).digest("hex");
  const stateFile = path.join(runtime, "views", `${key}.json`);
  const legacyFile = path.join(runtime, "models", `${legacyKey}.json`);
  const source = path.join(runtime, `${viewId}.step`);
  for (const folder of ["views", "models", "inputs"]) await mkdir(path.join(runtime, folder), { recursive: true });
  const generated = spawnSync(workbenchPython, [
    "-B", path.join(explorerRoot, "python", "create_demo.py"), "--output", source,
  ], { timeout: 30_000, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = await readFile(source);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const snapshot = path.join(runtime, "inputs", `${sourceHash}.step`);
  await writeFile(snapshot, bytes);
  await writeFile(legacyFile, JSON.stringify({ schemaVersion: 1, source: { name: "Migration fixture", sha256: sourceHash } }));
  await writeFile(stateFile, JSON.stringify({
    state: { ...initialState(), autoAdd: true, selectedIds: ["old-id"], revision: 3 },
    modelCache: path.basename(legacyFile), inputFile: snapshot,
  }));
  const logs = [];
  const added = [];
  let service = await createExplorerServer({
    projectRoot: workbenchRoot, viewId, log: (message) => logs.push(message),
    addReferenceToChat: async (attachment) => { added.push(attachment); },
  });

  try {
    await service.initialize();
    const state = service.getState();
    assert.equal(state.error, "");
    assert.equal(state.documentRevision, sourceHash);
    assert.match(state.topologyRevision, /^[a-f0-9]{64}$/);
    assert.notEqual(state.topologyRevision, sourceHash);
    assert.deepEqual(state.selectedIds, []);
    assert.equal(state.selectedFace, null);
    const model = await (await fetch(service.url + "api/model")).json();
    assert.equal(model.schemaVersion, 2);
    assert.ok(model.parts.every((part) => part.faces.length > 0));
    assert.ok(logs.some((message) => /Rebuilding/.test(message)));
    const occurrence = model.nodes.find((node) => node.partId);
    const part = model.parts.find((item) => item.id === occurrence.partId);
    await service.execute("select_face", { id: occurrence.id, faceId: part.faces[0].id, topologyRevision: model.topologyRevision });
    assert.equal(added.length, 0, "Selection alone must not add an attachment");
    const beforeAttach = service.getState().revision;
    const attachmentResponse = await fetch(service.url + "api/add-reference", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: beforeAttach }),
    });
    assert.equal(attachmentResponse.status, 200);
    assert.equal((await attachmentResponse.json()).sent, false);
    assert.equal(added.length, 1);
    assert.equal(added[0].payload.references[0].faceId, part.faces[0].id);
    assert.equal(service.getState().revision, beforeAttach);
    const staleAttachment = await fetch(service.url + "api/add-reference", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: beforeAttach - 1 }),
    });
    assert.equal(staleAttachment.status, 409);
    assert.equal(added.length, 1);
    assert.equal(state.autoCopy, true);
    assert.equal("autoAdd" in state, false);
    const copied = await service.execute("prepare_clipboard_reference", { reference: service.getState().selectedReferences[0].reference });
    assert.match(copied.text, /^<copilot-ref kind="file" /);
    assert.equal(copied.title, `${occurrence.label} \u00b7 Face ${part.faces[0].id}`);
    assert.equal(copied.title.replaceAll("\\", "/").split("/").at(-1), copied.title);
    const descriptor = JSON.parse(await readFile(copied.filePath, "utf8"));
    assert.equal(descriptor.face.id, part.faces[0].id);
    assert.equal(descriptor.occurrence.id, occurrence.id);
    assert.equal(descriptor.source.sha256, sourceHash);
    assert.equal(added.length, 1, "Preparing a clipboard file does not add another draft attachment");
    await unlink(copied.filePath);
    await service.execute("set_auto_copy", { enabled: false });
    await service.execute("load_file", { file: source });
    assert.equal(service.getState().autoCopy, false, "Opening a model must preserve the user's auto-copy preference");
    const retainedName = service.getState().modelName;
    model.source.name = "Same bytes opened under a different filename.step";
    await writeFile(path.join(runtime, "models", `${model.topologyRevision}.json`), JSON.stringify(model));
    await service.close();
    service = await createExplorerServer({ projectRoot: workbenchRoot, viewId, log: (message) => logs.push(message) });
    await service.initialize();
    const restored = await (await fetch(service.url + "api/model")).json();
    assert.equal(restored.source.name, retainedName);
    assert.equal(restored.source.name, service.getState().modelName);
    assert.equal(service.getState().autoCopy, false, "Provider restart must restore the user's preference");
  } finally {
    await service.close();
    await Promise.all([source, legacyFile, stateFile].map((file) => unlink(file)));
  }
});

test("face-only schema-2 caches regenerate edges without changing retained references, then persist exact edge selection", async () => {
  const viewId = `edges-migration-${randomUUID()}`;
  const key = createHash("sha256").update(`${workbenchRoot}\n${viewId}`).digest("hex").slice(0, 24);
  const stateFile = path.join(runtimeRoot, "views", `${key}.json`);
  let service = await createExplorerServer({ projectRoot: workbenchRoot, viewId, log: () => {} });
  let oldFile;
  try {
    await service.initialize();
    const original = await (await fetch(service.url + "api/model")).json();
    assert.ok(original.parts.every((part) => part.edges.length > 0));
    const legacy = structuredClone(original);
    legacy.nodes[0].label = viewId;
    for (const part of legacy.parts) delete part.edges;
    legacy.topologyRevision = topologyRevision(legacy);
    oldFile = path.join(runtimeRoot, "models", `${legacy.topologyRevision}.json`);
    const oldBytes = JSON.stringify(legacy);
    await writeFile(oldFile, oldBytes);
    const occurrence = legacy.nodes.find((node) => node.partId);
    const part = legacy.parts.find((item) => item.id === occurrence.partId);
    const oldReference = createReference(legacy, occurrence.id, part.faces[0].id);
    await service.close();
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    saved.modelCache = path.basename(oldFile);
    saved.inputName = "Remembered filename.step";
    saved.state.topologyRevision = legacy.topologyRevision;
    saved.state.selectedIds = [occurrence.id];
    saved.state.selectedFace = { nodeId: occurrence.id, faceId: part.faces[0].id };
    delete saved.state.selectedEdge;
    await writeFile(stateFile, JSON.stringify(saved));
    service = await createExplorerServer({ projectRoot: workbenchRoot, viewId, log: () => {} });
    await service.initialize();
    const state = service.getState();
    assert.equal(state.error, "");
    assert.equal(state.modelName, "Remembered filename.step");
    assert.notEqual(state.topologyRevision, legacy.topologyRevision);
    assert.equal(state.selectedFace, null);
    assert.equal(state.selectedEdge, null);
    assert.deepEqual(state.selectedIds, []);
    assert.equal(await readFile(oldFile, "utf8"), oldBytes, "Do not mutate a previously copied reference's topology");
    const inspected = await service.execute("inspect_reference", { reference: oldReference });
    assert.equal(inspected.face.id, part.faces[0].id);
    assert.equal(inspected.edge, null);
    const model = await (await fetch(service.url + "api/model")).json();
    const edgeId = model.parts.find((item) => item.id === occurrence.partId).edges[0].id;
    await assert.rejects(service.execute("select_edge", { id: occurrence.id, edgeId, topologyRevision: legacy.topologyRevision }), { code: "stale_topology" });
    await service.execute("select_edge", { id: occurrence.id, edgeId, topologyRevision: model.topologyRevision });
    const reference = service.getState().selectedReferences[0].reference;
    assert.match(reference, new RegExp(`/${edgeId}$`));
    const selected = service.getState();
    const post = (route, payload) => fetch(service.url + route, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const report = { revision: selected.revision, modelHash: selected.documentRevision, topologyRevision: selected.topologyRevision,
      selectedEdge: selected.selectedEdge, highlightedSegments: 1, selectedEdgeScreen: [0.5, 0.5] };
    assert.equal((await post("api/rendered", report)).status, 200);
    assert.deepEqual(service.getState().rendered.selectedEdge, selected.selectedEdge);
    const events = await fetch(service.url + "api/events", { signal: AbortSignal.timeout(5000) });
    const reader = events.body.getReader();
    const capturing = service.captureImage();
    try {
      let text = "", match;
      while (!(match = /event: capture\ndata: ([^\n]+)/.exec(text))) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      const request = JSON.parse(match[1]);
      const response = await post("api/capture-result", {
        id: request.id, revision: selected.revision,
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
      });
      assert.equal(response.status, 200);
      const captured = await capturing;
      try {
        assert.deepEqual(captured.selectedEdge, selected.selectedEdge);
        const metadata = JSON.parse(await readFile(`${captured.path}.json`, "utf8"));
        assert.deepEqual(metadata.selectedEdge, selected.selectedEdge);
        assert.equal(metadata.selectedFace, null);
      } finally {
        await Promise.all([captured.path, `${captured.path}.json`].map((file) => unlink(file)));
      }
    } finally {
      await reader.cancel();
    }
    await service.close();
    service = await createExplorerServer({ projectRoot: workbenchRoot, viewId, log: () => {} });
    await service.initialize();
    assert.deepEqual(service.getState().selectedEdge, { nodeId: occurrence.id, edgeId });
    assert.equal(service.getState().selectionMode, "edge");
    assert.equal(service.getState().selectedReferences[0].reference, reference);
    assert.equal((await service.execute("inspect_reference", { reference })).edge.id, edgeId);
    await service.execute("load_demo");
    assert.equal(service.getState().selectedEdge, null);
  } finally {
    await service.close();
    await Promise.all([stateFile, oldFile].filter(Boolean).map((file) => unlink(file)));
  }
});
