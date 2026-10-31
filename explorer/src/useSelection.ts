import { useEffect, useRef, useState, type RefObject } from "react";
import type { Model, PointSelection, ViewState } from "./model.ts";
import type { ViewerHost } from "./host.ts";
import { roundPoint } from "../shared/references.mjs";

type CopyStatus = { kind: "idle" | "pending" | "copied" | "blocked"; message: string; text: string };
type RunCommand = (name: string, input?: object, onFailure?: (failure: Error) => void) => Promise<unknown>;
const idleCopy: CopyStatus = { kind: "idle", message: "", text: "" };

export function useSelection({ host, model, state, latest, run, onError }: {
  host: ViewerHost;
  model: Model | null;
  state: ViewState | null;
  latest: RefObject<ViewState | null>;
  run: RunCommand;
  onError: (message: string) => void;
}) {
  const [pendingAutoCopy, setPendingAutoCopy] = useState<boolean | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>(idleCopy);
  const copySequence = useRef(0);
  useEffect(() => {
    copySequence.current++;
    host.cancelPendingCopy();
    setCopyStatus(idleCopy);
    return () => { copySequence.current++; host.cancelPendingCopy(); };
  }, [host, state?.topologyRevision, state?.modelName]);

  async function setAutoCopy(enabled: boolean) {
    copySequence.current++;
    host.cancelPendingCopy();
    setCopyStatus(idleCopy);
    setPendingAutoCopy(enabled);
    await run("set_auto_copy", { enabled });
    setPendingAutoCopy(null);
  }

  function copySelection(id: string, faceId?: string, edgeId?: string, point?: Pick<PointSelection, "triangle" | "point">) {
    if (!model) return;
    const sequence = ++copySequence.current;
    const result = host.copyReference(model, id, faceId, edgeId, point);
    setCopyStatus({ kind: "pending", message: "Copying reference...", text: "" });
    void result.then(({ prepared, result: outcome }) => {
      if (sequence !== copySequence.current) return;
      setCopyStatus(outcome.ok
        ? { kind: "copied", message: `Copied ${prepared.title}`, text: prepared.text }
        : { kind: "blocked", message: outcome.error, text: prepared.text });
    }, (failure: Error) => {
      if (sequence !== copySequence.current) return;
      setCopyStatus(idleCopy);
      onError(`Reference was not copied: ${failure.message}`);
    });
    return result;
  }

  function select(id: string, faceId?: string, edgeId?: string, picked?: Pick<PointSelection, "triangle" | "point">) {
    if (latest.current?.activeReviewId) return;
    copySequence.current++;
    host.cancelPendingCopy();
    setCopyStatus(idleCopy);
    if (!id) { void run("select_parts", { ids: [] }); return; }
    if (!model || model.topologyRevision !== state?.topologyRevision || model.source.name !== state.modelName || state.loading) {
      onError("The displayed model is updating. Select the geometry again when loading finishes.");
      return;
    }
    try {
      // Copy starts in the user's gesture, independently of the queued state command.
      // The server keeps picked points to the micrometre, so the copied reference matches the saved selection.
      const point = picked && { triangle: picked.triangle, point: roundPoint(picked.point) };
      const copied = (pendingAutoCopy ?? latest.current?.autoCopy ?? true) ? copySelection(id, faceId, edgeId, point) : undefined;
      const sequence = copySequence.current;
      const topologyRevision = model.topologyRevision;
      void run(edgeId ? "select_edge" : faceId ? "select_face" : point ? "select_point" : "select_parts", edgeId
        ? { id, edgeId, topologyRevision } : faceId
        ? { id, faceId, topologyRevision } : point
        ? { id, ...point, topologyRevision }
        : { ids: [id], topologyRevision }, (failure) => {
          if (!copied) return;
          void copied.then(({ result }) => {
            if (sequence === copySequence.current && result.ok) onError(`Reference copied, but the selection could not be saved: ${failure.message}`);
          }, () => undefined);
        });
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return {
    select, copySelection, setAutoCopy, copyStatus,
    autoCopyEnabled: pendingAutoCopy ?? state?.autoCopy ?? true,
    autoCopyPending: pendingAutoCopy !== null,
    dismissCopyStatus: () => setCopyStatus((current) => ({ ...current, kind: "idle", message: "" })),
  };
}
