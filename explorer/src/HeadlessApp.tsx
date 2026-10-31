import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Scene from "./Scene.tsx";
import { useArrangedModel } from "./useArrangedModel.ts";
import { newestState, type Model, type ViewState } from "./model.ts";
import { blobDataUrl, type CaptureRequest, type CaptureView, type RenderReport, type ViewerHost } from "./host.ts";
import { composeReviewImage } from "./drawing/render.ts";
import { analysisKey, type AnalysisSettings } from "../shared/analysis.mjs";
import type { TraceLimits } from "../shared/raytrace.mjs";

const defaultSize = { width: 1280, height: 800 };
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const noop = () => {};
// A failure to create or keep a WebGL context is worth one retry with software rendering.
const graphicsFailure = (text: string) => /webgl|graphics context/i.test(text);

class RendererBoundary extends React.Component<{ onError: (message: string) => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error.message); }
  render() { return this.state.failed ? null : this.props.children; }
}

// The background renderer: the viewer's own scene without controls, drawn at the size each capture asks for, so
// loads and captures never depend on a visible tab. The server starts it in a headless browser when needed.
export function HeadlessApp({ host }: { host: ViewerHost }) {
  const [state, setState] = useState<ViewState | null>(null);
  const [composed, setModel] = useState<Model | null>(null);
  // What a capture draws: its size and backdrop, and analysis settings or ray tracing of its own when it asks for them.
  const [surface, setSurface] = useState<{
    width: number; height: number; background: string | null; analysis: AnalysisSettings | null; trace: TraceLimits | null;
  }>({ ...defaultSize, background: null, analysis: null, trace: null });
  const latest = useRef<ViewState | null>(null);
  // The surface React has committed: a capture is drawn only once its own size and backdrop are in place.
  const applied = useRef(surface);
  useEffect(() => { applied.current = surface; }, [surface]);
  const lastReport = useRef<RenderReport | null>(null);
  const capture = useRef<CaptureView | null>(null);
  // A graphics failure is reported once: the server answers it by restarting the browser in software rendering.
  const graphicsReported = useRef(false);
  const fail = useCallback((text: string) => {
    if (!text) return;
    const graphics = graphicsFailure(text);
    if (graphics && graphicsReported.current) return;
    graphicsReported.current ||= graphics;
    void host.reportRenderError(text, graphics).catch(noop);
  }, [host]);
  // three.js fails to create a WebGL context inside react-three-fiber's asynchronous setup, where no error boundary sees
  // it. Report it, or the server would wait for a frame that never comes instead of retrying in software.
  useEffect(() => {
    const report = (reason: unknown) => { const text = message(reason); if (graphicsFailure(text)) fail(text); };
    const rejected = (event: PromiseRejectionEvent) => report(event.reason);
    const thrown = (event: ErrorEvent) => report(event.error ?? event.message);
    window.addEventListener("unhandledrejection", rejected);
    window.addEventListener("error", thrown);
    return () => {
      window.removeEventListener("unhandledrejection", rejected);
      window.removeEventListener("error", thrown);
    };
  }, [fail]);
  const accept = useCallback((incoming: ViewState) => {
    latest.current = newestState(latest.current, incoming);
    setState(latest.current);
  }, []);

  const settle = useCallback(async (revision: number, width: number, height: number, background: string | null, analysis: AnalysisSettings | null,
    trace: TraceLimits | null) => {
    await nextFrame(); await nextFrame();
    // Size and backdrop take a few frames; an analysis view's data can take longer on a dense mesh.
    for (let frame = 0; frame < 6000; frame++) {
      if (latest.current?.revision !== revision) throw new Error("View changed before capture");
      const report = lastReport.current;
      const drawn = analysisKey(analysis ?? latest.current.analysis);
      const surfaceReady = applied.current.width === width && applied.current.height === height && applied.current.background === background &&
        applied.current.analysis === analysis && applied.current.trace === trace;
      if (capture.current && surfaceReady && report?.revision === revision && report.pixels[0] === width && report.pixels[1] === height &&
          report.analysisKey === drawn) return;
      if (frame >= 900 && report?.analysisKey === drawn) break;
      await nextFrame();
    }
    throw new Error("The background renderer did not draw the view at the requested size");
  }, []);

  const onCapture = useCallback((request: CaptureRequest) => {
    // A traced image's wait counts from here: preparing its scene and compiling the tracer come before it traces.
    const received = performance.now();
    void (async () => {
      try {
        if (latest.current?.revision !== request.revision) throw new Error("View changed before capture");
        if (request.reviewId) {
          // A drawing review is captured from its saved version, marks included.
          const review = await host.getReview(request.reviewId);
          if (review.version !== request.reviewVersion) throw new Error("The drawing changed during capture. Retry once it is saved.");
          await host.captureResult({ ...request, dataUrl: await blobDataUrl(await composeReviewImage(review)) });
          return;
        }
        const width = request.width ?? defaultSize.width;
        const height = request.height ?? defaultSize.height;
        const background = request.background ?? null;
        const analysis = request.analysis ?? null;
        const trace = request.trace ?? null;
        setSurface({ width, height, background, analysis, trace });
        await settle(request.revision, width, height, background, analysis, trace);
        const captured = await capture.current!(trace ?? undefined);
        if (latest.current?.revision !== request.revision) throw new Error("View changed during capture");
        const traced = captured.trace && { ...captured.trace, waited: (performance.now() - received) / 1000 };
        await host.captureResult({ ...request, dataUrl: captured.dataUrl, camera: captured.camera, analysisStats: captured.analysisStats, trace: traced });
      } catch (failure) {
        await host.captureResult({ ...request, error: message(failure) }).catch(noop);
      } finally {
        // A capture's own analysis is for that image; the view goes back to its own, unless the next capture, which
        // can arrive before this one's result is acknowledged, has already set its own.
        if (request.analysis) setSurface((current) => current.analysis === request.analysis ? { ...current, analysis: null } : current);
        if (request.trace) setSurface((current) => current.trace === request.trace ? { ...current, trace: null } : current);
      }
    })();
  }, [host, settle]);

  useEffect(() => {
    const unsubscribe = host.subscribe({ onConnection: noop, onState: accept, onError: (failure) => fail(failure.message), onCapture });
    void host.getState().then(accept, (failure: Error) => fail(failure.message));
    return unsubscribe;
  }, [host, accept, fail, onCapture]);
  useEffect(() => {
    if (!state?.topologyRevision) return;
    let active = true;
    void host.loadModel().then((value) => { if (active) setModel(value); }, (failure: Error) => { if (active) fail(failure.message); });
    return () => { active = false; };
  }, [host, fail, state?.topologyRevision, state?.modelName]);

  const registerCapture = useCallback((callback: CaptureView | null) => { capture.current = callback; }, []);
  const rendered = useCallback((report: RenderReport) => {
    lastReport.current = report;
    return host.reportRendered(report);
  }, [host]);
  // Files in a view are placed as the viewer page places them.
  const model = useArrangedModel(composed, state);
  const drawn = useMemo(() => state && (surface.analysis || surface.trace) ? {
    ...state, ...(surface.analysis ? { analysis: surface.analysis } : {}), ...(surface.trace ? { appearance: "raytraced" as const } : {}),
  } : state, [state, surface.analysis, surface.trace]);
  const ready = model && drawn && model.topologyRevision === drawn.topologyRevision;
  return (
    <main className="headless-renderer" style={{ width: surface.width, height: surface.height }}>
      {ready && <RendererBoundary key={drawn.topologyRevision} onError={fail}>
        <Scene model={model} state={drawn} amount={drawn.explode} stepPosition={drawn.step} sectionPosition={drawn.section.position}
          active headless background={surface.background} onSelect={noop} onError={fail} registerCapture={registerCapture}
          onRendered={rendered} onCameraChange={noop} onView={noop} />
      </RendererBoundary>}
    </main>
  );
}
