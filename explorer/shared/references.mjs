const number = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,3})?";
const tokenPattern = new RegExp(`^cadproto:v2:([a-f0-9]{64})\\/([A-Za-z0-9._~!%*'()-]+)\\/(part|[fe][1-9][0-9]*|t(?:0|[1-9][0-9]*)@${number},${number},${number})$`);
const oneLine = (text) => {
  const value = String(text).replace(/[\u0000-\u001f\u007f]/g, " ");
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
};
// Picked points are part-local millimetres to the micrometre; -0 prints as 0.
export const roundPoint = (point) => point.map((value) => Math.round(value * 1000) / 1000 || 0);
const pointText = (point) => roundPoint(point).map((value) => String(value)).join(",");

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
  const entity = match[3];
  const point = entity.startsWith("t") ? {
    triangle: Number(entity.slice(1, entity.indexOf("@"))),
    point: entity.slice(entity.indexOf("@") + 1).split(",").map(Number),
  } : null;
  if (point && !Number.isSafeInteger(point.triangle)) throw new Error("Invalid triangle in CAD reference");
  return {
    topologyRevision: match[1], nodeId, point,
    faceId: entity.startsWith("f") ? entity : null, edgeId: entity.startsWith("e") ? entity : null,
  };
}

// A triangle count without needing a mesh's geometry: meshes record it, STEP previews derive it from their face map.
export function triangleCount(part) {
  if (Number.isSafeInteger(part.triangleCount)) return part.triangleCount;
  const last = part.faces?.at(-1);
  return last ? last.triangleStart + last.triangleCount : 0;
}

export function referenceEntity(model, nodeId, faceId = null, edgeId = null, point = null) {
  if ([faceId, edgeId, point].filter((value) => value !== null).length > 1) throw new Error("Select a face, an edge or a point, not more than one");
  const node = model.nodes.find((item) => item.id === nodeId && item.partId);
  if (!node) throw new Error("Reference occurrence is not present in this model");
  const part = model.parts.find((item) => item.id === node.partId);
  if (!part) throw new Error("Reference geometry is unavailable");
  const face = faceId === null ? null : part.faces.find((item) => item.id === faceId);
  if (faceId !== null && !face) throw new Error("Reference face is not present on this occurrence");
  const edge = edgeId === null ? null : part.edges?.find((item) => item.id === edgeId);
  if (edgeId !== null && !edge) throw new Error("Reference edge is not present on this occurrence");
  if (point !== null && (!Number.isSafeInteger(point.triangle) || point.triangle < 0 || point.triangle >= triangleCount(part) ||
      !Array.isArray(point.point) || point.point.length !== 3 || !point.point.every(Number.isFinite))) {
    throw new Error("Reference point is not on a triangle of this occurrence");
  }
  return { node, part, face, edge, point };
}

// Views that combine several files mint references against the file a node came from, so they resolve
// whatever else was shown with it.
export function referenceTarget(model, nodeId) {
  const node = model.nodes.find((item) => item.id === nodeId);
  const document = node?.documentId && model.documents?.find((item) => item.id === node.documentId);
  return document ? { topologyRevision: document.topologyRevision, nodeId: node.sourceId, sourceName: document.name }
    : { topologyRevision: model.topologyRevision, nodeId, sourceName: model.source.name };
}

export function createReference(model, nodeId, faceId = null, edgeId = null, point = null) {
  referenceEntity(model, nodeId, faceId, edgeId, point);
  const target = referenceTarget(model, nodeId);
  if (!/^[a-f0-9]{64}$/.test(target.topologyRevision ?? "")) throw new Error("Model topology identity is unavailable");
  const entity = faceId ?? edgeId ?? (point ? `t${point.triangle}@${pointText(point.point)}` : "part");
  const reference = `cadproto:v2:${target.topologyRevision}/${encodeURIComponent(target.nodeId)}/${entity}`;
  parseReference(reference);
  return reference;
}

// A readable summary line followed by the exact address; parseReference accepts the whole text.
export function describeSelection(sourceName, partLabel, face, edge, reference, point = null) {
  const entity = face ? `Face ${face.id} (${face.surfaceType}, ${face.area.toFixed(2)} mm^2)`
    : edge ? `Edge ${edge.id} (${edge.curveType}, ${edge.length.toFixed(2)} mm)`
      : point ? `Point on triangle ${point.triangle} (${roundPoint(point.point).map((value) => value.toFixed(3)).join(", ")} mm, part frame)` : "Whole part";
  return `CAD Explorer | ${oneLine(sourceName)} | ${oneLine(partLabel)} | ${entity}\n${reference}`;
}

export function formatSelection(model, nodeId, faceId = null, edgeId = null, point = null) {
  const { node, face, edge } = referenceEntity(model, nodeId, faceId, edgeId, point);
  return describeSelection(referenceTarget(model, nodeId).sourceName, node.label, face, edge, createReference(model, nodeId, faceId, edgeId, point), point);
}
