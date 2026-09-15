import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowUpRight, Circle, Copy, Download, Eraser, Highlighter, Minus,
  MoveHorizontal, Pencil, Redo2, Square, Trash2, Undo2, type LucideIcon,
} from 'lucide-react';
import {
  addStroke, appendStrokePoint, clearDrawing, eraseStrokes, geometryPath, getImageBounds,
  hitTestStroke, normalizedPoint, redoDrawing, strokeGeometry, undoDrawing, validateDrawing,
} from '../../shared/drawing.mjs';
import type { Point } from '../../shared/drawing.mjs';
import { validateReviewImage } from './render';
import type { DrawingState, Review, Stroke, Tool } from './types';
import { IconButton } from '../ui/IconButton';
import './drawing.css';

type Props = {
  review: Review;
  onChange: (drawing: DrawingState) => void;
  onClose: () => void;
  onCopyImage: () => void;
  onSaveImage: () => void;
  onError: (message: string) => void;
  status: string;
  saving: boolean;
  readOnly?: boolean;
  toolbarTarget?: HTMLElement | null;
};

type Drag = {
  pointerId: number;
  surface: SVGSVGElement;
  base: DrawingState;
  stroke: Stroke | null;
  erased: Set<string>;
  last: Point | null;
  tolerance: number;
};

const toolButtons: { tool: Tool | 'erase'; label: string; icon: LucideIcon }[] = [
  { tool: 'pen', label: 'Pen', icon: Pencil }, { tool: 'line', label: 'Line', icon: Minus },
  { tool: 'arrow', label: 'Arrow', icon: ArrowUpRight }, { tool: 'double-arrow', label: 'Double arrow', icon: MoveHorizontal },
  { tool: 'rectangle', label: 'Rectangle', icon: Square }, { tool: 'ellipse', label: 'Ellipse', icon: Circle },
  { tool: 'highlight', label: 'Highlight', icon: Highlighter }, { tool: 'erase', label: 'Erase', icon: Eraser },
];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function StrokePaths({ stroke, width, height }: { stroke: Stroke; width: number; height: number }) {
  return <g>
    {strokeGeometry(stroke, width, height).map((geometry, index) => <path key={index}
      d={geometryPath(geometry)} fill={geometry.fill ? stroke.color : 'none'}
      stroke={geometry.fill ? 'none' : stroke.color} strokeWidth={stroke.width}
      strokeLinecap="round" strokeLinejoin="round" opacity={geometry.opacity} />)}
  </g>;
}

export default function DrawingReview({ review, onChange, onClose, onCopyImage, onSaveImage, onError, status, saving, readOnly = false, toolbarTarget }: Props) {
  const [tool, setTool] = useState<Tool | 'erase'>('pen');
  const [color, setColor] = useState('#84dec8');
  const [width, setWidth] = useState(3);
  const [transient, setTransient] = useState<{ stroke: Stroke | null; erased: Set<string> } | null>(null);
  const [localError, setLocalError] = useState('');
  const [decodedImage, setDecodedImage] = useState<{ url: string; error: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const validation = useMemo(() => {
    try {
      validateReviewImage(review.image);
      return { drawing: validateDrawing(review.drawing), error: '' };
    } catch (error) {
      return { drawing: null, error: errorMessage(error) };
    }
  }, [review.drawing, review.image]);
  const imageError = decodedImage?.url === review.image.dataUrl ? decodedImage.error : '';
  const imageReady = decodedImage?.url === review.image.dataUrl && !imageError;
  const error = validation.error || imageError || localError;
  const ready = Boolean(validation.drawing && imageReady && !readOnly);

  function report(reason: unknown) {
    const message = errorMessage(reason);
    setLocalError(message);
    errorHandler.current(message);
  }

  function cancelDrag() {
    const active = drag.current;
    drag.current = null;
    setTransient(null);
    if (active?.surface.hasPointerCapture(active.pointerId)) active.surface.releasePointerCapture(active.pointerId);
  }

  useEffect(() => {
    if (validation.error) errorHandler.current(validation.error);
  }, [validation.error]);

  useEffect(() => {
    cancelDrag();
    setLocalError('');
  }, [review.id, review.drawing, review.image.dataUrl, review.image.width, review.image.height, readOnly]);

  useEffect(() => {
    if (validation.error) return;
    const image = new Image();
    let active = true;
    setDecodedImage(null);
    const finish = (message: string) => {
      if (!active) return;
      window.clearTimeout(timer);
      setDecodedImage({ url: review.image.dataUrl, error: message });
      if (message) errorHandler.current(message);
    };
    const timer = window.setTimeout(() => finish('Captured image could not be decoded in time.'), 15000);
    image.onload = () => finish(image.naturalWidth === review.image.width && image.naturalHeight === review.image.height
      ? '' : 'Captured PNG dimensions do not match the review.');
    image.onerror = () => finish('Captured PNG is corrupt or cannot be decoded.');
    image.src = review.image.dataUrl;
    return () => {
      active = false;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
    };
  }, [review.image.dataUrl, review.image.width, review.image.height, validation.error]);

  useEffect(() => () => {
    const active = drag.current;
    drag.current = null;
    if (active?.surface.hasPointerCapture(active.pointerId)) active.surface.releasePointerCapture(active.pointerId);
  }, []);

  function change(action: (state: DrawingState) => DrawingState) {
    if (!validation.drawing || readOnly) return;
    cancelDrag();
    try {
      const next = action(validation.drawing);
      if (next !== validation.drawing) onChange(next);
      setLocalError('');
    } catch (reason) { report(reason); }
  }

  function eraseAt(active: Drag, p: Point) {
    const previous = active.last ?? p;
    const distance = Math.hypot((p[0] - previous[0]) * review.image.width, (p[1] - previous[1]) * review.image.height);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, active.tolerance)));
    for (let i = 0; i <= steps; i++) {
      const at: Point = [previous[0] + (p[0] - previous[0]) * i / steps, previous[1] + (p[1] - previous[1]) * i / steps];
      for (const stroke of active.base.present) {
        if (!active.erased.has(stroke.id) && hitTestStroke(stroke, at, review.image.width, review.image.height, active.tolerance)) active.erased.add(stroke.id);
      }
    }
    active.last = p;
  }

  function pointFor(event: { clientX: number; clientY: number }, surface: SVGSVGElement) {
    return normalizedPoint(event.clientX, event.clientY, surface.getBoundingClientRect(), review.image.width, review.image.height);
  }

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || !validation.drawing || drag.current || event.button !== 0 || !event.isPrimary) return;
    try {
      const p = pointFor(event, event.currentTarget);
      if (!p) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = getImageBounds(event.currentTarget.getBoundingClientRect(), review.image.width, review.image.height);
      const active: Drag = {
        pointerId: event.pointerId, surface: event.currentTarget, base: validation.drawing,
        stroke: tool === 'erase' ? null : {
          id: crypto.randomUUID(), tool, color, width, points: tool === 'pen' ? [p] : [p, p],
        },
        erased: new Set(), last: p, tolerance: 6 * review.image.width / bounds.width,
      };
      drag.current = active;
      if (tool === 'erase') eraseAt(active, p);
      setTransient({ stroke: active.stroke, erased: new Set(active.erased) });
      setLocalError('');
    } catch (reason) { cancelDrag(); report(reason); }
  }

  function updatePointer(event: ReactPointerEvent<SVGSVGElement>, force: boolean) {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of [...samples, event.nativeEvent]) {
      const p = pointFor(sample, active.surface);
      if (!p) { active.last = null; continue; }
      if (active.stroke) active.stroke = appendStrokePoint(active.stroke, p, review.image.width, review.image.height, force);
      else eraseAt(active, p);
    }
    setTransient({ stroke: active.stroke, erased: new Set(active.erased) });
  }

  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    try { updatePointer(event, false); }
    catch (reason) { cancelDrag(); report(reason); }
  }

  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    try {
      updatePointer(event, true);
      cancelDrag();
      if (active.base !== validation.drawing) throw new Error('The review changed while drawing. Please retry the stroke.');
      if (active.stroke) {
        const [a, b] = [active.stroke.points[0], active.stroke.points.at(-1)!];
        if (active.stroke.tool !== 'pen' && Math.hypot((b[0] - a[0]) * review.image.width, (b[1] - a[1]) * review.image.height) < 1) return;
        onChange(addStroke(active.base, active.stroke));
      } else if (active.erased.size) onChange(eraseStrokes(active.base, [...active.erased]));
    } catch (reason) { cancelDrag(); report(reason); }
  }

  function run(callback: () => void) {
    try { callback(); }
    catch (reason) { report(reason); }
  }

  const toolbar = <div className="drawing-toolbar" role="group" aria-label="Drawing tools">
    {!toolbarTarget && <IconButton label="Back to model" icon={ArrowLeft} onClick={() => { cancelDrag(); run(onClose); }} />}
    <div className="tool-group">
      {toolButtons.map(item => <IconButton key={item.tool} label={item.label} icon={item.icon}
        aria-pressed={tool === item.tool} disabled={!ready}
        onClick={() => { cancelDrag(); setTool(item.tool); }} />)}
    </div>
    <div className="tool-group drawing-options">
      <input className="stroke-color" type="color" aria-label="Stroke color" title="Stroke color" value={color} disabled={!ready}
        onChange={event => { cancelDrag(); setColor(event.currentTarget.value); }} />
      <select aria-label="Stroke width" title="Stroke width" value={width} disabled={!ready}
        onChange={event => { cancelDrag(); setWidth(Number(event.currentTarget.value)); }}>
        {Array.from({ length: 16 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} px</option>)}
      </select>
    </div>
    <div className="tool-group" role="group" aria-label="Drawing history">
      <IconButton label="Undo drawing" icon={Undo2} disabled={!ready || !validation.drawing?.past.length || !!transient} onClick={() => change(undoDrawing)} />
      <IconButton label="Redo drawing" icon={Redo2} disabled={!ready || !validation.drawing?.future.length || !!transient} onClick={() => change(redoDrawing)} />
      <IconButton label="Clear drawing" icon={Trash2} disabled={!ready || !validation.drawing?.present.length || !!transient} onClick={() => change(clearDrawing)} />
    </div>
    <div className="tool-group">
      <IconButton label="Copy marked image" icon={Copy} disabled={!ready || !!transient || saving} onClick={() => run(onCopyImage)} />
      <IconButton label="Save marked image" icon={Download} disabled={!ready || !!transient || saving} onClick={() => run(onSaveImage)} />
    </div>
  </div>;
  return <section className={`drawing-review${toolbarTarget ? ' is-embedded' : ''}`} aria-label="Captured view review" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); cancelDrag(); return; }
    if ((event.target as HTMLElement).matches('input, select, textarea')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      change(event.shiftKey ? redoDrawing : undoDrawing);
    }
  }}>
    {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
    {error && <div className="drawing-review-error" role="alert">{error}</div>}
    <div className="drawing-review-stage" aria-busy={!imageReady && !error}>
      {!validation.error && <svg className={`drawing-review-canvas${tool === 'erase' ? ' is-erasing' : ''}`}
        aria-label="Drawing canvas" role="img" tabIndex={0} viewBox={`0 0 ${review.image.width} ${review.image.height}`}
        preserveAspectRatio="xMidYMid meet" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
        onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
        onContextMenu={event => event.preventDefault()}>
        <image href={review.image.dataUrl} x={0} y={0} width={review.image.width} height={review.image.height} preserveAspectRatio="none" />
        <svg x={0} y={0} width={review.image.width} height={review.image.height} viewBox={`0 0 ${review.image.width} ${review.image.height}`} overflow="hidden" pointerEvents="none">
          {validation.drawing?.present.filter(stroke => !transient?.erased.has(stroke.id)).map(stroke =>
            <StrokePaths key={stroke.id} stroke={stroke} width={review.image.width} height={review.image.height} />)}
          {transient?.stroke && <StrokePaths stroke={transient.stroke} width={review.image.width} height={review.image.height} />}
        </svg>
      </svg>}
      {!imageReady && !error && <div className="drawing-review-loading">Loading captured view…</div>}
    </div>
    {!toolbarTarget && <div className="drawing-review-status" role="status" aria-live="polite">{status || (saving ? 'Saving drawing…' : 'Captured view')}</div>}
  </section>;
}
