import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Pause, Play, TriangleAlert, X } from "lucide-react";
import type { ViewState } from "../model.ts";
import type { StepPlayer } from "../useStepPlayer.ts";
import { IconButton } from "./IconButton";

const checkLabels = { blocked: "Blocked", interferes: "Overlaps when installed", error: "Check failed" } as const;

export function AssemblyPanel({ state, player, busy, run }: {
  state: ViewState;
  player: StepPlayer;
  busy: boolean;
  run: (name: string, input?: object) => Promise<unknown>;
}) {
  const sequence = state.assembly;
  if (!sequence || player.committed === null) return null;
  const { count, committed, position } = player;
  const step = committed > 0 ? sequence.steps[committed - 1] : null;
  const shown = position ?? committed;
  const problems = [
    sequence.stale && "This sequence was written for a different version of the STEP; part names were matched again.",
    ...sequence.steps.flatMap((item, index) => item.unresolved.length ? [`Step ${index + 1} names missing parts: ${item.unresolved.join(", ")}`] : []),
  ].filter(Boolean) as string[];
  return <div className="assembly-panel" role="region" aria-label="Assembly steps">
    <div className="panel-heading">
      <strong>{committed === 0 ? `Parts laid out · ${count} steps` : `Step ${committed} of ${count}`}</strong>
      <div className="assembly-mode" role="group" aria-label="Waiting parts">
        <button aria-pressed={state.stepMode === "exploded"} disabled={busy} onClick={() => void run("set_step", { mode: "exploded" })}>Exploded</button>
        <button aria-pressed={state.stepMode === "buildup"} disabled={busy} onClick={() => void run("set_step", { mode: "buildup" })}>Build up</button>
      </div>
      <IconButton label="Close assembly steps" icon={X} onClick={() => void player.go(null)} />
    </div>
    <p className="assembly-title">{step ? step.title : "Every part waits where its step brings it in from."}</p>
    {step?.note && <p className="assembly-note">{step.note}</p>}
    {step?.check && step.check.status !== "clear" && <p className="assembly-check" role="status">
      <TriangleAlert size={13} aria-hidden="true" /> {checkLabels[step.check.status]}: {step.check.detail}</p>}
    {step?.check?.status === "clear" && <p className="assembly-note">Geometry check: {step.check.detail}</p>}
    {problems.map((problem) => <p key={problem} className="assembly-check" role="status"><TriangleAlert size={13} aria-hidden="true" /> {problem}</p>)}
    <div className="assembly-controls">
      <IconButton label="First step" icon={ChevronFirst} disabled={busy || committed === 0} onClick={() => void player.go(0)} />
      <IconButton label="Previous step" icon={ChevronLeft} disabled={busy || committed === 0} onClick={() => void player.go(committed - 1)} />
      <IconButton label={player.playing ? "Pause" : "Play steps"} icon={player.playing ? Pause : Play} disabled={busy} onClick={() => void player.togglePlay()} />
      <IconButton label="Next step" icon={ChevronRight} disabled={busy || committed >= count} onClick={() => void player.go(committed + 1)} />
      <IconButton label="Fully assembled" icon={ChevronLast} disabled={busy || committed >= count} onClick={() => void player.go(count)} />
      <input aria-label="Assembly step" type="range" min={0} max={count} step={0.01} value={shown} disabled={busy}
        onChange={(event) => player.preview(Number(event.target.value))}
        onPointerUp={(event) => player.commit(Number(event.currentTarget.value))}
        onPointerCancel={player.revert}
        onKeyUp={(event) => player.commit(Number(event.currentTarget.value))}
        onBlur={(event) => player.commit(Number(event.currentTarget.value))} />
      <output>{committed}/{count}</output>
    </div>
    <p className="assembly-footnote">Display only. Parts move between their placements in the STEP; the STEP itself is unchanged.</p>
  </div>;
}
