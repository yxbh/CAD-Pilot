const tokenPattern = /^cadproto:v2:([a-f0-9]{64})\/([A-Za-z0-9._~!%*'()-]+)\/(part|f[1-9][0-9]*)$/;
const oneLine = (text) => {
  const value = String(text).replace(/[\u0000-\u001f\u007f]/g, " ");
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
};

export function parseReference(text) {
  if (typeof text !== "string" || text.length > 16_384) throw new Error("Supply one copied CAD prototype reference");
  const candidates = text.split(/\r?\n/).map((line) => line.trim().replace(/^`|`$/g, "")).filter((line) => line.startsWith("cadproto:"));
  if (candidates.length !== 1) throw new Error("Expected exactly one cadproto reference line");
  const match = tokenPattern.exec(candidates[0]);
  if (!match) throw new Error("Invalid CAD prototype reference format or version");
  let nodeId;
  try { nodeId = decodeURIComponent(match[2]); }
  catch { throw new Error("Invalid occurrence encoding in CAD reference"); }
  if (!nodeId || nodeId.length > 4096 || encodeURIComponent(nodeId) !== match[2]) throw new Error("Invalid occurrence identity");
  return { topologyRevision: match[1], nodeId, faceId: match[3] === "part" ? null : match[3] };
}

export function referenceEntity(model, nodeId, faceId = null) {
  const node = model.nodes.find((item) => item.id === nodeId && item.partId);
  if (!node) throw new Error("Reference occurrence is not present in this model");
  const part = model.parts.find((item) => item.id === node.partId);
  if (!part) throw new Error("Reference geometry is unavailable");
  const face = faceId === null ? null : part.faces.find((item) => item.id === faceId);
  if (faceId !== null && !face) throw new Error("Reference face is not present on this occurrence");
  return { node, part, face };
}

export function createReference(model, nodeId, faceId = null) {
  if (!/^[a-f0-9]{64}$/.test(model.topologyRevision)) throw new Error("Model topology identity is unavailable");
  referenceEntity(model, nodeId, faceId);
  const reference = `cadproto:v2:${model.topologyRevision}/${encodeURIComponent(nodeId)}/${faceId ?? "part"}`;
  parseReference(reference);
  return reference;
}

export function formatSelection(model, nodeId, faceId = null) {
  const { node, face } = referenceEntity(model, nodeId, faceId);
  const entity = face ? `Face ${face.id} (${face.surfaceType}, ${face.area.toFixed(2)} mm^2)` : "Whole part";
  return `CAD Explorer | ${oneLine(model.source.name)} | ${oneLine(node.label)} | ${entity}\n${createReference(model, nodeId, faceId)}`;
}
