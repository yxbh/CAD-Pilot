import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startCopilotExplorer } from "../hosts/copilot.mjs";
import { workbenchRoot } from "../server/paths.mjs";
import { COMMANDS } from "../shared/commands.mjs";
import { createTestRuntime, viewStateFile } from "./service-fixture.mjs";

class CanvasError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
async function fixture({ missingBuild = false } = {}) {
  let declaration;
  const calls = [];
  const service = {
    url: "http://127.0.0.1:12345/local-capability/",
    async initialize() { calls.push(["initialize"]); },
    async close() { calls.push(["close"]); },
    async execute(...args) { calls.push(args); return { revision: 4 }; },
    async captureImage() { return { path: "capture.png" }; },
  };
  const provider = await startCopilotExplorer({
    joinSession: async (config) => { declaration = config; return { log: async () => {} }; },
    createCanvas: (value) => value,
    CanvasError,
  }, {
    canonicalize: async () => workbenchRoot,
    createService: async () => service,
    inspect: async (reference) => ({ reference, face: { id: "f6" } }),
    checkBuild: async () => {
      if (missingBuild) throw Object.assign(new Error("Missing"), { code: "ENOENT" });
    },
  });
  return { provider, declaration, canvas: declaration.canvases[0], calls };
}
test("maintained host registers one inspection tool for exact references", async () => {
  const { provider, declaration, canvas } = await fixture();
  try {
    assert.equal(canvas.id, "cad-explorer");
    assert.equal(canvas.displayName, "CAD Explorer");
    assert.deepEqual(declaration.tools.map((tool) => tool.name), ["cad_explorer_inspect"]);
    for (const tool of declaration.tools) {
      const result = await tool.handler({ reference: "cadproto:v2:fixture" });
      assert.equal(result.resultType, "success");
      assert.equal(JSON.parse(result.textResultForLlm).reference, "cadproto:v2:fixture");
    }
    assert.ok(canvas.actions.every((action) => !action.name.startsWith("canvas.") && typeof action.handler === "function"));
    assert.equal(new Set(canvas.actions.map((action) => action.name)).size, canvas.actions.length);
    assert.deepEqual(canvas.actions.find((action) => action.name === "select_edge").inputSchema.required, ["id", "edgeId", "topologyRevision"]);
    assert.deepEqual(canvas.actions.find((action) => action.name === "set_selection_mode").inputSchema.properties.mode.enum, ["face", "edge", "part"]);
    assert.deepEqual(canvas.actions.map((action) => action.name), Object.keys(COMMANDS).filter((name) => COMMANDS[name].canvas));
    for (const action of canvas.actions) assert.deepEqual(action.inputSchema, COMMANDS[action.name].inputSchema);
  } finally { await provider.shutdown(); }
});

test("host routes actions, retains one panel per setup and waits for actual render acknowledgements", async () => {
  const { provider, canvas, calls } = await fixture();
  try {
    await canvas.open({ instanceId: "existing", input: {} });
    await assert.rejects(canvas.open({ instanceId: "duplicate", input: {} }),
      (error) => error.code === "view_already_open" && error.message.includes("existing"));
    const invoke = (name, input = {}) => canvas.actions.find((action) => action.name === name).handler({ instanceId: "existing", input });
    await invoke("get_state");
    await invoke("set_explode", { amount: 0.4, expectedRevision: 3 });
    assert.deepEqual(calls.at(-1), ["set_explode", { amount: 0.4, expectedRevision: 3 }, { rendered: true }]);
    const edge = { id: "a", edgeId: "e1", topologyRevision: "a".repeat(64) };
    await invoke("select_edge", edge);
    assert.deepEqual(calls.at(-1), ["select_edge", edge, { rendered: true }]);
    assert.equal(calls.find((item) => item[0] === "get_state")[2].rendered, false);
    assert.deepEqual(await invoke("capture_image"), { path: "capture.png" });
    for (const action of canvas.actions.filter((action) => action.name !== "capture_image")) {
      await invoke(action.name);
      assert.equal(calls.at(-1)[2].rendered, COMMANDS[action.name].render === "live", action.name);
    }
    await canvas.onClose({ instanceId: "existing" });
    await assert.rejects(invoke("get_state"), (error) => error.code === "not_open");
  } finally { await provider.shutdown(); }
});

test("missing built assets give the maintained build command and do not create a service", async () => {
  const { provider, canvas, calls } = await fixture({ missingBuild: true });
  try {
    await assert.rejects(canvas.open({ instanceId: "a", input: {} }), (error) => error.code === "not_built" && error.message.includes("npm --prefix explorer run build"));
    assert.deepEqual(calls, []);
  } finally { await provider.shutdown(); }
});

test("auto-copy canvas actions acknowledge persisted preferences during a review without rendering", { timeout: 30_000 }, async (t) => {
  const runtime = await createTestRuntime(t);
  let canvas, service;
  const viewId = "auto-copy-review";
  const provider = await startCopilotExplorer({
    joinSession: async (config) => { canvas = config.canvases[0]; return { log: async () => {} }; },
    createCanvas: (value) => value,
    CanvasError,
  }, {
    checkBuild: async () => {},
    createService: async (options) => { service = await runtime.createService(options); return service; },
  });
  try {
    await canvas.open({ instanceId: "review", input: { projectRoot: workbenchRoot, viewId } });
    assert.equal(service.getState().error, "");
    const response = await fetch(service.url + "api/reviews", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: service.getState().revision, capture: {
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
        width: 1, height: 1, camera: { position: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 42 },
      } }),
    });
    assert.equal(response.status, 200);
    const review = await response.json();
    const change = canvas.actions.find((action) => action.name === "set_auto_copy");
    const before = service.getState();
    const started = performance.now();
    const state = await change.handler({ instanceId: "review", input: { enabled: false, expectedRevision: before.revision } });
    assert.ok(performance.now() - started < 2000, "A preference-only command must not wait for rendering");
    assert.equal(state.autoCopy, false);
    assert.equal(state.activeReviewId, review.id);
    assert.equal(state.rendered, null);
    const saved = JSON.parse(await readFile(viewStateFile(runtime.runtimeRoot, service.projectRoot, viewId), "utf8"));
    assert.equal(saved.state.autoCopy, false);
    await assert.rejects(change.handler({ instanceId: "review", input: { enabled: true, expectedRevision: before.revision } }),
      (error) => error.code === "stale_view");
    // The server also protects direct clients that unnecessarily ask for a rendered acknowledgement.
    const direct = await service.execute("set_auto_copy", { enabled: true }, { rendered: true });
    assert.equal(direct.autoCopy, true);
    assert.equal(direct.activeReviewId, review.id);
  } finally { await provider.shutdown(); }
});
