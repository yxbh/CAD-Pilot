import { createReference, referenceEntity } from "../shared/references.mjs";
import { PrototypeError } from "./protocol.mjs";

export function composerAttachment(model, state, expectedRevision) {
  if (!model || state.loading) throw new PrototypeError("not_ready", "Wait for the model to finish loading", 409);
  if (expectedRevision !== state.revision) throw new PrototypeError("stale_view", "Selection changed. Review it and add the reference again.", 409);
  if (model.topologyRevision !== state.topologyRevision) throw new PrototypeError("stale_topology", "The displayed model has changed", 409);
  if (!state.selectedIds.length) throw new PrototypeError("empty_selection", "Select a face or part first");
  const references = state.selectedIds.map((id) => {
    const faceId = state.selectedFace?.nodeId === id ? state.selectedFace.faceId : null;
    const { node, face } = referenceEntity(model, id, faceId);
    return {
      reference: createReference(model, id, faceId),
      occurrenceId: id,
      label: node.label,
      faceId,
      surfaceType: face?.surfaceType ?? null,
    };
  });
  const label = references.length === 1
    ? `${references[0].label}${references[0].faceId ? ` / Face ${references[0].faceId}` : " / Part"}`
    : `${references.length} CAD selections`;
  const cleanTitle = label.replace(/[\u0000-\u001f\u007f]/g, " ");
  return {
    type: "extension_context",
    title: cleanTitle.length > 120 ? `${cleanTitle.slice(0, 117)}...` : cleanTitle,
    payload: {
      schemaVersion: 1,
      kind: "cad-prototype-selection",
      source: { name: state.modelName, sha256: model.source.sha256 },
      topologyRevision: model.topologyRevision,
      references,
      displayOnlyExplosion: state.explode,
      inspectionTool: "cad_explorer_prototype_inspect",
    },
  };
}

export async function pushComposerAttachment(session, attachment, instanceId) {
  const api = session?.rpc?.extensions;
  if (typeof api?.sendAttachmentsToMessage !== "function") {
    throw new PrototypeError("composer_unavailable", "This Copilot version cannot add reference attachments. Use Copy text under Reference text instead.", 409);
  }
  await api.sendAttachmentsToMessage({ instanceId, attachments: [attachment] });
}
