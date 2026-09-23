import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { displayedWorldBounds } from "../shared/placement.mjs";
import { sectionAxisIndex, sectionSupport, type SectionSettings } from "../shared/section.mjs";
import type { Model, ViewState } from "./model.ts";

type RunCommand = (name: string, input?: object, onFailure?: (failure: Error) => void) => Promise<unknown>;

export function useSectionControl({ model, state, amount, latest, queue, run, onError }: {
  model: Model | null;
  state: ViewState | null;
  amount: number;
  latest: RefObject<ViewState | null>;
  queue: RefObject<Promise<unknown>>;
  run: RunCommand;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [input, setInput] = useState("0");
  const committed = state?.section;
  const support = useMemo(() => sectionSupport(model), [model]);
  // The range follows the explosion preview so the slider matches what is drawn.
  const bounds = useMemo(() => model && state ? displayedWorldBounds(model, { ...state, explode: amount }) : null,
    [model, amount, state?.direction, state?.fixedId, state?.hiddenIds]);
  const axis = committed?.axis ?? "x";
  const index = sectionAxisIndex(axis);
  const min = bounds?.min[index] ?? committed?.position ?? 0;
  const max = bounds?.max[index] ?? committed?.position ?? 0;
  const span = max - min;
  const hasVisibleParts = !!bounds;
  const show = useCallback((value: number) => { setPosition(value); setInput(String(value)); }, []);
  const clamped = useCallback((value: number) => hasVisibleParts ? Math.min(max, Math.max(min, value)) : value, [hasVisibleParts, min, max]);
  const revert = useCallback(() => show(clamped(latest.current?.section.position ?? 0)), [clamped, latest, show]);

  // Discard an uncommitted draft whenever the committed plane, displayed range or panel visibility changes.
  useEffect(() => {
    if (committed) show(clamped(committed.position));
  }, [committed?.position, committed?.axis, state?.topologyRevision, open, clamped, show]);

  const apply = useCallback(async (change: Partial<SectionSettings>, onFailure?: (failure: Error) => void) => {
    await queue.current;
    // The server validates the plane against the committed pose, so commit a previewed explosion first.
    if (latest.current && amount !== latest.current.explode) await run("set_explode", { amount });
    await run("set_section", change, onFailure);
  }, [amount, latest, queue, run]);

  function commitPosition(value: string) {
    const next = value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(next)) {
      onError("Section position must be a finite model-world millimeter value.");
      revert();
      return;
    }
    if (!hasVisibleParts) {
      onError("Show a part before changing the section plane position.");
      revert();
      return;
    }
    if (next < min || next > max) {
      onError(`Section position must be between ${min} and ${max} on the displayed ${axis.toUpperCase()} model axis.`);
      revert();
      return;
    }
    show(next);
    if (next !== latest.current?.section.position) void apply({ position: next }, revert);
  }

  return {
    open, setOpen, support, axis, min, max, input,
    step: span > 0 ? span / 1024 : 0.001,
    hasVisibleParts,
    section: committed ?? null,
    // Scene draws this preview until the committed state catches up.
    position,
    apply,
    commitPosition,
    preview: show,
    previewInput(text: string) {
      setInput(text);
      const value = text.trim() ? Number(text) : NaN;
      if (Number.isFinite(value)) setPosition(value);
    },
    revert,
    // Reset uses the X midpoint of the displayed pose, matching a newly opened STEP.
    reset() {
      if (bounds) void apply({ enabled: false, axis: "x", position: (bounds.min[0] + bounds.max[0]) / 2, flipped: false });
    },
  };
}

export type SectionControl = ReturnType<typeof useSectionControl>;
