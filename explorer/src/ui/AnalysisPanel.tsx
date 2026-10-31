import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { directionLabel, parseDirection, type AnalysisSettings } from "../../shared/analysis.mjs";
import { IconButton } from "./IconButton";

const MAPS = [["none", "Shaded"], ["overhang", "Overhangs"], ["thickness", "Wall thickness"], ["curvature", "Curvature"], ["zebra", "Zebra stripes"]];
const DIRECTIONS = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];
const OVERLAYS = [["triangleEdges", "Triangle edges"], ["backfaces", "Back faces"], ["normals", "Normals"]] as const;

// A number typed in full before it is sent: on Enter or leaving the field. Empty means none where that is allowed.
function NumberField({ label, value, unit, step, min, max, optional, onCommit }: {
  label: string; value: number | null; unit: string; step: number; min?: number; max?: number; optional?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const next = draft.trim() === "" ? null : Number(draft);
    if (next === null ? !optional : !Number.isFinite(next)) return setDraft(value === null ? "" : String(value));
    if (next !== value) onCommit(next);
  };
  return <label className="analysis-number">{label}
    <input type="number" aria-label={label} value={draft} step={step} min={min} max={max} placeholder={optional ? "auto" : undefined}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <span>{unit}</span>
  </label>;
}

export function AnalysisPanel({ analysis, busy, apply, onClose }: {
  analysis: AnalysisSettings; busy: boolean; apply: (input: Partial<AnalysisSettings>) => void; onClose: () => void;
}) {
  const direction = directionLabel(analysis.buildDirection);
  return <div className="appearance-popover analysis-popover" role="dialog" aria-label="Analysis views"
    onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <div className="panel-heading"><strong>Analysis</strong><IconButton label="Close analysis views" icon={X} onClick={onClose} /></div>
    <fieldset disabled={busy}>
      <label>Colour map <select aria-label="Colour map" value={analysis.map} onChange={(event) => apply({ map: event.target.value as AnalysisSettings["map"] })}>
        {MAPS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      {analysis.map === "overhang" && <>
        <NumberField label="Overhang from vertical" value={analysis.overhangAngle} unit="°" step={1} min={0} max={89}
          onCommit={(value) => apply({ overhangAngle: value! })} />
        <label>Build direction <select aria-label="Build direction" value={direction}
          onChange={(event) => apply({ buildDirection: parseDirection(event.target.value) })}>
          {(DIRECTIONS.includes(direction) ? DIRECTIONS : [...DIRECTIONS, direction]).map((name) => <option key={name} value={name}>{name}</option>)}
        </select></label>
      </>}
      {analysis.map === "thickness" && <NumberField label="Minimum wall" value={analysis.minimumWall} unit="mm" step={0.1} min={0.01}
        onCommit={(value) => apply({ minimumWall: value! })} />}
      {analysis.map === "curvature" && <>
        <label>Curvature <select aria-label="Curvature" value={analysis.curvature}
          onChange={(event) => apply({ curvature: event.target.value as AnalysisSettings["curvature"] })}>
          <option value="mean">Mean</option><option value="gaussian">Gaussian</option>
        </select></label>
        <NumberField label="Scale" value={analysis.curvatureScale} unit={analysis.curvature === "mean" ? "/mm" : "/mm²"} step={0.01} min={0} optional
          onCommit={(value) => apply({ curvatureScale: value })} />
      </>}
      <div className="analysis-overlays" role="group" aria-label="Overlays">
        {OVERLAYS.map(([key, name]) => <label key={key}><input type="checkbox" checked={analysis[key]}
          onChange={(event) => apply({ [key]: event.target.checked })} /> {name}</label>)}
      </div>
    </fieldset>
    <p>Drawn from the triangles shown, as review aids rather than print checks. Files stay unchanged.</p>
  </div>;
}
