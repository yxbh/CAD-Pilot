export type Tool = 'pen' | 'line' | 'arrow' | 'double-arrow' | 'rectangle' | 'ellipse' | 'highlight';
export type Point = [number, number];
export type Stroke = { id: string; tool: Tool; color: string; width: number; points: Point[] };
export type DrawingState = { past: Stroke[][]; present: Stroke[]; future: Stroke[][] };
export type Bounds = { left: number; top: number; width: number; height: number };
export type StrokeGeometry = (
  | { kind: 'polyline'; points: Point[]; closed: boolean }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
) & { fill: boolean; opacity: number };
export const DRAWING_LIMITS: Readonly<{ strokes: 200; pointsPerStroke: 2000; historyFrames: 30; totalPoints: 300000 }>;
export function emptyDrawing(): DrawingState;
export function validateDrawing(value: unknown): DrawingState;
export function replaceDrawing(state: DrawingState, present: Stroke[]): DrawingState;
export function addStroke(state: DrawingState, stroke: Stroke): DrawingState;
export function eraseStrokes(state: DrawingState, ids: string[]): DrawingState;
export function clearDrawing(state: DrawingState): DrawingState;
export function undoDrawing(state: DrawingState): DrawingState;
export function redoDrawing(state: DrawingState): DrawingState;
export function getImageBounds(bounds: Bounds, imageWidth: number, imageHeight: number): Bounds;
export function normalizedPoint(clientX: number, clientY: number, bounds: Bounds, imageWidth: number, imageHeight: number): Point | null;
export function appendStrokePoint(stroke: Stroke, next: Point, imageWidth: number, imageHeight: number, force?: boolean): Stroke;
export function strokeGeometry(stroke: Stroke, imageWidth: number, imageHeight: number): StrokeGeometry[];
export function geometryPath(geometry: StrokeGeometry): string;
export function hitTestStroke(stroke: Stroke, normalized: Point, imageWidth: number, imageHeight: number, tolerance?: number): boolean;
