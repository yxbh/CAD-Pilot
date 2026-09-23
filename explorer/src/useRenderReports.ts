import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { Matrix4, Vector3 } from "three";
import { center, mergeBounds, type Model, type Placement, type ViewState } from "./model.ts";
import type { RenderReport } from "./host.ts";
import type { CameraController } from "./camera.ts";
import type { GeometryResources } from "./resources.ts";
import { edgeScreenPoint } from "./edgePicking.ts";
import { clipCadEdges, visibleFacePoint, visibleFaceTriangleCount } from "./section.ts";

export function useRenderReports({ model, state, amount, sectionPosition, active, placements, resources, controller, fitted, contextLost, onRendered, onError }: {
  model: Model;
  state: ViewState;
  amount: number;
  sectionPosition: number;
  active: boolean;
  placements: Placement[];
  resources: GeometryResources;
  controller: CameraController;
  fitted: RefObject<string>;
  contextLost: RefObject<boolean>;
  onRendered: (report: RenderReport) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const { size, invalidate } = useThree();
  const lastReported = useRef(-1);
  const reportLifetime = useRef({ active: false });
  const latest = useRef({ model, state, amount, sectionPosition, active, placements });
  latest.current = { model, state, amount, sectionPosition, active, placements };
  useLayoutEffect(() => {
    const lifetime = { active };
    reportLifetime.current = lifetime;
    return () => { lifetime.active = false; };
  }, [model, state.revision, active]);
  useEffect(() => { if (active) invalidate(); }, [state.revision, placements, sectionPosition, active, invalidate]);
  const invalidateReport = useCallback(() => {
    lastReported.current = -1;
    invalidate();
  }, [invalidate]);
  const assertCaptureReady = useCallback(() => {
    const current = latest.current;
    if (!current.active || contextLost.current) throw new Error("The live model renderer is not available for capture");
    if (current.amount !== current.state.explode) throw new Error("Finish adjusting the explosion slider before capturing");
    if (current.sectionPosition !== current.state.section.position) throw new Error("Finish adjusting the section plane before capturing");
    if (lastReported.current !== current.state.revision ||
        fitted.current !== `${current.state.topologyRevision}:${current.state.fitNonce}`) {
      throw new Error("The view is still updating. Capture it again once it has settled.");
    }
  }, [contextLost, fitted]);

  useFrame(() => {
    const current = latest.current;
    if (!current.active || contextLost.current || lastReported.current === current.state.revision || current.model.topologyRevision !== current.state.topologyRevision ||
        current.amount !== current.state.explode || current.sectionPosition !== current.state.section.position ||
        fitted.current !== `${current.state.topologyRevision}:${current.state.fitNonce}`) return;
    lastReported.current = current.state.revision;
    const camera = controller.camera;
    const visible = current.placements.filter((part) => !current.state.hiddenIds.includes(part.node.id));
    camera.updateMatrixWorld();
    const origin = center(current.model.bounds);
    const projected = visible.flatMap(({ bounds }) => Array.from({ length: 8 }, (_, corner) => {
      const point = [0, 1, 2].map((axis) => ((corner & (1 << axis) ? bounds.max : bounds.min)[axis]) - origin[axis]);
      const screen = new Vector3(...point as [number, number, number]).project(camera);
      return screen.toArray();
    }));
    const inFrame = projected.every(([x, y, z]) => Math.abs(x) <= 1.01 && Math.abs(y) <= 1.01 && Math.abs(z) <= 1);
    const selectedPlacement = visible.find((item) => item.node.id === current.state.selectedFace?.nodeId);
    const selectedFace = selectedPlacement?.part.faces.find((face) => face.id === current.state.selectedFace?.faceId);
    let selectedFaceScreen: number[] | null = null;
    const visibleFace = selectedFace && selectedPlacement
      ? visibleFacePoint(selectedPlacement.part, selectedFace, selectedPlacement.matrix, current.state.section) : null;
    if (visibleFace && selectedPlacement) {
      const point = new Vector3(...visibleFace).applyMatrix4(new Matrix4().fromArray(selectedPlacement.matrix));
      point.sub(new Vector3(...origin)).project(camera);
      selectedFaceScreen = [(point.x + 1) * size.width / 2, (1 - point.y) * size.height / 2];
    }
    const edgePlacement = visible.find((item) => item.node.id === current.state.selectedEdge?.nodeId);
    const selectedEdge = edgePlacement?.part.edges?.find((edge) => edge.id === current.state.selectedEdge?.edgeId);
    // Report only the retained portion of a partially cut native edge.
    const clippedEdge = selectedEdge && edgePlacement && current.state.section.enabled
      ? clipCadEdges([selectedEdge], edgePlacement.matrix, current.state.section).positions : null;
    const report: RenderReport = {
      revision: current.state.revision,
      modelHash: current.model.source.sha256,
      topologyRevision: current.model.topologyRevision,
      visibleParts: visible.length,
      selectedIds: current.state.selectedIds,
      selectedFace: current.state.selectedFace,
      highlightedTriangles: selectedFace && selectedPlacement
        ? visibleFaceTriangleCount(selectedPlacement.part, selectedFace, selectedPlacement.matrix, current.state.section) : 0,
      selectedFaceScreen,
      selectedEdge: current.state.selectedEdge,
      highlightedSegments: clippedEdge ? clippedEdge.length / 6 : selectedEdge ? selectedEdge.positions.length / 3 - 1 : 0,
      selectedEdgeScreen: selectedEdge && edgePlacement
        ? edgeScreenPoint(clippedEdge ?? selectedEdge.positions, edgePlacement.matrix, origin, camera, size.width, size.height) : null,
      bounds: mergeBounds(visible.map((part) => part.bounds)),
      positions: visible.map((part) => ({ id: part.node.id, position: part.matrix.slice(12, 15) })),
      renderer: "React Three Fiber / WebGL2",
      inFrame,
      geometryDefinitions: resources.size,
      geometryIds: visible.map((part) => ({ id: part.node.id, geometry: resources.get(part.part).geometry.uuid })),
      camera: controller.snapshot(), appearance: current.state.appearance, materialFinish: current.state.materialFinish,
      section: { ...current.state.section },
      projectedBounds: projected.length ? {
        min: [0, 1, 2].map((axis) => Math.min(...projected.map((point) => point[axis]))),
        max: [0, 1, 2].map((axis) => Math.max(...projected.map((point) => point[axis]))),
      } : null,
    };
    // Requests can finish after a view change or after this renderer has unmounted.
    const lifetime = reportLifetime.current;
    queueMicrotask(() => {
      if (!lifetime.active) return;
      void onRendered(report).catch((error: Error) => { if (lifetime.active) onError(error.message); });
    });
  });
  return { invalidateReport, assertCaptureReady };
}
