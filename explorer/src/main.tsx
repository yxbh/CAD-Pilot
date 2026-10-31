import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Scene from "./Scene.tsx";
import { newestState, type Model, type ViewState } from "./model.ts";
import { createDesktopHost, type CameraState, type ViewerHost } from "./host.ts";
import { useReviews } from "./useReviews.ts";
import { useSelection } from "./useSelection.ts";
import { useViewCapture } from "./useViewCapture.ts";
import { useSectionControl } from "./useSectionControl.ts";
import { useStepPlayer } from "./useStepPlayer.ts";
import { useArrangedModel } from "./useArrangedModel.ts";
import DrawingReview from "./drawing/DrawingReview.tsx";
import { HeadlessApp } from "./HeadlessApp.tsx";
import {
  Box, Camera, Copy, Crosshair, Expand, Eye, EyeOff, FilePlus, FolderOpen, Ghost, ListOrdered,
  Maximize, MousePointer2, PanelRight, Pencil, Pin, RotateCcw, ScanFace, Square, X, Sun, Glasses, SlidersHorizontal, Spline,
  Slice, TriangleAlert, ScanSearch,
} from "lucide-react";
import { MODEL_EXTENSIONS } from "../shared/mesh.mjs";
import { axisViews, type ViewPreset } from "./camera.ts";
import { IconButton } from "./ui/IconButton";
import { ImportWarnings } from "./ui/ImportWarnings.tsx";
import { SectionPanel } from "./ui/SectionPanel.tsx";
import { AssemblyPanel } from "./ui/AssemblyPanel.tsx";
import { AnalysisPanel } from "./ui/AnalysisPanel.tsx";
import { analysisSummary } from "../shared/analysis.mjs";
import "./style.css";

class ViewerBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    return this.state.error ? <div className="viewport-error" role="alert">Unable to render: {this.state.error}. Reload the canvas after correcting the problem.</div> : this.props.children;
  }
}

export function App({ host }: { host: ViewerHost }) {
  const [state, setState] = useState<ViewState | null>(null);
  const [composed, setModel] = useState<Model | null>(null);
  const [error, setError] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [notice, setNotice] = useState("");
  const [amount, setAmount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [treeOpen, setTreeOpen] = useState(() => window.innerWidth >= 760);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [warningsTarget, setWarningsTarget] = useState<HTMLDivElement | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const referenceField = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // One file picker serves Open and Add file; this says which the next pick is for.
  const addingFile = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(state);
  const acceptState = useCallback((incoming: ViewState) => {
    const accepted = newestState(latest.current, incoming);
    latest.current = accepted;
    setState(accepted);
  }, []);
  const reportError = useCallback((message: string) => { setError(message); }, []);
  const reportReviewError = useCallback((message: string) => { setReviewError(message); }, []);
  const reviews = useReviews(host, state?.activeReviewId ?? null, reportReviewError);
  const { registerCapture, onCapture, beginDrawing, changingMode } = useViewCapture({ host, latest, queue, reviews, onError: reportError });

  const run = useCallback((name: string, input: object = {}, onFailure?: (failure: Error) => void) => {
    setError("");
    const next = queue.current.then(() => host.command(name, { ...input, expectedRevision: latest.current?.revision }));
    const accepted = next.then((incoming) => {
      acceptState(incoming);
      setError("");
    });
    queue.current = accepted.catch((failure: Error) => {
      setError(failure.message);
      onFailure?.(failure);
    });
    return queue.current;
  }, [host, acceptState]);
  const model = useArrangedModel(composed, state);
  const { select, copySelection, setAutoCopy, copyStatus, autoCopyEnabled, autoCopyPending, dismissCopyStatus } = useSelection({
    host, model, state, latest, run, onError: reportError,
  });
  const section = useSectionControl({ model, state, amount, latest, queue, run, onError: reportError });
  const player = useStepPlayer({ state, run });

  useEffect(() => {
    let active = true;
    const unsubscribe = host.subscribe({
      onConnection: setConnected,
      onState: (incoming) => { if (active) acceptState(incoming); },
      onError: (failure) => setError(failure.message),
      onCapture,
    });
    void host.getState().then((value) => { if (active) acceptState(value); }, (failure: Error) => setError(failure.message));
    return () => { active = false; unsubscribe(); };
  }, [host, acceptState, onCapture]);

  useEffect(() => {
    if (!state?.topologyRevision) return;
    let active = true;
    void host.loadModel().then((value) => { if (active) setModel(value); }, (failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [host, state?.topologyRevision, state?.modelName]);
  useEffect(() => { if (state) setAmount(state.explode); }, [state?.explode]);

  async function upload(file: File, add = false) {
    setError("");
    try {
      await host.upload(file, add);
      setNotice(`${add ? "Added" : "Loaded"} a local snapshot. Your original file is unchanged.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function captureImage() {
    try {
      const result = await host.captureImage();
      setNotice(`Screenshot saved: ${result.path}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  const saveCamera = useCallback((camera: CameraState) => {
    if (!latest.current || latest.current.activeReviewId) return;
    void run("save_camera", { camera, topologyRevision: latest.current.topologyRevision });
  }, [run]);
  const chooseView = useCallback((preset: ViewPreset) => { void run("set_view", { preset }); }, [run]);
  const rendered = useCallback((report: Parameters<ViewerHost["reportRendered"]>[0]) => host.reportRendered(report), [host]);
  const leaves = model?.nodes.filter((node) => node.partId) || [];
  const selected = leaves.find((node) => state?.selectedIds.includes(node.id));
  const selectedPart = model?.parts.find((part) => part.id === selected?.partId);
  const selectedFace = selectedPart?.faces.find((face) => face.id === state?.selectedFace?.faceId);
  const selectedEdge = selectedPart?.edges?.find((edge) => edge.id === state?.selectedEdge?.edgeId);
  const selectedPoint = state?.selectedPoint?.nodeId === selected?.id ? state?.selectedPoint ?? undefined : undefined;
  const selectionName = state?.selectionMode ?? "face";
  const meshParts = model?.parts.filter((part) => part.buffers) ?? [];
  const triangles = meshParts.reduce((sum, part) => sum + (part.triangleCount ?? 0), 0);
  const documents = state?.documents ?? [];
  const referenceText = copyStatus.text;
  const ready = model && state && model.topologyRevision === state.topologyRevision && model.source.name === state.modelName;
  const loading = !state || state.loading;
  const busy = loading || !ready;
  const drawingActive = reviews.active;
  const activeReview = reviews.review;
  // The revision is the main file's own SHA-256, as the agent's summary reports it; other files in the view do not change it.
  const sha256 = state?.source.sha256 ?? "";
  const revision = sha256.slice(0, 12);
  const generated = state?.source.generatedAt ? new Date(state.source.generatedAt) : null;
  useEffect(() => {
    if (copyStatus.kind !== "blocked") return;
    referenceField.current?.focus({ preventScroll: true });
    referenceField.current?.select();
  }, [copyStatus, referenceText]);
  return (
    <main className={`app${drawingActive ? " is-drawing" : ""}`} data-view-controls="studio-projection">
      <header className="app-header">
        <span className="app-symbol" title="CAD Explorer"><Box size={22} strokeWidth={1.6} aria-hidden="true" /></span>
        <div className="document-heading">
          <strong title={activeReview?.source.name || state?.modelName}>{activeReview?.source.name || state?.modelName || "Opening assembly"}</strong>
          <span>{drawingActive ? "Drawing review" : `${leaves.length} parts${triangles ? ` \u00b7 ${triangles.toLocaleString()} mesh triangles` : ""} \u00b7 mm`}<span className="version-tag">v1</span></span>
          {!drawingActive && revision && <span className="model-revision" data-revision={sha256}
            title={`Revision ${sha256}${state?.source.file ? ` from ${state.source.file}` : ""}${generated ? `, generated ${generated.toLocaleString()}` : ""}`}>
            rev {revision}{generated && ` \u00b7 ${generated.toDateString() === new Date().toDateString() ? generated.toLocaleTimeString() : generated.toLocaleString()}`}
          </span>}
        </div>
        <select className="review-select" aria-label="Saved reviews" title="Saved reviews" value={activeReview?.id ?? ""}
          disabled={reviews.saving || reviews.working || changingMode} onChange={(event) => {
            if (event.target.value) void reviews.open(event.target.value).catch((failure: Error) => setError(failure.message));
            else void reviews.close();
          }}>
          <option value="">Live model</option>
          {reviews.items.map((review) => <option key={review.id} value={review.id}>{review.title} ({review.strokeCount} marks)</option>)}
        </select>
        {!drawingActive && !busy && model && <ImportWarnings
          key={`${model.topologyRevision}:${model.source.name}`} warnings={model.warnings} cleanup={model.cleanup} sourceName={model.source.name}
          target={warningsTarget} onOpen={() => setNotice("")} />}
        <IconButton label="Open a STEP or mesh file" icon={FolderOpen} onClick={() => { addingFile.current = false; fileInput.current?.click(); }} disabled={loading || drawingActive} />
        <IconButton label="Add a file to compare" icon={FilePlus} onClick={() => { addingFile.current = true; fileInput.current?.click(); }} disabled={busy || drawingActive} />
        <IconButton label="Toggle parts panel" icon={PanelRight} aria-pressed={treeOpen} onClick={() => setTreeOpen(!treeOpen)} />
        <input ref={fileInput} hidden type="file" accept={MODEL_EXTENSIONS.join(",")} onChange={(event) => {
          const file = event.target.files?.[0]; if (file) void upload(file, addingFile.current); event.target.value = "";
        }} />
      </header>
      <section className="mode-toolbar" aria-label={drawingActive ? "Draw toolbar" : "Model toolbar"}>
        <IconButton label={drawingActive ? "Back to model" : "Draw"} icon={drawingActive ? MousePointer2 : Pencil}
          aria-pressed={drawingActive} disabled={changingMode || reviews.working || (!drawingActive && busy)}
          onClick={() => { if (drawingActive) void reviews.close(); else void beginDrawing(); }} />
        <div className="mode-separator" role="separator" aria-orientation="vertical" aria-label="Drawing and view tools" />
        <div className="toolbar-slot" ref={setToolbarTarget}>
          {!drawingActive && <div className="model-toolbar">
            <div className="tool-group" role="group" aria-label="Camera views">
              <IconButton label="Isometric view" icon={Box} onClick={() => run("set_view", { preset: "iso" })} />
              {axisViews.map((axis) => <IconButton key={axis.id} label={axis.label} onClick={() => chooseView(axis.id)}
                className="axis-view" style={{ color: axis.color }}><span aria-hidden="true">{axis.axis}</span></IconButton>)}
              <IconButton label="Fit assembly" icon={Maximize} onClick={() => run("fit_view")} />
            </div>
            <div className="tool-group" role="group" aria-label="Projection">
              <IconButton label="Perspective projection" icon={Box} aria-pressed={state?.projection === "perspective"}
                onClick={() => run("set_projection", { projection: "perspective" })} />
              <IconButton label="Orthographic projection (parallel)" icon={Square} aria-pressed={state?.projection === "orthographic"}
                onClick={() => run("set_projection", { projection: "orthographic" })} />
            </div>
            <div className="tool-group" role="group" aria-label="Appearance">
              <IconButton label="Inspect appearance" icon={Glasses} aria-pressed={state?.appearance === "inspect"}
                onClick={() => run("set_appearance", { mode: "inspect" })} />
              <IconButton label="Studio appearance" icon={Sun} aria-pressed={state?.appearance === "studio" || state?.appearance === "raytraced"}
                onClick={() => run("set_appearance", { mode: "studio" })} />
              <IconButton label="Appearance settings" icon={SlidersHorizontal} aria-expanded={appearanceOpen}
                onClick={() => { setAppearanceOpen(!appearanceOpen); section.setOpen(false); setAnalysisOpen(false); }} />
            </div>
            <div className="tool-group" role="group" aria-label="Section view">
              <IconButton label="Section view" icon={Slice} aria-expanded={section.open}
                className={state?.section.enabled ? "section-active" : ""}
                onClick={() => { section.setOpen(!section.open); setAppearanceOpen(false); setAnalysisOpen(false); }} />
            </div>
            <div className="tool-group" role="group" aria-label="Analysis views">
              <IconButton label="Analysis views: overhangs, wall thickness, curvature, zebra stripes, triangle edges, back faces and normals" icon={ScanSearch}
                aria-expanded={analysisOpen} className={state && analysisSummary(state.analysis) ? "section-active" : ""}
                onClick={() => { setAnalysisOpen(!analysisOpen); setAppearanceOpen(false); section.setOpen(false); }} />
            </div>
            <div className="tool-group" role="group" aria-label="Selection mode">
              <IconButton label="Faces" icon={ScanFace} aria-pressed={state?.selectionMode === "face"} onClick={() => run("set_selection_mode", { mode: "face" })} />
              <IconButton label="Edges" icon={Spline} aria-pressed={state?.selectionMode === "edge"} onClick={() => run("set_selection_mode", { mode: "edge" })} />
              <IconButton label="Points" icon={Crosshair} aria-pressed={state?.selectionMode === "point"} onClick={() => run("set_selection_mode", { mode: "point" })} />
              <IconButton label="Parts" icon={Box} aria-pressed={state?.selectionMode === "part"} onClick={() => run("set_selection_mode", { mode: "part" })} />
            </div>
            {meshParts.length > 0 && <div className="tool-group" role="group" aria-label="Mesh faults">
              <IconButton label="Mesh faults: open, over-shared and flipped edges, zero-area triangles" icon={TriangleAlert}
                aria-pressed={state?.showFaults} onClick={() => run("set_faults", { visible: !state?.showFaults })} />
            </div>}
            <div className="tool-group">
              <IconButton label="Capture image" icon={Camera} disabled={busy} onClick={() => void captureImage()} />
              <IconButton label="Show all" icon={Eye} onClick={() => run("show_all")} />
            </div>
          </div>}
        </div>
      </section>
      {appearanceOpen && !drawingActive && <div className="appearance-popover" role="dialog" aria-label="Appearance settings"
        onKeyDown={(event) => { if (event.key === "Escape") setAppearanceOpen(false); }}>
        <div className="panel-heading"><strong>Appearance</strong><IconButton label="Close appearance settings" icon={X} onClick={() => setAppearanceOpen(false)} /></div>
        <label>Finish <select aria-label="Studio finish" disabled={state?.appearance === "inspect"} value={state?.materialFinish ?? "matte"}
          onChange={(event) => run("set_appearance", { finish: event.target.value })}>
          <option value="matte">Matte</option><option value="plastic">Plastic</option><option value="satin">Satin metal</option>
          <option value="polished">Polished metal</option><option value="rubber">Rubber</option>
        </select></label>
        <label><input type="checkbox" checked={state?.showEdges ?? true} onChange={(event) => run("set_appearance", { showEdges: event.target.checked })} /> Outlines</label>
        <label><input type="checkbox" checked={state?.appearance === "raytraced"}
          onChange={(event) => run("set_appearance", { mode: event.target.checked ? "raytraced" : "studio" })} /> Ray traced</label>
        <p>Visual finish only. STEP colors and geometry are unchanged. Ray traced path-traces Studio's light and finishes, refining as it goes.</p>
      </div>}
      {section.open && !drawingActive && <SectionPanel control={section} busy={busy} />}
      {analysisOpen && !drawingActive && state && <AnalysisPanel analysis={state.analysis} busy={busy}
        apply={(input) => void run("set_analysis", input)} onClose={() => setAnalysisOpen(false)} />}
      <section className={`workspace${treeOpen ? "" : " panel-closed"}`}>
        <div className="import-warnings-layer" ref={setWarningsTarget} />
        <div className="viewport">
          <div className="live-scene" aria-hidden={drawingActive} inert={drawingActive}>
          {ready ? (
            <ViewerBoundary key={state.topologyRevision}>
              <Scene model={model} state={state} amount={amount} stepPosition={player.position} sectionPosition={section.position} active={!drawingActive} onSelect={select}
                onError={reportError} registerCapture={registerCapture} onRendered={rendered} onCameraChange={saveCamera} onView={chooseView} />
            </ViewerBoundary>
          ) : <div className="empty">{state?.error ? "No model to display. Open a STEP or mesh file to retry." : "Preparing the model..."}</div>}
          </div>
          {ready && !drawingActive && <AssemblyPanel state={state} player={player} busy={busy} run={run} />}
          {drawingActive && <div className="drawing-layer">
            {activeReview ? (
              <DrawingReview review={activeReview} onChange={reviews.onChange} onClose={() => void reviews.close()}
                onCopyImage={reviews.copyImage} onSaveImage={() => { void reviews.saveImage().then((file) => { if (file) setNotice(`Marked image saved: ${file}`); }); }}
                onError={reportError} status={reviews.status} saving={reviews.saving} readOnly={reviews.working} toolbarTarget={toolbarTarget} />
            ) : <div className="review-loading" role="status">Loading review...</div>}
          </div>}
          {!drawingActive && (loading || (!ready && !state?.error)) && <div className="loading" role="status"><span className="spinner" />Reading the file...</div>}
        </div>
        <aside className="inspector" inert={!treeOpen}>
          <div className="panel-heading"><strong>{drawingActive ? "Review" : "Parts"}</strong>
            <IconButton label="Close parts panel" icon={X} onClick={() => setTreeOpen(false)} /></div>
          {drawingActive ? <div className="review-summary">
            <strong>{activeReview?.title || "Loading review"}</strong>
            <span>{activeReview ? `${activeReview.drawing.present.length} marks` : ""}</span>
            <span>{activeReview ? activeReview.pose.step !== undefined ? `Assembly step ${activeReview.pose.step}` : `${Math.round(activeReview.pose.explode * 100)}% exploded` : ""}</span>
            <span>{activeReview?.pose.camera.projection === "orthographic" ? "Orthographic (parallel)" : "Perspective"}</span>
            <span>{activeReview?.pose.appearance === "studio" ? `Studio / ${activeReview.pose.materialFinish ?? "matte"}`
              : activeReview?.pose.appearance === "raytraced" ? `Ray traced / ${activeReview.pose.materialFinish ?? "matte"}` : "Inspect"}</span>
            <span>{activeReview?.pose.section?.enabled
              ? `${activeReview.pose.section.axis.toUpperCase()} section at ${activeReview.pose.section.position.toFixed(2)} mm${activeReview.pose.section.flipped ? " / flipped" : ""}`
              : "Section off"}</span>
            <p>Captured view</p>
            <span>Confirmed saves are stored on this computer. Unconfirmed marks stay only in this panel and will not survive reload. Download or copy preserves an image, not editable drawing history.</span>
          </div> : <>
          {(documents.length > 1 || documents.some((document) => document.style === "ghost")) && <div className="file-list" aria-label="Files in view">
            <div className="file-layout"><span className="eyebrow">FILES</span>
              <select aria-label="Compare files" title="Compare files" value={state?.layout ?? "overlay"} onChange={(event) => run("set_layout", { mode: event.target.value })}>
                <option value="overlay">Overlaid</option><option value="side">Side by side</option>
              </select></div>
            {documents.map((document) => <div className="file-row" key={document.id}>
              <span title={document.frame?.note ?? document.name}>{document.name}<small>{document.id}{document.frame ? ` \u00b7 ${document.frame.units}, ${document.frame.up.toUpperCase()} up` : ""}</small></span>
              <IconButton label={`${document.style === "ghost" ? "Show solid" : "Show as ghost"}: ${document.name}`} icon={Ghost} aria-pressed={document.style === "ghost"}
                onClick={() => run("set_file", { id: document.id, style: document.style === "ghost" ? "solid" : "ghost" })} />
              {document.id !== "main" && <IconButton label={`Remove ${document.name}`} icon={X} onClick={() => run("remove_file", { id: document.id })} />}
            </div>)}
          </div>}
          <div className="part-list">{leaves.map((node) => {
            const hidden = state?.hiddenIds.includes(node.id);
            return <div className={`part-row ${state?.selectedIds.includes(node.id) ? "selected" : ""} ${hidden ? "hidden-part" : ""}`} key={node.id}>
              <button className="part-select" onClick={() => select(node.id)}>
                <i style={{ background: `rgb(${node.color.map((value) => Math.round(value * 255)).join(" ")})` }} /><span>{node.label}</span>
                {node.id === state?.fixedId && <Pin size={12} aria-label="Fixed part" />}
              </button>
              <IconButton className="visibility" label={`${hidden ? "Show" : "Hide"} ${node.label}`} icon={hidden ? EyeOff : Eye}
                onClick={() => run("set_visibility", { ids: [node.id], visible: !!hidden })} />
            </div>;
          })}</div>
          <div className="selection-info">
            <span className="eyebrow">SELECTION</span><strong>{selected?.label || `Pick a ${selectionName}`}</strong>
            <p>{selectedEdge ? `Edge ${selectedEdge.id} / ${selectedEdge.curveType} / ${selectedEdge.length.toFixed(2)} mm`
              : selectedFace ? `Face ${selectedFace.id} / ${selectedFace.surfaceType} / ${selectedFace.area.toFixed(2)} mm\u00b2`
              : selectedPoint ? `Point on triangle ${selectedPoint.triangle} / ${selectedPoint.point.map((value) => value.toFixed(3)).join(", ")} mm in the part's frame`
              : selectedPart ? `${selectedPart.bounds.max.map((value, axis) => (value - selectedPart.bounds.min[axis]).toFixed(1)).join(" x ")} mm`
                : state?.selectionMode === "edge" ? "Point near an outline to select its CAD edge."
                  : state?.selectionMode === "point" ? "Click a surface to pick a point on it."
                  : state?.selectionMode === "part" ? "Click an object to select its whole part."
                    : "Click a surface to select its CAD face."}</p>
            {selectedPart?.buffers && <p className="mesh-facts">{`${(selectedPart.triangleCount ?? 0).toLocaleString()} triangles / ${selectedPart.closed ? "closed" : "open"} mesh`}
              {selectedPart.faults && Object.values(selectedPart.faults).some(Boolean) ? ` / ${[
                [selectedPart.faults.openEdges, "open edges"], [selectedPart.faults.oversharedEdges, "over-shared edges"],
                [selectedPart.faults.flippedEdges, "flipped edges"], [selectedPart.faults.degenerateTriangles, "zero-area triangles"],
              ].filter(([count]) => count).map(([count, name]) => `${count} ${name}`).join(", ")}` : ""}</p>}
            <div className="selection-actions">
              <IconButton label="Keep fixed" icon={Pin} disabled={!selected} onClick={() => run("set_explode", { fixedId: selected?.id })} />
              <IconButton label="Isolate" icon={Expand} disabled={!selected} onClick={() => run("isolate", { id: selected?.id })} />
            </div>
          </div>
          </>}
        </aside>
      </section>
      <section className="bottom-bar">
        <div className="explode-panel">
          <Expand size={16} aria-hidden="true" />
          <input aria-label="Explode amount" title="Explode amount" type="range" min="0" max="100" value={Math.round(amount * 100)} disabled={busy || drawingActive || leaves.length < 2}
            onChange={(event) => setAmount(Number(event.target.value) / 100)}
            onPointerUp={(event) => run("set_explode", { amount: Number(event.currentTarget.value) / 100 })}
            onKeyUp={(event) => run("set_explode", { amount: Number(event.currentTarget.value) / 100 })} />
          <output>{Math.round(amount * 100)}%</output>
          <select aria-label="Explosion direction" title="Explosion direction" disabled={drawingActive} value={state?.direction || "radial"} onChange={(event) => run("set_explode", { direction: event.target.value })}>
            <option value="radial">Outward</option><option value="z">Up / down</option><option value="x">Left / right</option><option value="y">Front / back</option>
          </select>
          <IconButton label="Reassemble" icon={RotateCcw} disabled={drawingActive} onClick={() => run("reset_view")} />
          {state?.assembly && <IconButton label={state.assembly.error ? `Assembly steps unavailable: ${state.assembly.error}` : `Assembly steps (${state.assembly.steps.length})`}
            icon={ListOrdered} aria-pressed={state.step !== null} className={state.assembly.error ? "assembly-unavailable" : ""}
            disabled={busy || drawingActive || !!state.assembly.error}
            onClick={() => void player.go(state.step === null ? 0 : null)} />}
        </div>
        <div className={`reference-bar ${copyStatus.kind}`} aria-label="Chat references" data-copy-status={copyStatus.kind}>
        <label><input type="checkbox" role="switch" checked={autoCopyEnabled}
          aria-label="Auto-copy reference" disabled={!state || drawingActive || autoCopyPending} onChange={(event) => void setAutoCopy(event.target.checked)} />
          Auto-copy</label>
        <IconButton label="Copy reference" icon={Copy} disabled={!selected || busy || drawingActive}
          onClick={() => selected && void copySelection(selected.id, selectedFace?.id, selectedEdge?.id, selectedPoint)} />
        </div>
      </section>
      <div className="status-line"><span className={`dot ${connected ? "live" : ""}`} aria-hidden="true" />
        <span role="status">{drawingActive ? reviews.status || "Captured view" : reviews.status || copyStatus.message || (connected ? "Local file" : "Reconnecting")}</span>
        {!drawingActive && referenceText && <button className="text-link" onClick={() => setReferenceOpen(!referenceOpen)}>Reference text</button>}
        {drawingActive && activeReview && <span className="status-detail">{activeReview.drawing.present.length} marks</span>}
      </div>
      {referenceText && !drawingActive && <details className="reference-details" open={referenceOpen || copyStatus.kind === "blocked"}>
        <summary onClick={(event) => { event.preventDefault(); setReferenceOpen(false); dismissCopyStatus(); }}>Reference text <X size={14} aria-hidden="true" /></summary>
        <textarea ref={referenceField} aria-label="Selected CAD reference" readOnly value={referenceText} onFocus={(event) => event.currentTarget.select()} />
      </details>}
      <div className="messages">
        {(reviews.recovery || reviews.confirmation) && <div className="message error review-recovery" role="dialog" aria-label="Unsaved drawing recovery" aria-describedby="review-recovery-description">
          <strong>{reviews.confirmation ? "Discard local drawing changes?" : reviews.recovery?.kind === "conflict" ? "Drawing conflict" : "Drawing save not confirmed"}</strong>
          <p id="review-recovery-description" role="alert">{reviews.confirmation
            ? `Your unconfirmed marks will be removed from this panel${reviews.confirmation === "load" ? " after the server review loads" : ""}. Download or copy the local image first if you need it. Server marks will not be changed.`
            : reviews.recovery?.message}</p>
          <p>Unconfirmed marks will not survive reload. Download/copy keeps an image only, not a server save or editable history.</p>
          <div className="recovery-actions">
            <button disabled={reviews.working} onClick={() => void reviews.downloadImage()}>Download local image</button>
            <button disabled={reviews.working} onClick={reviews.copyImage}>Copy local image</button>
            <button disabled={reviews.working} onClick={() => void reviews.saveCopy()}>Save separate review</button>
            {!reviews.confirmation && <>
              <button disabled={reviews.working} onClick={() => void reviews.retrySave()}>Retry save</button>
              <button disabled={reviews.working} onClick={reviews.confirmLoad}>Load server version...</button>
              <button disabled={reviews.working} onClick={reviews.confirmLeave}>Leave review...</button>
            </>}
            {reviews.confirmation && <>
              <button disabled={reviews.working} onClick={() => void reviews.discard()}>{reviews.confirmation === "load" ? "Discard local changes and load server" : "Discard local changes and leave"}</button>
              <button disabled={reviews.working} onClick={reviews.cancelConfirmation}>Keep editing</button>
            </>}
          </div>
        </div>}
        {(reviewError || error || state?.error) && <div className="message error" role="alert">{reviewError || error || state?.error}<button onClick={() => { setReviewError(""); setError(""); }} aria-label="Dismiss message">x</button></div>}
        {notice && <div className="message" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice">x</button></div>}
      </div>
    </main>
  );
}

const headless = new URLSearchParams(location.search).get("renderer") === "headless";
createRoot(document.getElementById("root")!).render(headless ? <HeadlessApp host={createDesktopHost("headless")} /> : <App host={createDesktopHost()} />);
