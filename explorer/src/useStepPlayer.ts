import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewState } from "./model.ts";

const millisecondsPerStep = 650;
const pauseBetweenSteps = 450;

export type StepPlayer = ReturnType<typeof useStepPlayer>;

// The displayed sequence position animates toward the committed step. Render reports and captures wait
// until they match, as they do for the explosion slider and section plane drafts.
export function useStepPlayer({ state, run }: {
  state: ViewState | null;
  run: (name: string, input?: object) => Promise<unknown>;
}) {
  const count = state?.assembly?.steps.length ?? 0;
  const committed = state?.step ?? null;
  const [position, setPosition] = useState<number | null>(committed);
  const [playing, setPlaying] = useState(false);
  const shown = useRef(position);
  shown.current = position;
  const frame = useRef(0);
  const scrubbing = useRef(false);

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    if (scrubbing.current) return;
    // Turning the sequence on or off moves from or back to the assembled pose, which equals the last step.
    const target = committed ?? count;
    const start = shown.current ?? count;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!count || reduced || start === target) { setPosition(committed); return; }
    const duration = Math.min(1500, Math.abs(target - start) * millisecondsPerStep);
    const began = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      if (t < 1) {
        setPosition(start + (target - start) * eased);
        frame.current = requestAnimationFrame(tick);
      } else setPosition(committed);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [committed, count, state?.topologyRevision]);

  useEffect(() => {
    if (!playing) return;
    if (committed === null || committed >= count) { setPlaying(false); return; }
    if (position !== committed) return;
    const timer = setTimeout(() => void run("set_step", { step: committed + 1 }), pauseBetweenSteps);
    return () => clearTimeout(timer);
  }, [playing, position, committed, count, run]);

  const go = useCallback((step: number | null) => {
    setPlaying(false);
    return run("set_step", { step });
  }, [run]);
  const preview = useCallback((value: number) => {
    setPlaying(false);
    scrubbing.current = true;
    cancelAnimationFrame(frame.current);
    setPosition(value);
  }, []);
  const commit = useCallback((value: number) => {
    scrubbing.current = false;
    const step = Math.round(value);
    // Re-committing the same step still has to settle the dragged position.
    if (step === committed) setPosition(committed);
    else void run("set_step", { step });
  }, [committed, run]);
  const togglePlay = useCallback(async () => {
    if (playing) { setPlaying(false); return; }
    // Restart from the beginning once the committed step has moved there, so the end check does not stop playback.
    if (committed === null || committed >= count) await run("set_step", { step: 0 });
    setPlaying(true);
  }, [playing, committed, count, run]);
  return { count, committed, position, playing, go, preview, commit, togglePlay };
}
