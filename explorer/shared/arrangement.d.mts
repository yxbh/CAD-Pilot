import type { Model, ViewDocument } from "../src/model.ts";
export const MAIN_DOCUMENT: "main";
export const DOCUMENT_STYLES: readonly ("solid" | "ghost")[];
export const LAYOUTS: readonly ("overlay" | "side")[];
export function placementMatrix(rotate: number[], offset: number[]): number[];
export function arrangeView(model: Model, documents?: Pick<ViewDocument, "id" | "style" | "offset" | "rotate">[], layout?: "overlay" | "side"): Model;
