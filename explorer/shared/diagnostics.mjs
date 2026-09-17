const legacyPreviewNotice = "Prototype preview: part-level RGB only; PMI, layers, materials, textures and saved views are not represented.";

// Apply only at the validated model boundary. Old logs deduplicated edge IDs
// across parts and never counted triangles, so neither historical count is known.
export function importDiagnostics(model) {
  const cleanup = { ...(model.cleanup ?? { degenerateEdges: 0, zeroAreaTriangles: 0 }) };
  const warnings = model.warnings.filter((warning) => {
    if (warning === legacyPreviewNotice) return false;
    if (model.cleanup === undefined) {
      if (/^Degenerate CAD edge e[1-9][0-9]* was omitted from edge selection\.$/.test(warning)) {
        cleanup.degenerateEdges = null;
        return false;
      }
      if (warning === "Zero-area tessellation triangles were omitted.") {
        cleanup.zeroAreaTriangles = null;
        return false;
      }
    }
    return true;
  });
  return { warnings, cleanup };
}
