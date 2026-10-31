import React, { useCallback, useEffect, useRef, useState } from "react";
import Scene from "./Scene.tsx";
import { useArrangedModel } from "./useArrangedModel.ts";
import { newestState, type Model, type ViewState } from "./model.ts";
import { blobDataUrl, type CaptureRequest, type RenderReport, type ViewCapture, type ViewerHost } from "./host.ts";
import { composeReviewImage } from "./drawing/render.ts";

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
  const [surface, setSurface] = useState<{ width: number; height: number; background: string | null }>({ ...defaultSize, background: null });
  const latest = useRef<ViewState | null>(null);
  const lastReport = useRef<RenderReport | null>(null);
  const capture = useRef<(() => ViewCapture) | null>(null);
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

  // A capture waits for a frame the scene reported at its own size and backdrop. The scene commits apart from this
  // component, so the surface it was given here says nothing about what the scene has drawn yet.
  const settle = useCallback(async (revision: number, width: number, height: number, background: string | null) => {
    await nextFrame(); await nextFrame();
    for (let frame = 0; frame < 900; frame++) {
      if (latest.current?.revision !== revision) throw new Error("View changed before capture");
      const report = lastReport.current;
      if (capture.current && report?.revision === revision && report.pixels[0] === width && report.pixels[1] === height &&
          report.background === background) return;
      await nextFrame();
    }
    throw new Error("The background renderer did not draw the view at the requested size and backdrop");
  }, []);

  const onCapture = useCallback((request: CaptureRequest) => {
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
        setSurface({ width, height, background });
        await settle(request.revision, width, height, background);
        const captured = capture.current!();
        await host.captureResult({ ...request, dataUrl: captured.dataUrl, camera: captured.camera });
      } catch (failure) {
        await host.captureResult({ ...request, error: message(failure) }).catch(noop);
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

  const registerCapture = useCallback((callback: (() => ViewCapture) | null) => { capture.current = callback; }, []);
  const rendered = useCallback((report: RenderReport) => {
    lastReport.current = report;
    return host.reportRendered(report);
  }, [host]);
  // Files in a view are placed as the viewer page places them.
  const model = useArrangedModel(composed, state);
  const ready = model && state && model.topologyRevision === state.topologyRevision;
  return (
    <main className="headless-renderer" style={{ width: surface.width, height: surface.height }}>
      {ready && <RendererBoundary key={state.topologyRevision} onError={fail}>
        <Scene model={model} state={state} amount={state.explode} stepPosition={state.step} sectionPosition={state.section.position}
          active headless background={surface.background} onSelect={noop} onError={fail} registerCapture={registerCapture}
          onRendered={rendered} onCameraChange={noop} onView={noop} />
      </RendererBoundary>}
    </main>
  );
}
