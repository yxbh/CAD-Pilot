import type { DrawingState } from '../../shared/drawing.mjs';
import type { CameraState } from '../host.ts';
import type { ViewState } from '../model.ts';

export type { DrawingState, Stroke, Tool } from '../../shared/drawing.mjs';

export type Review = {
  id: string;
  version: number;
  title: string;
  createdAt: string;
  source: { name: string; sha256: string; topologyRevision: string };
  pose: {
    explode: number;
    direction: string;
    fixedId: string;
    hiddenIds: string[];
    selectedIds: string[];
    selectedFace: { nodeId: string; faceId: string } | null;
    camera: CameraState;
    appearance?: ViewState["appearance"];
    materialFinish?: ViewState["materialFinish"];
    showEdges?: boolean;
  };
  image: { dataUrl: string; width: number; height: number };
  drawing: DrawingState;
};
