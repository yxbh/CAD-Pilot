import { useLayoutEffect, useMemo, useRef } from "react";
import type { AnalysisLegend } from "../../shared/analysis.mjs";
import { drawLegend, legendSize, legendText } from "../analysis/legend.ts";

// The analysis legend over the view's top-left corner, drawn as captures draw it.
export function LegendOverlay({ legend }: { legend: AnalysisLegend }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const content = JSON.stringify(legend);
  const size = useMemo(() => legendSize(legend), [content]);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.ceil(size.width * ratio);
    element.height = Math.ceil(size.height * ratio);
    const context = element.getContext("2d")!;
    context.clearRect(0, 0, element.width, element.height);
    drawLegend(context, legend, 0, 0, ratio);
  }, [content]);
  return <canvas ref={canvas} className="analysis-legend" role="img" aria-label={legendText(legend)} style={{ width: size.width, height: size.height }} />;
}
