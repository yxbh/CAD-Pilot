import assert from "node:assert/strict";
import test from "node:test";
import { composerAttachment, pushComposerAttachment } from "../server/composer.mjs";
import { initialState } from "../server/protocol.mjs";
import { parseReference } from "../shared/references.mjs";

const model = {
  source: { name: "Cached filename.step", sha256: "a".repeat(64) },
  topologyRevision: "b".repeat(64),
  nodes: [{ id: "root/cover", partId: "cover", label: "Cover plate" }],
  parts: [{ id: "cover", faces: [{ id: "f6", surfaceType: "plane" }] }],
};
const state = {
  ...initialState(), revision: 9, modelName: "Current document.step",
  topologyRevision: model.topologyRevision, selectedIds: ["root/cover"],
  selectedFace: { nodeId: "root/cover", faceId: "f6" }, explode: 0.5,
};

test("native attachment carries the exact face identity and a readable composer title", () => {
  const attachment = composerAttachment(model, state, 9);
  assert.equal(attachment.type, "extension_context");
  assert.equal(attachment.title, "Cover plate / Face f6");
  assert.equal(attachment.payload.source.name, state.modelName);
  assert.equal(attachment.payload.source.sha256, model.source.sha256);
  assert.equal(attachment.payload.displayOnlyExplosion, 0.5);
  assert.deepEqual(parseReference(attachment.payload.references[0].reference), {
    nodeId: "root/cover", faceId: "f6", topologyRevision: model.topologyRevision,
  });
  assert.equal(attachment.payload.inspectionTool, "cad_explorer_prototype_inspect");
  assert.equal("extensionId" in attachment, false);
});

test("draft attachment uses the extension API, binds the owning panel, and never sends a turn", async () => {
  const calls = [];
  const session = {
    send() { throw new Error("Must not send the draft"); },
    rpc: { extensions: { async sendAttachmentsToMessage(payload) { calls.push(payload); } } },
  };
  const attachment = composerAttachment(model, state, 9);
  await pushComposerAttachment(session, attachment, "example-panel");
  assert.deepEqual(calls, [{ instanceId: "example-panel", attachments: [attachment] }]);
});

test("native attachment rejects stale or empty selection and propagates unsupported-host errors", async () => {
  assert.throws(() => composerAttachment(model, state, 8), /Selection changed/);
  assert.throws(() => composerAttachment(model, { ...state, selectedIds: [] }, 9), /Select a face/);
  assert.throws(() => composerAttachment(model, { ...state, loading: true }, 9), /finish loading/);
  assert.throws(() => composerAttachment(model, { ...state, topologyRevision: "c".repeat(64) }, 9), /model has changed/);
  await assert.rejects(pushComposerAttachment({}, {}, "panel"), /Copy text/);
  await assert.rejects(pushComposerAttachment({
    rpc: { extensions: { async sendAttachmentsToMessage() { throw new Error("Host refused attachment"); } } },
  }, {}, "panel"), /Host refused/);
});
