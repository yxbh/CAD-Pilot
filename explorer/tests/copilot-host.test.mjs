import assert from "node:assert/strict";
import test from "node:test";
import { startCopilotExplorer } from "../hosts/copilot.mjs";
import { workbenchRoot } from "../server/paths.mjs";

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
test("maintained host registers the legacy inspect alias without changing its exact-reference result", async () => {
  const { provider, declaration, canvas } = await fixture();
  try {
    assert.equal(canvas.id, "cad-explorer");
    assert.equal(canvas.displayName, "CAD Explorer");
    assert.deepEqual(declaration.tools.map((tool) => tool.name), ["cad_explorer_inspect", "cad_explorer_prototype_inspect"]);
    for (const tool of declaration.tools) {
      const result = await tool.handler({ reference: "cadproto:v2:fixture" });
      assert.equal(result.resultType, "success");
      assert.equal(JSON.parse(result.textResultForLlm).reference, "cadproto:v2:fixture");
    }
    assert.ok(canvas.actions.every((action) => !action.name.startsWith("canvas.") && typeof action.handler === "function"));
    assert.equal(new Set(canvas.actions.map((action) => action.name)).size, canvas.actions.length);
    assert.deepEqual(canvas.actions.find((action) => action.name === "select_edge").inputSchema.required, ["id", "edgeId", "topologyRevision"]);
    assert.deepEqual(canvas.actions.find((action) => action.name === "set_selection_mode").inputSchema.properties.mode.enum, ["face", "edge", "part"]);
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
