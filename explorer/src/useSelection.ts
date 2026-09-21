import { useEffect, useRef, useState, type RefObject } from "react";
import type { Model, ViewState } from "./model.ts";
import type { ViewerHost } from "./host.ts";

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

  function copySelection(id: string, faceId?: string, edgeId?: string) {
    if (!model) return;
    const sequence = ++copySequence.current;
    const result = host.copyReference(model, id, faceId, edgeId);
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

  function select(id: string, faceId?: string, edgeId?: string) {
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
      const copied = (pendingAutoCopy ?? latest.current?.autoCopy ?? true) ? copySelection(id, faceId, edgeId) : undefined;
      const sequence = copySequence.current;
      void run(edgeId ? "select_edge" : faceId ? "select_face" : "select_parts", edgeId
        ? { id, edgeId, topologyRevision: model.topologyRevision } : faceId
        ? { id, faceId, topologyRevision: model.topologyRevision }
        : { ids: [id], topologyRevision: model.topologyRevision }, (failure) => {
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
