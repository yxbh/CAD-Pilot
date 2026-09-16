import type { CadEdge, CadFace, Model, ModelNode, Part } from "../src/model.ts";
export type ParsedReference = { topologyRevision: string; nodeId: string; faceId: string | null; edgeId: string | null };
export function parseReference(text: string): ParsedReference;
export function referenceEntity(model: Model, nodeId: string, faceId?: string | null, edgeId?: string | null): { node: ModelNode; part: Part; face: CadFace | null; edge: CadEdge | null };
export function createReference(model: Model, nodeId: string, faceId?: string | null, edgeId?: string | null): string;
export function formatSelection(model: Model, nodeId: string, faceId?: string | null, edgeId?: string | null): string;
