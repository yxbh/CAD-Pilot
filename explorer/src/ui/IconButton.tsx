import { useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon?: LucideIcon;
  children?: ReactNode;
};

export function IconButton({ label, icon: Icon, children, className = "", disabled, ...props }: Props) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPosition({
      left: Math.max(100, Math.min(window.innerWidth - 100, rect.left + rect.width / 2)),
      top: rect.bottom > window.innerHeight - 50 ? Math.max(4, rect.top - 36) : rect.bottom + 7,
    });
  };
  return <span ref={anchor} className="icon-control" onMouseEnter={show} onMouseLeave={() => setPosition(null)}
    onFocus={show} onBlur={() => setPosition(null)}
    onKeyDown={(event) => { if (event.key === "Escape") setPosition(null); }}
    tabIndex={disabled ? 0 : undefined} aria-label={disabled ? label : undefined}>
    <button {...props} type={props.type ?? "button"} className={`icon-button ${className}`} disabled={disabled}
      aria-label={label} aria-describedby={position ? id : undefined}>
      {Icon && <Icon size={18} strokeWidth={1.7} aria-hidden="true" />}
      {children}
    </button>
    {position && createPortal(<span id={id} role="tooltip" className="icon-tooltip" style={position}>
      {label}{disabled ? " (unavailable)" : ""}
    </span>, document.body)}
  </span>;
}
