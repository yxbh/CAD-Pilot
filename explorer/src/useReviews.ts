import { useCallback, useEffect, useRef, useState } from "react";
import type { DrawingState } from "../shared/drawing.mjs";
import type { Review } from "./drawing/types.ts";
import { composeReviewImage } from "./drawing/render.ts";
import type { CaptureRequest, ReviewSummary, ViewerHost, ViewCapture } from "./host.ts";

type Attempt = { id: string; drawing: DrawingState; base: DrawingState; version: number };
type Recovery = { kind: "failed" | "conflict"; message: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function sameDrawing(a: DrawingState, b: DrawingState): boolean {
  if (a === b) return true;
  const frames = (drawing: DrawingState) => [drawing.present, ...drawing.past, ...drawing.future];
  if (a.past.length !== b.past.length || a.future.length !== b.future.length) return false;
  const right = frames(b);
  return frames(a).every((frame, index) => frame.length === right[index].length && frame.every((stroke, i) => {
    const other = right[index][i];
    return stroke.id === other.id && stroke.tool === other.tool && stroke.color === other.color &&
      stroke.width === other.width && stroke.points.length === other.points.length &&
      stroke.points.every((point, j) => point[0] === other.points[j][0] && point[1] === other.points[j][1]);
  }));
}

export function useReviews(host: ViewerHost, activeId: string | null, onError: (error: string) => void) {
  const [review, setReview] = useState<Review | null>(null);
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [confirmation, setConfirmation] = useState<"leave" | "load" | null>(null);
  const current = useRef<Review | null>(null);
  const confirmed = useRef<Review | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const failed = useRef<Attempt | null>(null);
  const dirty = useRef(false);
  const operation = useRef(false);
  const ignoredActiveId = useRef<{ id: string | null } | null>(null);
  const loadSequence = useRef(0);

  const updateSummary = useCallback((value: Review) => {
    const item: ReviewSummary = {
      id: value.id, title: value.title, version: value.version, createdAt: value.createdAt,
      sourceName: value.source.name, topologyRevision: value.source.topologyRevision,
      strokeCount: value.drawing.present.length,
    };
    setItems((previous) => [item, ...previous.filter((entry) => entry.id !== item.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  const accept = useCallback((value: Review | null) => {
    ++loadSequence.current;
    current.current = confirmed.current = value;
    dirty.current = false;
    failed.current = null;
    setReview(value); setRecovery(null); setConfirmation(null); setSaving(false); setLoading(false);
    setStatus(value ? "Saved on this computer" : "");
    if (value) updateSummary(value);
  }, [updateSummary]);

  useEffect(() => {
    let live = true;
    void host.listReviews().then((values) => {
      if (!live) return;
      // A slow initial list must not replace newer locally acknowledged summaries.
      setItems((previous) => {
        const merged = new Map(values.map((value) => [value.id, value]));
        for (const value of previous) {
          if (!merged.has(value.id) || merged.get(value.id)!.version <= value.version) merged.set(value.id, value);
        }
        return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    }, (error) => { if (live) onError(message(error)); });
    return () => { live = false; };
  }, [host, onError]);

  useEffect(() => {
    let live = true;
    const sequence = ++loadSequence.current;
    void (async () => {
      await pending.current;
      if (!live || sequence !== loadSequence.current || operation.current) return;
      if (ignoredActiveId.current?.id === activeId) return;
      ignoredActiveId.current = null;
      if (current.current?.id === activeId) return;
      if (dirty.current) {
        setRecovery((value) => value ?? {
          kind: "conflict", message: "Another panel switched reviews. Your unsaved drawing is kept open here; save a copy or explicitly discard it before leaving.",
        });
        return;
      }
      if (!activeId) { accept(null); return; }
      setLoading(true); setStatus("Loading captured review...");
      try {
        const value = await host.getReview(activeId);
        if (live && sequence === loadSequence.current && !operation.current) {
          if (dirty.current) {
            setLoading(false);
            setRecovery((previous) => previous ?? {
              kind: "conflict", message: "A review switch arrived while you were drawing. Your local marks are kept here; finish recovery before switching.",
            });
          } else accept(value);
        }
      } catch (error) {
        if (live && sequence === loadSequence.current) {
          setLoading(false); setStatus("Review could not be loaded"); onError(message(error));
        }
      }
    })();
    return () => { live = false; };
  }, [host, activeId, onError, accept]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  function acknowledge(value: Review) {
    confirmed.current = value;
    updateSummary(value);
    if (current.current?.id !== value.id) return;
    current.current = { ...current.current, version: value.version };
    setReview(current.current);
    dirty.current = !sameDrawing(current.current.drawing, value.drawing);
    failed.current = null;
    setRecovery(null); setConfirmation(null);
    setSaving(dirty.current);
    setStatus(dirty.current ? "Saving drawing..." : "Saved on this computer");
  }

  async function write(value: Review, drawing: DrawingState) {
    const attempt: Attempt = { id: value.id, version: value.version, base: value.drawing, drawing };
    try { acknowledge(await host.saveDrawing(value.id, drawing, value.version)); }
    catch (error) {
      failed.current = attempt;
      setSaving(false);
      setRecovery({ kind: "failed", message: `Save was not confirmed: ${message(error)}` });
      setStatus("Local drawing kept in this panel — save not confirmed");
    }
  }

  function onChange(drawing: DrawingState) {
    const value = current.current;
    if (!value) return;
    if (operation.current) { onError("Wait for review recovery to finish before drawing."); return; }
    current.current = { ...value, drawing };
    dirty.current = true;
    setReview(current.current);
    if (failed.current) return;
    setSaving(true); setStatus("Saving drawing...");
    pending.current = pending.current.then(async () => {
      if (failed.current) return;
      const saved = confirmed.current;
      if (!saved || saved.id !== value.id) throw new Error("Review changed before its drawing could be saved");
      await write(saved, drawing);
    }).catch((error) => {
      setSaving(false);
      setRecovery({ kind: "failed", message: message(error) });
      onError(message(error));
    });
  }

  async function runOperation(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setWorking(true);
    onError("");
    ++loadSequence.current;
    try { await pending.current; await action(); }
    catch (error) {
      setStatus(dirty.current ? "Review action failed — local marks kept here" : "Review action failed");
      onError(message(error));
    }
    finally { operation.current = false; setWorking(false); setSaving(false); }
  }

  async function retrySave() {
    await runOperation(async () => {
      const value = current.current;
      const base = confirmed.current;
      if (!value || !base) return;
      setStatus("Checking the saved review...");
      const remote = await host.getReview(value.id);
      updateSummary(remote);
      const attempt = failed.current;
      if (sameDrawing(remote.drawing, value.drawing) || (attempt && sameDrawing(remote.drawing, attempt.drawing))) {
        acknowledge(remote);
      } else if (remote.version === (attempt?.version ?? base.version) && sameDrawing(remote.drawing, attempt?.base ?? base.drawing)) {
        confirmed.current = remote;
        failed.current = null;
      } else {
        setRecovery({ kind: "conflict", message: "This review has different marks on the server. Neither drawing was overwritten. Save your local drawing as a separate review, or explicitly load the server version." });
        setStatus("Drawing conflict — local marks kept here");
        return;
      }
      if (dirty.current && current.current) await write(remote, current.current.drawing);
    });
  }

  async function saveCopy() {
    await runOperation(async () => {
      const value = current.current;
      if (!value) return;
      setStatus("Saving a separate review...");
      const saved = await host.copyReview(value.id, value.drawing);
      ignoredActiveId.current = null;
      accept(saved);
      setStatus("Separate review saved on this computer; original unchanged");
    });
  }

  async function loadServer() {
    await runOperation(async () => {
      if (!current.current) return;
      // Fetch first: a failed read must never discard the only local drawing.
      const remote = await host.getReview(current.current.id);
      accept(remote);
    });
  }

  async function leave(discard: boolean) {
    await runOperation(async () => {
      if (dirty.current && !discard) { setConfirmation("leave"); return; }
      if (discard) {
        ignoredActiveId.current = { id: activeId };
        accept(null);
        try { await host.command("close_review", {}); }
        catch (error) {
          setStatus("Left locally; server view unchanged");
          onError(`Left this panel's review, but the server could not be updated: ${message(error)}. A downloaded or copied image is not a server save.`);
        }
      } else {
        try { await host.command("close_review", {}); }
        catch (error) {
          setConfirmation("leave");
          onError(`The server view could not be closed: ${message(error)}. You can explicitly leave locally instead.`);
          return;
        }
        ignoredActiveId.current = { id: activeId };
        accept(null);
      }
    });
  }

  async function start(capture: ViewCapture, revision: number) {
    await runOperation(async () => {
      if (dirty.current) { setConfirmation("leave"); return; }
      const value = await host.createReview(capture, revision);
      ignoredActiveId.current = null;
      accept(value);
    });
  }

  async function open(id: string) {
    await runOperation(async () => {
      if (dirty.current) { setConfirmation("leave"); return; }
      // Suspend live rendering before network waits, especially during a cold Studio reload.
      setLoading(true); setStatus("Opening captured review...");
      try {
        const value = await host.getReview(id);
        await host.command("open_review", { id });
        ignoredActiveId.current = null;
        accept(value);
      } finally {
        setLoading(false);
      }
    });
  }

  function copyImage() {
    if (!current.current) return;
    const snapshot = structuredClone(current.current);
    // Start clipboard access in the gesture, before any asynchronous composition.
    void host.copyImage(composeReviewImage(snapshot)).then(
      () => setStatus("Marked image copied"),
      (error) => { setStatus("Image was not copied"); onError(message(error)); },
    );
  }

  async function downloadImage() {
    const snapshot = current.current && structuredClone(current.current);
    if (!snapshot) return;
    try {
      const image = await composeReviewImage(snapshot);
      const url = URL.createObjectURL(image);
      const link = document.createElement("a");
      link.href = url;
      link.download = `review-${snapshot.id}-local.png`;
      document.body.append(link);
      link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus("Local PNG download started — not saved to the server");
    } catch (error) { onError(`Local image was not downloaded: ${message(error)}`); }
  }

  async function saveImage() {
    let path: string | undefined;
    await runOperation(async () => {
      if (dirty.current) { onError("Drawing save is not confirmed. Use Download local image to export without a server save."); return; }
      const snapshot = current.current && structuredClone(current.current);
      if (!snapshot) return;
      setStatus("Saving marked image...");
      try {
        const result = await host.saveReviewImage(snapshot.id, snapshot.version, await composeReviewImage(snapshot));
        path = result.path;
        setStatus("Marked image saved");
      } catch (error) { setStatus("Marked image was not saved"); throw error; }
    });
    return path;
  }

  async function captureRequested(request: CaptureRequest) {
    await pending.current;
    const value = current.current;
    if (dirty.current || operation.current || !value || value.id !== request.reviewId || value.version !== request.reviewVersion) {
      throw new Error("The drawing changed or is not saved yet. Retry capture after saving finishes.");
    }
    return composeReviewImage(structuredClone(value));
  }

  return {
    review, items, saving, working, status, recovery, confirmation, active: !!review || loading,
    saveError: !!recovery, start, close: () => leave(false), onChange, copyImage, downloadImage, saveImage,
    captureRequested, retrySave, saveCopy, open,
    confirmLeave: () => setConfirmation("leave"),
    confirmLoad: () => setConfirmation("load"),
    cancelConfirmation: () => setConfirmation(null),
    discard: () => confirmation === "load" ? loadServer() : leave(true),
  };
}
