export type SectionAxis = "x" | "y" | "z";
export type SectionSettings = { enabled: boolean; axis: SectionAxis; position: number; flipped: boolean };
export type SectionBounds = { min: [number, number, number]; max: [number, number, number] };

export const SECTION_AXES: SectionAxis[];
export function defaultSection(bounds: SectionBounds): SectionSettings;
export function validateSection(value: unknown, bounds?: SectionBounds): SectionSettings;
export function sectionAxisIndex(axis: SectionAxis): number;
export type SectionSupport =
  | { supported: true; reason: null; message: "" }
  | { supported: false; reason: "open_geometry" | "unknown_solids"; message: string };
export function sectionSupport(model: { parts?: { sectionCaps?: boolean }[] } | null | undefined): SectionSupport;
export function sameSection(a: SectionSettings | null | undefined, b: SectionSettings | null | undefined): boolean;
export function sectionDistance(point: number[], matrix: number[], section: SectionSettings): number;
export function sectionPointVisible(point: number[], matrix: number[], section: SectionSettings, tolerance?: number): boolean;
export function sectionPlacements(model: any, state: any): { node: any; part: any; matrix: number[] }[];
export function reconcileSectionWithDisplay<T>(state: T, model: any): T;
export function sectionEntityVisible(model: any, state: any, nodeId: string, faceId?: string | null, edgeId?: string | null): boolean;
export function pruneSectionSelection<T>(state: T, model: any): T;
