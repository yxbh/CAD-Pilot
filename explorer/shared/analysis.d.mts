export type AnalysisMap = "none" | "overhang" | "thickness" | "curvature" | "zebra";
export type CurvatureKind = "mean" | "gaussian";
export type AnalysisSettings = {
  map: AnalysisMap; triangleEdges: boolean; backfaces: boolean; normals: boolean;
  overhangAngle: number; buildDirection: [number, number, number]; minimumWall: number;
  curvature: CurvatureKind; curvatureScale: number | null;
};
export type AnalysisField = "thickness" | "curvature" | "edges" | "normals";
export type AnalysisStats = { thinnest?: number; curvatureScale?: number };
export type RampStops = [number, string][];
export type LegendKey = { color: string; from?: string; label: string };
export type AnalysisLegend = {
  map: { title: string; ramp: RampStops | null; ticks: [number, string][]; note: string } | null;
  keys: LegendKey[];
};

export const ANALYSIS_MAPS: AnalysisMap[];
export const CURVATURE_KINDS: CurvatureKind[];
export function defaultAnalysis(): AnalysisSettings;
export function parseDirection(text: string): [number, number, number];
export function directionLabel(vector: number[]): string;
export function applyAnalysis(current: AnalysisSettings, input: Partial<AnalysisSettings>): AnalysisSettings;
export function validateAnalysis(value: unknown): AnalysisSettings;
export function analysisKey(analysis: AnalysisSettings): string;
export function analysisFields(analysis: AnalysisSettings): AnalysisField[];
export function analysisSummary(analysis: AnalysisSettings): Record<string, unknown> | null;
export function analysisReport(analysis: AnalysisSettings, stats?: AnalysisStats): Record<string, unknown> | null;
export const RAMPS: { overhang: RampStops; thickness: RampStops; curvature: RampStops };
export const THICKNESS_SPAN: number;
export const ANALYSIS_COLORS: Record<"plate" | "noValue" | "backface" | "normalBase" | "normalTip" | "triangleEdges" | "zebraLight" | "zebraDark", string>;
export const FAULT_COLORS: Record<"open" | "overshared" | "flipped" | "degenerate", string>;
export function rampColor(stops: RampStops, t: number): [number, number, number];
export function formatNumber(value: number): string;
export function niceScale(value: number): number;
export function analysisLegend(analysis: AnalysisSettings, options?: { stats?: AnalysisStats; faults?: boolean; pending?: boolean }): AnalysisLegend | null;
