import { useMemo } from "react";
import { arrangeView } from "../shared/arrangement.mjs";
import type { Model, ViewState } from "./model.ts";

// The fetched model arranged as the view places its files, for the viewer page and the background renderer alike.
// Placement changes never refetch or rebuild geometry: only the placement fields of the state are followed.
export function useArrangedModel(composed: Model | null, state: ViewState | null): Model | null {
  const placementKey = JSON.stringify([state?.layout, state?.documents?.map(({ id, style, offset, rotate }) => [id, style, offset, rotate])]);
  return useMemo(() => composed && state ? arrangeView(composed, state.documents, state.layout) : composed, [composed, placementKey]);
}
