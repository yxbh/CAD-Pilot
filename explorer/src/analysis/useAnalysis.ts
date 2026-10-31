import { useEffect, useMemo, useState } from "react";
import { analysisFields, analysisKey, analysisLegend, type AnalysisLegend, type AnalysisSettings, type AnalysisStats } from "../../shared/analysis.mjs";
import type { Part, Placement } from "../model.ts";
import type { GeometryResources } from "../resources.ts";
import { fittedCurvatureScale } from "./fields.ts";

export type AnalysisView = {
  key: string; ready: boolean; stats: AnalysisStats; legend: AnalysisLegend | null;
  // The lowest scene coordinate along the build direction, where parts rest on the plate.
  plate: number;
  // Bumped as each part's data arrives, so its surfaces and overlays redraw.
  arrived: number;
};

/** The lowest point of the placed parts along a direction, in scene coordinates (world minus origin). */
export function plateHeight(placements: Placement[], direction: number[], origin: number[]): number {
  let lowest = Infinity;
  for (const { part, matrix } of placements) {
    // The direction in the part's own frame, and how far along it the part's frame has moved.
    const local = [0, 1, 2].map((column) => matrix[column * 4] * direction[0] + matrix[column * 4 + 1] * direction[1] + matrix[column * 4 + 2] * direction[2]);
    const offset = [0, 1, 2].reduce((sum, axis) => sum + (matrix[12 + axis] - origin[axis]) * direction[axis], 0);
    const aligned = local.filter((value) => Math.abs(value) > 1e-9).length === 1;
    let low = Infinity;
    if (aligned) {
      // Along an axis of the part's frame its bounds give the exact lowest point.
      const axis = local.findIndex((value) => Math.abs(value) > 1e-9);
      low = (local[axis] > 0 ? part.bounds.min[axis] : part.bounds.max[axis]) * local[axis];
    } else {
      const positions = part.mesh?.positions ?? part.positions;
      for (let index = 0; index < positions.length; index += 3) {
        low = Math.min(low, positions[index] * local[0] + positions[index + 1] * local[1] + positions[index + 2] * local[2]);
      }
    }
    lowest = Math.min(lowest, low + offset);
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

/**
 * The analysis data the shown solid parts need, requested from the geometry worker, with the legend and numbers it
 * leads to. ready is false until every part's data has arrived (or failed, which onError reports).
 */
export function useAnalysis({ analysis, placements, resources, origin, faults, onError }: {
  analysis: AnalysisSettings; placements: Placement[]; resources: GeometryResources; origin: number[]; faults: boolean;
  onError: (message: string) => void;
}): AnalysisView {
  const solid = placements.filter((placement) => !placement.node.ghost);
  const parts = [...new Map(solid.map(({ part }) => [part.id, part])).values()];
  const fields = analysisFields(analysis);
  const partsKey = parts.map((part) => part.id).join("\n");
  const fieldsKey = fields.join();
  const [arrived, setArrived] = useState(0);
  const ready = parts.every((part) => fields.every((field) => resources.analysisDone(part, field)));
  useEffect(() => {
    let active = true;
    // Data that arrived after this render read it, while no effect was listening, still needs a render.
    if (!ready && parts.every((part) => fields.every((field) => resources.analysisDone(part, field)))) setArrived((count) => count + 1);
    for (const part of parts) {
      for (const field of fields) {
        if (resources.analysisDone(part, field)) continue;
        resources.requestAnalysis(part, field).then(() => { if (active) setArrived((count) => count + 1); }, (error: Error) => {
          if (!active) return;
          onError(error.message);
          setArrived((count) => count + 1);
        });
      }
    }
    return () => { active = false; };
  }, [resources, partsKey, fieldsKey, onError, ready]);
  const stats = useMemo((): AnalysisStats => {
    if (!ready) return {};
    const data = parts.map((part: Part) => resources.analysis(part));
    if (analysis.map === "thickness") {
      const thinnest = Math.min(...data.map((entry) => entry.thickness?.thinnest ?? Infinity));
      return Number.isFinite(thinnest) ? { thinnest } : {};
    }
    if (analysis.map === "curvature") {
      return { curvatureScale: analysis.curvatureScale ?? fittedCurvatureScale(data.flatMap((entry) => entry.curvature ? [entry.curvature[analysis.curvature]] : [])) };
    }
    return {};
  }, [ready, arrived, partsKey, analysis.map, analysis.curvature, analysis.curvatureScale, resources]);
  const plate = useMemo(() => analysis.map === "overhang" ? plateHeight(solid, analysis.buildDirection, origin) : 0,
    [analysis.map, ...analysis.buildDirection, placements, origin]);
  return {
    key: analysisKey(analysis), ready, stats, plate, arrived,
    legend: analysisLegend(analysis, { stats, faults, pending: !ready }),
  };
}
