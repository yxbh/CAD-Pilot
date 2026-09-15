import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createExplorerServer, runtimeRoot, workbenchRoot } from "../server/server.mjs";

test("rendered projection and appearance persist across provider restart without changing the view revision", async () => {
  const viewId = `presentation-${randomUUID()}`;
  const key = createHash("sha256").update(`${workbenchRoot}\n${viewId}`).digest("hex").slice(0, 24);
  const stateFile = path.join(runtimeRoot, "views", `${key}.json`);
  let service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
  const camera = { position: [150, -100, 80], target: [3, -2, 4], up: [0, 0, 1], fov: 42, projection: "orthographic", viewHeight: 126 };
  try {
    await service.initialize();
    await service.execute("set_projection", { projection: "orthographic" });
    const current = await service.execute("set_appearance", { mode: "studio", finish: "satin", showEdges: false });
    const response = await fetch(service.url + "api/rendered", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: current.revision, modelHash: current.documentRevision, topologyRevision: current.topologyRevision, camera }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    assert.equal(service.getState().revision, current.revision);
    await service.close();
    service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
    await service.initialize();
    const restored = service.getState();
    assert.equal(restored.projection, "orthographic");
    assert.equal(restored.appearance, "studio");
    assert.equal(restored.materialFinish, "satin");
    assert.equal(restored.showEdges, false);
    assert.deepEqual(restored.camera, camera);
    const newer = await service.execute("set_projection", { projection: "perspective" });
    const rejected = await fetch(service.url + "api/rendered", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: newer.revision - 1, modelHash: newer.documentRevision, topologyRevision: newer.topologyRevision, camera }),
    });
    assert.equal((await rejected.json()).accepted, false);
    await service.close();
    const legacy = JSON.parse(await readFile(stateFile, "utf8"));
    for (const field of ["projection", "appearance", "materialFinish", "showEdges"]) delete legacy.state[field];
    legacy.state.camera = { position: [10, -20, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 42 };
    await writeFile(stateFile, JSON.stringify(legacy));
    service = await createExplorerServer({ projectRoot: workbenchRoot, viewId });
    await service.initialize();
    assert.equal(service.getState().projection, "perspective");
    assert.equal(service.getState().appearance, "inspect");
    assert.equal(service.getState().showEdges, true);
    assert.deepEqual(service.getState().camera, legacy.state.camera);
  } finally {
    await service.close();
    await unlink(stateFile);
  }
});
