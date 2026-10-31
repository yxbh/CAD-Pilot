// What an agent needs after a load or view action, in a few hundred bytes. The full state stays available on request.
const round = (value) => Math.round(value * 1000) / 1000;
const listed = (names, limit = 20) => names.length > limit ? [...names.slice(0, limit), `+${names.length - limit} more`] : names;

export function revisionLabel(sha256) {
  return sha256 ? sha256.slice(0, 12) : "";
}

export function stateSummary(state, { url, changedOnDisk = false } = {}) {
  const labels = new Map(state.parts.map((part) => [part.id, part.label]));
  const name = (id) => labels.get(id) ?? id;
  const steps = state.assembly?.steps ?? [];
  const { viewers, seen, headless, drawn } = state.renderers;
  const selected = state.selectedIds.map((id) => state.selectedFace?.nodeId === id ? `${name(id)} face ${state.selectedFace.faceId}`
    : state.selectedEdge?.nodeId === id ? `${name(id)} edge ${state.selectedEdge.edgeId}` : name(id));
  const view = {
    revision: state.revision,
    camera: state.cameraPinned ? "moved by the user" : state.cameraPreset,
    projection: state.projection,
    appearance: state.appearance === "studio" ? `studio ${state.materialFinish}` : "inspect",
    ...(state.showEdges ? {} : { outlines: false }),
    ...(state.explode ? { explode: { amount: state.explode, direction: state.direction, ...(state.fixedId ? { fixed: name(state.fixedId) } : {}) } } : {}),
    ...(state.step !== null ? { step: `${state.step} of ${steps.length}${state.step ? `: ${steps[state.step - 1]?.title ?? ""}` : ""}`, stepMode: state.stepMode } : {}),
    section: state.section.enabled ? { axis: state.section.axis, position: round(state.section.position), flipped: state.section.flipped } : "off",
    ...(state.hiddenIds.length ? { hidden: listed(state.hiddenIds.map(name)) } : {}),
    ...(selected.length ? { selected: listed(selected) } : {}),
    ...(state.viewKept !== null ? { kept: state.viewKept } : {}),
  };
  let note = "";
  if (!state.modelName || state.loading) note = state.loading ? "The model is still loading." : "";
  else if (!viewers) note = `No viewer page is open${drawn === "headless" ? "; the view was drawn in the background" : ""}. Open ${url} to see it.`;
  else if (!seen) note = "An open viewer page has not drawn this revision yet; it may be hidden or in the background.";
  if (changedOnDisk) note = `${state.source.file} changed on disk after it was loaded; run open again to show the new file. ${note}`.trim();
  return {
    application: "CAD Explorer",
    url,
    model: state.modelName ? {
      name: state.modelName,
      ...(state.source.file ? { file: state.source.file } : {}),
      revision: revisionLabel(state.documentRevision),
      ...(state.source.generatedAt ? { generatedAt: state.source.generatedAt } : {}),
      parts: state.parts.length,
      ...(changedOnDisk ? { changedOnDisk: true } : {}),
    } : null,
    loading: state.loading,
    ...(state.error ? { error: state.error } : {}),
    view,
    shown: { viewers, seen, drawn, headless },
    ...(state.assembly ? {
      assembly: {
        steps: steps.length,
        ...(state.assembly.error ? { error: state.assembly.error } : {}),
        ...(state.assembly.stale ? { stale: true } : {}),
        ...(steps.some((step) => step.unresolved.length) ? { unresolved: [...new Set(steps.flatMap((step) => step.unresolved))] } : {}),
      },
    } : {}),
    ...(state.activeReviewId ? { review: state.activeReviewId } : {}),
    ...(note ? { note } : {}),
  };
}
