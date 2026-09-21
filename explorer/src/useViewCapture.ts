import { useCallback, useRef, useState, type RefObject } from "react";
import { blobDataUrl, type CaptureRequest, type ViewCapture, type ViewerHost } from "./host.ts";
import type { ViewState } from "./model.ts";
import type { useReviews } from "./useReviews.ts";

export function useViewCapture({ host, latest, queue, reviews, onError }: {
  host: ViewerHost;
  latest: RefObject<ViewState | null>;
  queue: RefObject<Promise<unknown>>;
  reviews: Pick<ReturnType<typeof useReviews>, "start" | "captureRequested">;
  onError: (message: string) => void;
}) {
  const capture = useRef<(() => ViewCapture) | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const registerCapture = useCallback((callback: (() => ViewCapture) | null) => { capture.current = callback; }, []);
  const captureHandler = useRef<(request: CaptureRequest) => Promise<void>>(async () => undefined);
  captureHandler.current = async (requested) => {
    try {
      if (latest.current?.revision !== requested.revision) throw new Error("View changed before capture");
      if (requested.reviewId) {
        const image = await reviews.captureRequested(requested);
        await host.captureResult({ ...requested, dataUrl: await blobDataUrl(image) });
      } else {
        if (!capture.current || latest.current.activeReviewId) throw new Error("Model renderer is not ready");
        const captured = capture.current();
        await host.captureResult({ ...requested, dataUrl: captured.dataUrl, camera: captured.camera });
      }
    } catch (failure) {
      await host.captureResult({ ...requested, error: failure instanceof Error ? failure.message : String(failure) });
    }
  };
  const onCapture = useCallback((requested: CaptureRequest) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void captureHandler.current(requested).catch((failure: Error) => onError(failure.message));
    }));
  }, [onError]);

  async function beginDrawing() {
    if (changingMode) return;
    setChangingMode(true);
    onError("");
    try {
      await queue.current;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!capture.current || !latest.current || latest.current.loading) throw new Error("Wait for the model to finish loading");
      const captured = capture.current();
      await reviews.start(captured, latest.current.revision);
    } catch (failure) { onError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setChangingMode(false); }
  }

  return { registerCapture, onCapture, beginDrawing, changingMode };
}
