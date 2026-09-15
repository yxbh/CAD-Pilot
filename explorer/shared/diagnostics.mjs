const legacyPreviewNotice = "Prototype preview: part-level RGB only; PMI, layers, materials, textures and saved views are not represented.";

export function importWarnings(warnings) {
  return warnings.filter((warning) => warning !== legacyPreviewNotice);
}
