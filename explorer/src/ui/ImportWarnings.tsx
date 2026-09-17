import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, TriangleAlert, X } from "lucide-react";
import type { Model } from "../model.ts";
import { IconButton } from "./IconButton.tsx";

export function ImportWarnings({ warnings, cleanup, sourceName, target, onOpen }: {
  warnings: string[];
  cleanup: Model["cleanup"];
  sourceName: string;
  target: HTMLDivElement | null;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const hasCleanup = cleanup && (cleanup.degenerateEdges !== 0 || cleanup.zeroAreaTriangles !== 0);
  const title = warnings.length ? `Import warnings (${warnings.length})` : "Import information";
  const closeLabel = warnings.length ? "Close import warnings" : "Close import information";
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!open || !target) return;
    panel.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, target]);
  if (!warnings.length && !hasCleanup) return null;
  return <>
    <IconButton label={title} icon={warnings.length ? TriangleAlert : Info} className={warnings.length ? "warning-button" : "information-button"}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={(event) => {
        trigger.current = event.currentTarget;
        if (!open) onOpen();
        setOpen((value) => !value);
      }}>
      {warnings.length > 0 && <span className="warning-count" aria-hidden="true">{warnings.length > 99 ? "99+" : warnings.length}</span>}
    </IconButton>
    {open && target && createPortal(
      <div className={`import-warnings-panel${warnings.length ? "" : " information-panel"}`} id={id} ref={panel} tabIndex={-1} role="dialog"
        aria-labelledby={`${id}-heading`} aria-describedby={`${id}-source`}>
        <div className="panel-heading">
          <strong id={`${id}-heading`}>{title}</strong>
          <IconButton label={closeLabel} icon={X} onClick={close} />
        </div>
        <div className="import-warnings-content" tabIndex={0} role="region" aria-label={warnings.length ? "Import warning details" : "Import information details"}>
          <p id={`${id}-source`}>{sourceName}</p>
          {warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          {hasCleanup && <section className="import-cleanup" aria-label="Display geometry cleanup">
            <strong className="eyebrow">Low-priority information</strong>
            <p>Simplified display geometry; no CAD faces were removed.</p>
            <dl>
              {cleanup.degenerateEdges !== 0 && <><dt>Point edges omitted from selection</dt><dd>{cleanup.degenerateEdges ?? "Count unavailable"}</dd></>}
              {cleanup.zeroAreaTriangles !== 0 && <><dt>Collapsed display triangles omitted</dt><dd>{cleanup.zeroAreaTriangles ?? "Count unavailable"}</dd></>}
            </dl>
            <p>Counts describe reusable part geometry, not repeated placements.
              {(cleanup.degenerateEdges === null || cleanup.zeroAreaTriangles === null) && " This older import did not record exact cleanup counts."}</p>
          </section>}
        </div>
      </div>, target)}
  </>;
}
