import { analysisReport } from "../shared/analysis.mjs";

// What an agent needs after a load or view action, in a few hundred bytes. The full state stays available on request.
const round = (value) => Math.round(value * 1000) / 1000;
const listed = (names, limit = 20) => names.length > limit ? [...names.slice(0, limit), `+${names.length - limit} more`] : names;

export function revisionLabel(sha256) {
  return sha256 ? sha256.slice(0, 12) : "";
}

// The camera as every answer reports it: the preset or angle it was fitted to, its projection and, from the camera that
// drew the view, viewHeight, the view's height in millimetres at the target.
export function cameraSummary(state, drawn) {
  return {
    view: state.cameraPinned ? "moved by the user" : state.cameraPreset, projection: state.projection,
    ...(drawn?.viewHeight ? { viewHeight: drawn.viewHeight } : {}),
  };
}

// drawnCamera: the camera of the renderer that drew the current revision, if one has; drawnAnalysis: the numbers its
// analysis legend printed.
export function stateSummary(state, { url, changedOnDisk = false, problem = "", drawnCamera, drawnAnalysis } = {}) {
  const labels = new Map(state.parts.map((part) => [part.id, part.label]));
  const name = (id) => labels.get(id) ?? id;
  const steps = state.assembly?.steps ?? [];
  const { viewers, seen, headless, drawn } = state.renderers;
  const selected = state.selectedIds.map((id) => state.selectedFace?.nodeId === id ? `${name(id)} face ${state.selectedFace.faceId}`
    : state.selectedEdge?.nodeId === id ? `${name(id)} edge ${state.selectedEdge.edgeId}`
      : state.selectedPoint?.nodeId === id ? `${name(id)} point ${state.selectedPoint.point.join(", ")}` : name(id));
  // How each mesh was read, and where the files of a view of several sit.
  const files = state.documents ?? [];
  const file = (entry) => ({
    id: entry.id, name: entry.name, ...(entry.frame ? { frame: entry.frame } : {}),
    ...(entry.style !== "solid" ? { style: entry.style } : {}),
    ...(entry.offset.some(Boolean) ? { offset: entry.offset } : {}),
    ...(entry.rotate.some(Boolean) ? { rotate: entry.rotate } : {}),
  });
  const analysis = analysisReport(state.analysis, drawnAnalysis);
  const view = {
    revision: state.revision,
    camera: cameraSummary(state, drawnCamera),
    appearance: state.appearance === "inspect" ? "inspect" : `${state.appearance} ${state.materialFinish}`,
    ...(state.showEdges ? {} : { outlines: false }),
    ...(state.explode ? { explode: { amount: state.explode, direction: state.direction, ...(state.fixedId ? { fixed: name(state.fixedId) } : {}) } } : {}),
    ...(state.step !== null ? { step: `${state.step} of ${steps.length}${state.step ? `: ${steps[state.step - 1]?.title ?? ""}` : ""}`, stepMode: state.stepMode } : {}),
    section: state.section.enabled ? { axis: state.section.axis, position: round(state.section.position), flipped: state.section.flipped } : "off",
    ...(state.hiddenIds.length ? { hidden: listed(state.hiddenIds.map(name)) } : {}),
    ...(selected.length ? { selected: listed(selected) } : {}),
    ...(state.showFaults ? { faults: "shown" } : {}),
    ...(analysis ? { analysis } : {}),
    ...(files.length > 1 ? { files: files.map(file), layout: state.layout } : {}),
    ...(state.viewKept !== null ? { kept: state.viewKept } : {}),
  };
  let note = "";
  if (!state.modelName || state.loading) note = state.loading ? "The model is still loading." : "";
  else if (problem && !drawn) note = `The model loaded, but no renderer could draw it: ${problem}${problem.includes(url) ? "" : ` Open ${url} to see it.`}`;
  else if (!viewers) note = `No viewer page is open${drawn === "headless" ? "; the view was drawn in the background" : ""}. Open ${url} to see it.`;
  else if (!seen) note = "An open viewer page has not drawn this revision yet; it may be hidden or in the background.";
  if (changedOnDisk) note = `${state.source.file} changed on disk after it was loaded; run open again to show the new file. ${note}`.trim();
  // Added files whose copy was gone from Explorer's storage and that could not be read again from the project.
  const dropped = state.droppedFiles ?? [];
  if (dropped.length) {
    const how = (entry) => !entry.file ? `${entry.name}: it was uploaded, so upload it again`
      : entry.reason === "missing" ? `${entry.name}: ${entry.file} is no longer in the project, so ask where it is now and add that with add_file`
        : entry.reason === "changed" ? `${entry.name}: ${entry.file} has changed since it was added, and add_file file=${entry.file} would show what it holds now`
          : `${entry.name}: add it back with add_file file=${entry.file}`;
    note = `Left out of the view because Explorer no longer has a copy (${dropped.map(how).join("; ")}). ${note}`.trim();
  }
  return {
    application: "CAD Explorer",
    url,
    model: state.modelName ? {
      name: state.modelName,
      ...(state.source.file ? { file: state.source.file } : {}),
      revision: revisionLabel(state.source.sha256),
      ...(state.source.generatedAt ? { generatedAt: state.source.generatedAt } : {}),
      parts: state.parts.length,
      ...(files.length === 1 && files[0].frame ? { frame: files[0].frame } : {}),
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
