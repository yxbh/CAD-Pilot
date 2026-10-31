import type { EdgeSelection, FaceSelection, Model, PointSelection, ViewState } from "./model.ts";
import type { CameraState } from "../shared/view-settings.mjs";
import type { AnalysisSettings, AnalysisStats } from "../shared/analysis.mjs";
import type { TraceLimits, TraceReport } from "../shared/raytrace.mjs";
export type { CameraState } from "../shared/view-settings.mjs";
import type { Review } from "./drawing/types.ts";
import type { DrawingState } from "../shared/drawing.mjs";
import { createReference, type ReferencePoint } from "../shared/references.mjs";
import { attachMeshGeometry, meshViews } from "../shared/mesh.mjs";
import { copyPreparedReference, createClipboardWriter, type NativeCopyResult } from "./clipboard.ts";
import { post, request } from "./api.ts";

export type ViewCapture = { dataUrl: string; width: number; height: number; camera: CameraState; analysisStats?: AnalysisStats; trace?: TraceReport };
// Draws the view for a capture; a ray-traced view resolves once it has traced to the limits.
export type CaptureView = (limits?: TraceLimits) => ViewCapture | Promise<ViewCapture>;
export type RenderReport = {
  revision: number; modelHash: string; topologyRevision: string; visibleParts: number;
  selectedIds: string[]; selectedFace: FaceSelection | null; highlightedTriangles: number;
  selectedEdge: EdgeSelection | null; highlightedSegments: number; selectedEdgeScreen: number[] | null;
  selectedFaceScreen: number[] | null; bounds: { min: number[]; max: number[] } | null;
  pixels: [number, number];
  selectedPoint: PointSelection | null; selectedPointScreen: number[] | null; faultMarks: number; sectionOutlineSegments: number; ghostParts: number; meshTriangles: number; pickingTrees: number;
  // The analysis drawn: its settings' key, its legend's numbers, and what was mounted for it.
  analysisKey: string; analysisStats: AnalysisStats; triangleEdgeSegments: number; normalArrows: number; analysisSurfaces: number;
  positions: { id: string; position: number[] }[];
  renderer: string; inFrame: boolean; geometryDefinitions: number; geometryIds: { id: string; geometry: string }[];
  camera: CameraState; appearance: ViewState["appearance"]; materialFinish: ViewState["materialFinish"];
  section: ViewState["section"];
  step: ViewState["step"];
  projectedBounds: { min: number[]; max: number[] } | null;
};
export type CaptureRequest = {
  id: string; revision: number; reviewId?: string | null; reviewVersion?: number;
  width?: number; height?: number; background?: string;
  // Analysis settings for this image only, and how far to ray trace it, drawn by the background renderer.
  analysis?: AnalysisSettings;
  trace?: TraceLimits;
};
// A person's viewer page, or the background page that draws views when no visible tab does.
export type RendererKind = "viewer" | "headless";
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
  reportRenderError(message: string, webgl: boolean): Promise<unknown>;
  captureResult(result: object): Promise<unknown>;
  captureImage(): Promise<{ path: string }>;
  upload(file: File, add?: boolean): Promise<unknown>;
  copyReference(model: Model, id: string, faceId?: string, edgeId?: string, point?: ReferencePoint): Promise<NativeCopyResult>;
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

// Mesh parts arrive as one binary geometry file per mesh, fetched once and reused while the mesh stays in view,
// so restyling or moving files does not download their geometry again.
function meshLoader() {
  const files = new Map<string, Promise<ArrayBuffer>>();
  const fetchGeometry = async (revision: string) => {
    const response = await fetch(`api/geometry/${revision}`);
    if (!response.ok) throw new Error(`Mesh geometry request failed: ${response.status}`);
    return response.arrayBuffer();
  };
  return async (kind: RendererKind): Promise<Model> => {
    // The server gives a viewer page in front time to mesh a model it has fetched before drawing it in the
    // background; a hidden tab draws nothing, so it says it is hidden.
    const visible = typeof document !== "undefined" && document.visibilityState === "visible" ? 1 : 0;
    const model = await request<Model>(`model?kind=${kind}&visible=${visible}`);
    const revisionOf = (documentId?: string) => model.documents?.find((document) => document.id === documentId)?.topologyRevision ?? model.topologyRevision;
    const wanted = new Set(model.parts.filter((part) => part.buffers).map((part) => revisionOf(part.documentId)));
    for (const revision of files.keys()) if (!wanted.has(revision)) files.delete(revision);
    for (const revision of wanted) {
      if (files.has(revision)) continue;
      const pending = fetchGeometry(revision);
      files.set(revision, pending);
      pending.catch(() => { if (files.get(revision) === pending) files.delete(revision); });
    }
    const loaded = new Map(await Promise.all([...wanted].map(async (revision) => [revision, await files.get(revision)!] as const)));
    for (const part of model.parts) {
      if (part.buffers) attachMeshGeometry(part, meshViews(part, loaded.get(revisionOf(part.documentId))!));
    }
    return model;
  };
}

export function createDesktopHost(kind: RendererKind = "viewer"): ViewerHost {
  const client = crypto.randomUUID();
  const loadModel = meshLoader();
  const clipboard = createClipboardWriter();
  let copySequence = 0;
  let prepareQueue: Promise<unknown> = Promise.resolve();
  return {
    getState: () => request("state"),
    loadModel: () => loadModel(kind),
    command: (name, input) => post("command", { name, input }),
    subscribe(callbacks) {
      const events = new EventSource(`api/events?client=${client}&kind=${kind}`);
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
    reportRendered: (report) => post("rendered", { ...report, kind }),
    reportRenderError: (message, webgl) => post("renderer-error", { message, webgl }),
    captureResult: (result) => post("capture-result", result),
    // The Capture button saves what this page shows; agents' captures come from the background renderer.
    captureImage: () => post("capture", { client }),
    upload: (file, add = false) => request("upload", {
      method: "POST", headers: {
        "x-file-name": encodeURIComponent(file.name), "x-file-modified": String(file.lastModified), ...(add ? { "x-explorer-add": "1" } : {}),
      }, body: file,
    }),
    copyReference(model, id, faceId, edgeId, point) {
      const sequence = ++copySequence;
      const reference = createReference(model, id, faceId ?? null, edgeId ?? null, point ?? null);
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
