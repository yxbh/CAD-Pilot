function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function nativeReferenceTitle(partLabel, faceId = null) {
  if (typeof partLabel !== "string" || !partLabel.trim()) throw new Error("Native reference needs a part name");
  if (faceId !== null && !/^f[1-9][0-9]*$/.test(faceId)) throw new Error("Invalid face label");
  // File-reference chips display only the last path component of slash-separated labels.
  const part = partLabel.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/]+/g, " \u00b7 ").replace(/\s+/g, " ").trim();
  const suffix = ` \u00b7 ${faceId ? `Face ${faceId}` : "Part"}`;
  const budget = 160 - suffix.length;
  return `${part.length > budget ? `${part.slice(0, budget - 3)}...` : part}${suffix}`;
}

export function nativeFileReference(filePath, title) {
  if (typeof filePath !== "string" || !filePath || /[\u0000-\u001f\u007f]/.test(filePath)) throw new Error("Invalid native reference file path");
  if (typeof title !== "string" || !title) throw new Error("Native reference needs a label");
  const label = title.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  return `<copilot-ref kind="file" target-id="${escapeAttribute(filePath)}" label="${escapeAttribute(label)}" />`;
}
