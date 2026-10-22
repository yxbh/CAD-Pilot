export type PlacementBounds = { min: [number, number, number]; max: [number, number, number] };
export type StepMode = "exploded" | "buildup";
export type SequenceStep = {
  title: string;
  note: string;
  parts: string[];
  nodeIds: string[];
  unresolved: string[];
  from: [number, number, number];
  check?: { status: "clear" | "blocked" | "interferes" | "error"; detail: string };
};
export type AssemblySequence = { file: string; stale: boolean; digest: string; steps: SequenceStep[]; error?: string };
export type SequencePose = { steps: SequenceStep[]; position: number; mode: StepMode };
export type PlacementState = {
  explode: number;
  direction: "radial" | "x" | "y" | "z";
  fixedId: string;
  hiddenIds?: string[];
  assembly?: AssemblySequence | null;
  step?: number | null;
  stepMode?: StepMode;
};

export const STEP_MODES: StepMode[];
export function center(bounds: PlacementBounds): [number, number, number];
export function diagonal(bounds: PlacementBounds): number;
export function transformBounds(bounds: PlacementBounds, matrix: number[]): PlacementBounds;
export function mergeBounds(bounds: PlacementBounds[]): PlacementBounds | null;
export function sequencePose(state: PlacementState, position?: number | null): SequencePose | null;
export function sequenceOffsets(sequence: SequencePose | null): { offsets: Map<string, number[]>; hidden: Set<string> };
export function placeParts(model: any, amount: number, direction: PlacementState["direction"], fixedId: string, sequence?: SequencePose | null): any[];
export function displayedWorldBounds(model: any, state: PlacementState): PlacementBounds | null;
