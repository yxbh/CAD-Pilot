export type PlacementBounds = { min: [number, number, number]; max: [number, number, number] };
export type PlacementState = {
  explode: number;
  direction: "radial" | "x" | "y" | "z";
  fixedId: string;
  hiddenIds?: string[];
};

export function center(bounds: PlacementBounds): [number, number, number];
export function diagonal(bounds: PlacementBounds): number;
export function transformBounds(bounds: PlacementBounds, matrix: number[]): PlacementBounds;
export function mergeBounds(bounds: PlacementBounds[]): PlacementBounds | null;
export function placeParts(model: any, amount: number, direction: PlacementState["direction"], fixedId: string): any[];
export function displayedWorldBounds(model: any, state: PlacementState): PlacementBounds | null;
