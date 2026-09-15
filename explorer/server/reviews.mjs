import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyDrawing, validateDrawing } from "../shared/drawing.mjs";
import { PrototypeError } from "./protocol.mjs";
import { atomicJson } from "./storage.mjs";
import { validateCamera as validateViewCamera } from "../shared/view-settings.mjs";

const reviewId = /^[a-f0-9-]{36}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maxPngBytes = 12 * 1024 * 1024;
const maxPixels = 16_777_216;
const maxReviews = 20;
const fail = (message) => { throw new PrototypeError("invalid_review", message, 422); };
export function validateCamera(camera) {
  try { return validateViewCamera(camera); }
  catch (error) { fail(error.message); }
}

export function pngBytes(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > maxPngBytes * 1.4 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) fail("Expected a PNG image smaller than 12 MB");
  const bytes = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  if (bytes.length < 33 || bytes.length > maxPngBytes || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") fail("Invalid PNG header");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > maxPixels) fail("Image dimensions exceed the review limit");
  return { bytes, width, height };
}

function summary(review) {
  return {
    id: review.id, title: review.title, version: review.version, createdAt: review.createdAt,
    sourceName: review.source.name, topologyRevision: review.source.topologyRevision,
    strokeCount: review.drawing.present.length,
  };
}

export class ReviewStore {
  constructor(directory) {
    this.directory = directory;
    this.summaries = new Map();
    this.listing = null;
  }
  async signature(file) {
    const info = await stat(file, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}`;
  }
  remember(review, signature) {
    this.summaries.delete(review.id);
    this.summaries.set(review.id, { signature, item: summary(review) });
    if (this.summaries.size > maxReviews) this.summaries.delete(this.summaries.keys().next().value);
  }
  file(id) {
    if (typeof id !== "string" || !reviewId.test(id)) throw new PrototypeError("invalid_review_id", "Invalid review ID");
    return path.join(this.directory, `${id}.json`);
  }
  async write(file, value) {
    await mkdir(this.directory, { recursive: true });
    await atomicJson(file, value);
  }
  async get(id) {
    let result, signature;
    try {
      const file = this.file(id);
      signature = await this.signature(file);
      result = JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
      if (error.code === "ENOENT") throw new PrototypeError("review_missing", "This saved review is no longer available", 404);
      throw error;
    }
    if (result.id !== id || !Number.isInteger(result.version) || result.version < 1 ||
        !hashPattern.test(result.source?.sha256) || !hashPattern.test(result.source?.topologyRevision) ||
        typeof result.title !== "string" || typeof result.createdAt !== "string" ||
        typeof result.source?.name !== "string") fail("Saved review identity is invalid");
    validateCamera(result.pose?.camera);
    validateDrawing(result.drawing);
    this.remember(result, signature);
    return result;
  }
  async list() {
    if (!this.listing) this.listing = this.scanSummaries().finally(() => { this.listing = null; });
    return (await this.listing).map((item) => ({ ...item }));
  }
  async scanSummaries() {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    const ids = new Set(files.map((file) => file.slice(0, -5)));
    for (const id of this.summaries.keys()) if (!ids.has(id)) this.summaries.delete(id);
    const items = await Promise.all(files.map(async (file) => {
      const id = file.slice(0, -5);
      const cached = this.summaries.get(id);
      // Keep images out of the cache; file metadata also invalidates other stores' writes.
      const signature = await this.signature(this.file(id));
      return cached?.signature === signature ? cached.item : summary(await this.get(id));
    }));
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async checkCapacity() {
    const existing = await this.list();
    if (existing.length >= maxReviews) throw new PrototypeError("review_limit", "This view already has 20 saved reviews. Export your local image or open a new view to create more.", 409);
    return existing.length;
  }
  async create(capture, state, expectedRevision) {
    if (!state.documentRevision || state.loading || expectedRevision !== state.revision) throw new PrototypeError("stale_view", "View changed before the review was captured. Try Draw again.", 409);
    if (state.activeReviewId) throw new PrototypeError("review_active", "Return to the model before creating another captured review", 409);
    const count = await this.checkCapacity();
    const { width, height } = pngBytes(capture?.dataUrl);
    if (capture.width !== width || capture.height !== height) fail("Captured image size does not match its metadata");
    validateCamera(capture.camera);
    if ((capture.camera.projection ?? "perspective") !== (state.projection ?? "perspective")) fail("Captured camera projection does not match the view");
    const review = {
      id: randomUUID(), version: 1, title: `Review ${count + 1} - ${state.modelName}`, createdAt: new Date().toISOString(),
      source: { name: state.modelName, sha256: state.documentRevision, topologyRevision: state.topologyRevision },
      pose: {
        explode: state.explode, direction: state.direction, fixedId: state.fixedId,
        hiddenIds: [...state.hiddenIds], selectedIds: [...state.selectedIds], selectedFace: state.selectedFace,
        camera: capture.camera,
        appearance: state.appearance, materialFinish: state.materialFinish, showEdges: state.showEdges,
      },
      image: { dataUrl: capture.dataUrl, width, height },
      drawing: emptyDrawing(),
    };
    await this.write(this.file(review.id), review);
    this.summaries.delete(review.id);
    return review;
  }
  async copy(id, drawing) {
    try { validateDrawing(drawing); }
    catch (error) { throw new PrototypeError("invalid_drawing", error.message, 422); }
    const original = await this.get(id);
    await this.checkCapacity();
    const review = {
      ...original, id: randomUUID(), version: 1, title: `${original.title} (copy)`,
      createdAt: new Date().toISOString(), drawing,
    };
    await this.write(this.file(review.id), review);
    this.summaries.delete(review.id);
    return review;
  }
  async save(id, drawing, expectedVersion) {
    const current = await this.get(id);
    if (current.version !== expectedVersion) throw new PrototypeError("stale_review", "This review changed in another panel. Your drawing was not overwritten; reload the review to reconcile.", 409);
    try { validateDrawing(drawing); }
    catch (error) { throw new PrototypeError("invalid_drawing", error.message, 422); }
    const next = { ...current, version: current.version + 1, drawing };
    await this.write(this.file(id), next);
    this.summaries.delete(id);
    return next;
  }
  async saveImage(id, version, dataUrl) {
    const review = await this.get(id);
    if (review.version !== version) throw new PrototypeError("stale_review", "Review changed while the marked image was being prepared", 409);
    const { bytes, width, height } = pngBytes(dataUrl);
    if (width !== review.image.width || height !== review.image.height) fail("Marked image size differs from the captured review");
    const image = path.join(this.directory, `${id}-v${version}-${randomUUID()}.png`);
    await writeFile(image, bytes, { flag: "wx" });
    await this.write(`${image}.json`, {
      reviewId: id, version, source: review.source, pose: review.pose, drawing: review.drawing.present,
      pixelSize: { width, height }, presentationOnly: true,
    });
    return { path: image, reviewId: id, version };
  }
}
