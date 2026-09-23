import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { renderReportFixture } from "./render-report-fixture.mjs";

const camera = { position: [40, -50, 60], target: [1, 2, 3], up: [0, 0, 1], fov: 42 };
const reportFor = (state) => ({
  revision: state.revision, modelHash: state.documentRevision, topologyRevision: state.topologyRevision, camera,
});
const post = (service, endpoint, body) => fetch(service.url + `api/${endpoint}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("superseded render reports cannot write current state or acknowledge render/capture waiters", { timeout: 90_000 }, () => renderReportFixture(async ({ service, stateFile }) => {
  const original = service.getState();
  const reportA = reportFor(original);
  const oldView = service.execute("fit_view", {}, { rendered: true });
  const oldViewRejected = assert.rejects(oldView, { code: "superseded_view" });
  await service.execute("load_file", { file: "b.step" });
  assert.notEqual(service.getState().documentRevision, reportA.modelHash);
  assert.notEqual(service.getState().topologyRevision, reportA.topologyRevision);
  const model = await (await fetch(service.url + "api/model")).json();
  const node = model.nodes.find((item) => item.partId);
  const edge = model.parts.find((item) => item.id === node.partId).edges[0];
  await service.execute("select_edge", { id: node.id, edgeId: edge.id, topologyRevision: model.topologyRevision });

  const beforeRevision = service.getState().revision;
  let viewSettled = false;
  const view = service.execute("fit_view", {}, { rendered: true }).finally(() => { viewSettled = true; });
  // Attach handlers immediately so failed assertions still allow orderly server teardown.
  void view.catch(() => {});
  for (let count = 0; service.getState().revision === beforeRevision; count++) {
    assert.ok(count < 100, "View command was not committed");
    await delay(10);
  }
  const current = service.getState();
  const reportB = { ...reportFor(current), camera: { ...camera, position: [80, -90, 100] } };
  const saved = await readFile(stateFile, "utf8");
  const eventsAbort = new AbortController();
  const events = await fetch(service.url + "api/events", { signal: eventsAbort.signal });
  let eventText = "";
  const reading = (async () => {
    for await (const chunk of events.body) eventText += Buffer.from(chunk).toString("utf8");
  })();
  void reading.catch(() => {});
  let captureSettled = false;
  const capture = service.captureImage().finally(() => { captureSettled = true; });
  void capture.catch(() => {});
  try {
    for (const stale of [reportA, { ...reportB, revision: current.revision - 1 }]) {
      const response = await post(service, "rendered", stale);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { accepted: false, reason: "superseded_view" });
      assert.deepEqual(service.getState(), current);
      assert.equal(await readFile(stateFile, "utf8"), saved);
    }
    const invalidReports = [
      null, [], {}, { ...reportA, revision: "2" }, { ...reportA, revision: -1 },
      { ...reportA, revision: 1.5 }, { ...reportA, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...reportA, modelHash: null }, { ...reportA, topologyRevision: 17 },
      { ...reportA, modelHash: "not-a-hash" }, { ...reportB, revision: current.revision + 1 },
      { ...reportB, modelHash: reportA.modelHash }, { ...reportB, topologyRevision: reportA.topologyRevision },
    ];
    for (const report of invalidReports) {
      const response = await post(service, "rendered", report);
      assert.equal(response.status, 409, JSON.stringify(report));
      assert.equal((await response.json()).code, "bad_render_report");
    }
    for (const report of [reportA, reportB]) {
      const response = await post(service, "rendered", { ...report, camera: { ...camera, position: ["bad", 0, 0] } });
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /Invalid camera/);
    }
    const projection = await post(service, "rendered", {
      ...reportB, camera: { ...camera, projection: "orthographic", viewHeight: 40 },
    });
    assert.equal(projection.status, 409);
    assert.match((await projection.json()).error, /projection/);
    await delay(75);
    assert.equal(viewSettled, false);
    assert.equal(captureSettled, false);
    assert.ok(!eventText.includes("event: capture"), "A stale report must not release a current capture");
    assert.deepEqual(service.getState(), current);
    assert.equal(await readFile(stateFile, "utf8"), saved);

    const accepted = await post(service, "rendered", reportB);
    assert.deepEqual(await accepted.json(), { accepted: true });
    await view;
    await oldViewRejected;
    assert.deepEqual(service.getState().camera, reportB.camera);
    assert.deepEqual(service.getState().rendered, reportB);
    for (let count = 0; !eventText.includes("event: capture"); count++) {
      assert.ok(count < 100, "Current render did not release capture");
      await delay(10);
    }
    const requested = JSON.parse(eventText.match(/event: capture\ndata: ([^\n]+)/)[1]);
    assert.equal(requested.revision, current.revision);
    const result = await post(service, "capture-result", {
      ...requested, camera: reportB.camera,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
    });
    assert.equal(result.status, 200);
    const captured = await capture;
    assert.equal(captured.documentRevision, current.documentRevision);
    assert.equal(captured.topologyRevision, current.topologyRevision);
    assert.deepEqual(captured.selectedEdge, current.selectedEdge);
    assert.deepEqual(captured.section, current.section);
    assert.deepEqual(captured.camera, reportB.camera);
    const savedCurrent = await readFile(stateFile, "utf8");
    await post(service, "rendered", reportA);
    assert.deepEqual(service.getState().rendered, reportB);
    assert.equal(await readFile(stateFile, "utf8"), savedCurrent);

    await assert.rejects(service.execute("load_file", { file: "broken.step" }), { code: "conversion_failed" });
    const failedImport = service.getState();
    assert.match(failedImport.error, /STEP conversion failed/);
    assert.deepEqual(await (await post(service, "rendered", reportFor(failedImport))).json(), { accepted: true });
    assert.equal(service.getState().error, failedImport.error);
    assert.equal(service.getState().documentRevision, current.documentRevision);
  } finally {
    eventsAbort.abort();
    await reading.catch((error) => { assert.equal(error.name, "AbortError"); });
    await service.close();
    await Promise.allSettled([view, oldViewRejected, capture]);
  }
}));
