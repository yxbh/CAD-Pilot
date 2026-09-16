import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert, X } from "lucide-react";
import { IconButton } from "./IconButton.tsx";

export function ImportWarnings({ warnings, sourceName, target }: {
  warnings: string[];
  sourceName: string;
  target: HTMLDivElement | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
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
  return <>
    <IconButton label={`Import warnings (${warnings.length})`} icon={TriangleAlert} className="warning-button"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={(event) => {
        trigger.current = event.currentTarget;
        setOpen((value) => !value);
      }}>
      <span className="warning-count" aria-hidden="true">{warnings.length > 99 ? "99+" : warnings.length}</span>
    </IconButton>
    {open && target && createPortal(
      <div className="import-warnings-panel" id={id} ref={panel} tabIndex={-1} role="dialog"
        aria-labelledby={`${id}-heading`} aria-describedby={`${id}-source`}>
        <div className="panel-heading">
          <strong id={`${id}-heading`}>Import warnings ({warnings.length})</strong>
          <IconButton label="Close import warnings" icon={X} onClick={close} />
        </div>
        <div className="import-warnings-content" tabIndex={0} role="region" aria-label="Import warning details">
          <p id={`${id}-source`}>{sourceName}</p>
          <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </div>
      </div>, target)}
  </>;
}
