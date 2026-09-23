import { X } from "lucide-react";
import { SECTION_AXES } from "../../shared/section.mjs";
import type { SectionControl } from "../useSectionControl.ts";
import { IconButton } from "./IconButton";

export function SectionPanel({ control, busy }: { control: SectionControl; busy: boolean }) {
  const { section, support, axis } = control;
  const label = axis.toUpperCase();
  return <div className="section-popover" role="dialog" aria-label="Section view settings"
    onKeyDown={(event) => { if (event.key === "Escape") control.setOpen(false); }}>
    <div className="panel-heading"><strong>Section view</strong>
      <IconButton label="Close section view settings" icon={X} onClick={() => control.setOpen(false)} /></div>
    <label className="section-switch"><input type="checkbox" role="switch" aria-label="Enable section view"
      checked={section?.enabled ?? false} disabled={!support.supported || busy}
      onChange={(event) => void control.apply({ enabled: event.target.checked })} /> Cut away model</label>
    {!support.supported && <p className="section-unavailable" role="status">Unavailable: {support.message}</p>}
    <fieldset disabled={!section?.enabled || busy || !support.supported || !control.hasVisibleParts}>
      <legend>Plane axis</legend>
      <div className="section-axis" role="group" aria-label="Section plane axis">
        {SECTION_AXES.map((option) => <button key={option} aria-pressed={axis === option}
          onClick={() => void control.apply({ axis: option })}>{option.toUpperCase()}</button>)}
      </div>
      <label className="section-coordinate">Position
        <input aria-label="Section position in model-world millimeters" type="number" min={control.min} max={control.max}
          step={control.step} value={control.input}
          onChange={(event) => control.previewInput(event.target.value)}
          onBlur={(event) => control.commitPosition(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <span>mm</span>
      </label>
      <input className="section-slider" aria-label="Section plane position" type="range"
        min={control.min} max={control.max} step={control.step} value={control.position}
        onChange={(event) => control.preview(Number(event.target.value))}
        onPointerUp={(event) => control.commitPosition(event.currentTarget.value)}
        onPointerCancel={control.revert}
        onKeyUp={(event) => control.commitPosition(event.currentTarget.value)} />
      <output className="section-readout">{label} = {control.position.toFixed(2)} mm · model axes / displayed pose</output>
      <label className="section-flip"><input type="checkbox" checked={section?.flipped ?? false}
        onChange={(event) => void control.apply({ flipped: event.target.checked })} />
        Flip hidden half <span>{section?.flipped ? `keep ${label} ≥ plane` : `keep ${label} ≤ plane`}</span>
      </label>
    </fieldset>
    {!control.hasVisibleParts && <p className="section-unavailable" role="status">Show a part to move the section plane. Its last coordinate is preserved while everything is hidden.</p>}
    <div className="section-actions">
      <button onClick={() => void control.apply({ enabled: false })}>Off</button>
      <button disabled={!control.hasVisibleParts} onClick={control.reset}>Reset</button>
    </div>
    <p>Visual inspection only. Exploded offsets extend the slider's displayed range but are not physical CAD measurements. Cut caps are not CAD faces; the STEP and print files stay unchanged.</p>
  </div>;
}
