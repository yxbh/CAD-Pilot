import { useSyncExternalStore } from "react";
import { Quaternion, Vector3 } from "three";
import { axisViews, type ViewPreset } from "./camera.ts";

export function createAxisStore() {
  const listeners = new Set<() => void>();
  let snapshot = axisViews.map((axis) => ({ ...axis, x: 0, y: 0, depth: 0 }));
  let previous = "";
  return {
    get: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(rotation: Quaternion) {
      const inverse = rotation.clone().invert();
      const next = axisViews.map((axis) => {
        const point = new Vector3(...axis.direction).applyQuaternion(inverse);
        return { ...axis, x: Math.round(point.x * 31), y: Math.round(-point.y * 31), depth: point.z };
      }).sort((a, b) => a.depth - b.depth);
      const key = JSON.stringify(next.map(({ x, y, depth }) => [x, y, Math.round(depth * 100)]));
      if (key === previous) return;
      previous = key; snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
export type AxisStore = ReturnType<typeof createAxisStore>;

export function AxisIndicator({ store, onChoose }: { store: AxisStore; onChoose: (view: ViewPreset) => void }) {
  const axes = useSyncExternalStore(store.subscribe, store.get);
  return <div className="axis-indicator" role="group" aria-label="View orientation: X red, Y green, Z blue">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      {axes.map((axis) => <line key={axis.id} x1="50" y1="50" x2={50 + axis.x} y2={50 + axis.y}
        stroke={axis.color} strokeWidth={axis.axis.startsWith("+") ? 2 : 1} opacity={axis.depth < 0 ? 0.35 : 0.8} />)}
      <circle cx="50" cy="50" r="3" fill="#a9becb" />
    </svg>
    {axes.map((axis) => <button key={axis.id} type="button" title={axis.label} aria-label={`Orientation: ${axis.label}`}
      style={{ left: `${50 + axis.x}%`, top: `${50 + axis.y}%`, color: axis.color, opacity: axis.depth < -0.05 ? 0.55 : 1 }}
      onClick={() => onChoose(axis.id)}>{axis.axis}</button>)}
    <span className="axis-caption">X / Y / Z</span>
  </div>;
}
