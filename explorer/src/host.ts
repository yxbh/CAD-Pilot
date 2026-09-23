import type { EdgeSelection, FaceSelection, Model, ViewState } from "./model.ts";
import type { CameraState } from "../shared/view-settings.mjs";
export type { CameraState } from "../shared/view-settings.mjs";
import type { Review } from "./drawing/types.ts";
import type { DrawingState } from "../shared/drawing.mjs";
import { createReference } from "../shared/references.mjs";
import { copyPreparedReference, createClipboardWriter, type NativeCopyResult } from "./clipboard.ts";
import { post, request } from "./api.ts";

export type ViewCapture = { dataUrl: string; width: number; height: number; camera: CameraState };
export type RenderReport = {
  revision: number; modelHash: string; topologyRevision: string; visibleParts: number;
  selectedIds: string[]; selectedFace: FaceSelection | null; highlightedTriangles: number;
  selectedEdge: EdgeSelection | null; highlightedSegments: number; selectedEdgeScreen: number[] | null;
  selectedFaceScreen: number[] | null; bounds: { min: number[]; max: number[] } | null;
  positions: { id: string; position: number[] }[];
  renderer: string; inFrame: boolean; geometryDefinitions: number; geometryIds: { id: string; geometry: string }[];
  camera: CameraState; appearance: ViewState["appearance"]; materialFinish: ViewState["materialFinish"];
  section: ViewState["section"];
  projectedBounds: { min: number[]; max: number[] } | null;
};
export type CaptureRequest = { id: string; revision: number; reviewId?: string | null; reviewVersion?: number };
export type ReviewSummary = { id: string; title: string; version: number; createdAt: string; sourceName: string; topologyRevision: string; strokeCount: number };
export interface ViewerHost {
  getState(): Promise<ViewState>;
  loadModel(): Promise<Model>;
  command(name: string, input: object): Promise<ViewState>;
  subscribe(callbacks: {
    onState: (state: ViewState) => void; onConnection: (connected: boolean) => void;
    onCapture: (request: CaptureRequest) => void; onError: (error: Error) => void;
  }): () => void;
  reportRendered(report: RenderReport): Promise<unknown>;
  captureResult(result: object): Promise<unknown>;
  captureImage(): Promise<{ path: string }>;
  upload(file: File): Promise<unknown>;
  copyReference(model: Model, id: string, faceId?: string, edgeId?: string): Promise<NativeCopyResult>;
  cancelPendingCopy(): void;
  copyImage(image: Promise<Blob>): Promise<void>;
  listReviews(): Promise<ReviewSummary[]>;
  getReview(id: string): Promise<Review>;
  createReview(capture: ViewCapture, revision: number): Promise<Review>;
  copyReview(id: string, drawing: DrawingState): Promise<Review>;
  saveDrawing(id: string, drawing: DrawingState, version: number): Promise<Review>;
  saveReviewImage(id: string, version: number, image: Blob): Promise<{ path: string }>;
}

export async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image data"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image data"));
    reader.readAsDataURL(blob);
  });
}

export function createDesktopHost(): ViewerHost {
  const clipboard = createClipboardWriter();
  let copySequence = 0;
  let prepareQueue: Promise<unknown> = Promise.resolve();
  return {
    getState: () => request("state"),
    loadModel: () => request("model"),
    command: (name, input) => post("command", { name, input }),
    subscribe(callbacks) {
      const events = new EventSource("api/events");
      events.onopen = () => callbacks.onConnection(true);
      events.onerror = () => callbacks.onConnection(false);
      const receive = <T,>(event: MessageEvent, fn: (data: T) => void) => {
        try { fn(JSON.parse(event.data)); }
        catch (error) { callbacks.onError(error instanceof Error ? error : new Error(String(error))); }
      };
      events.addEventListener("state", (event) => receive(event, callbacks.onState));
      events.addEventListener("capture", (event) => receive(event, callbacks.onCapture));
      return () => events.close();
    },
    reportRendered: (report) => post("rendered", report),
    captureResult: (result) => post("capture-result", result),
    captureImage: () => post("capture", {}),
    upload: (file) => request("upload", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file }),
    copyReference(model, id, faceId, edgeId) {
      const sequence = ++copySequence;
      const reference = createReference(model, id, faceId ?? null, edgeId ?? null);
      const preparation = prepareQueue.then(() => post<{ text: string; title: string }>("clipboard-reference", { reference }));
      prepareQueue = preparation.catch(() => undefined);
      return copyPreparedReference(preparation, (text) => sequence === copySequence
        ? clipboard(text, true) : Promise.resolve({ ok: false, error: "Superseded by a newer selection" }));
    },
    cancelPendingCopy() { copySequence++; },
    copyImage(image) {
      if (typeof navigator.clipboard?.write !== "function" || typeof ClipboardItem === "undefined") {
        void image.catch(() => undefined);
        return Promise.reject(new Error("Image clipboard is unavailable. Use Save marked image instead."));
      }
      let writing: Promise<void>;
      try { writing = navigator.clipboard.write([new ClipboardItem({ "image/png": image })]); }
      catch (error) { writing = Promise.reject(error); }
      void image.catch(() => undefined);
      return writing.catch((error: Error) => { throw new Error(`Image was not copied: ${error.message}. Use Save marked image instead.`); });
    },
    listReviews: () => request("reviews"),
    getReview: (id) => request(`reviews/${encodeURIComponent(id)}`),
    createReview: (capture, revision) => post("reviews", { capture, revision }),
    copyReview: (id, drawing) => post(`reviews/${encodeURIComponent(id)}/copy`, { drawing }),
    saveDrawing: (id, drawing, version) => post(`reviews/${encodeURIComponent(id)}`, { drawing, version }),
    saveReviewImage: async (id, version, image) => post(`reviews/${encodeURIComponent(id)}/image`, { version, dataUrl: await blobDataUrl(image) }),
  };
}
