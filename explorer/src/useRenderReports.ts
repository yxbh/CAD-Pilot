import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { Matrix4, Vector3 } from "three";
import { mergeBounds, sceneOrigin, type Model, type Placement, type ViewState } from "./model.ts";
import type { RenderReport } from "./host.ts";
import type { CameraController } from "./camera.ts";
import type { GeometryResources } from "./resources.ts";
import { edgeScreenPoint } from "./edgePicking.ts";
import { clipCadEdges, visibleFacePoint, visibleFaceTriangleCount } from "./section.ts";
import type { AnalysisView } from "./analysis/useAnalysis.ts";

// A view is reported once per revision and analysis: the background renderer draws a capture's own analysis settings
// at the view's revision.
const reportKey = (state: ViewState, analysis: AnalysisView) => `${state.revision}:${analysis.key}`;

export function useRenderReports({ model, state, amount, stepPosition, sectionPosition, active, background, placements, resources, analysis, controller, fitted, contextLost, onRendered, onError }: {
  model: Model;
  state: ViewState;
  amount: number;
  stepPosition: number | null;
  sectionPosition: number;
  active: boolean;
  background: string | null;
  placements: Placement[];
  resources: GeometryResources;
  analysis: AnalysisView;
  controller: CameraController;
  fitted: RefObject<string>;
  contextLost: RefObject<boolean>;
  onRendered: (report: RenderReport) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const { size, invalidate, gl, scene } = useThree();
  const lastReported = useRef("");
  const reportLifetime = useRef({ active: false });
  const latest = useRef({ model, state, amount, stepPosition, sectionPosition, active, background, placements, analysis });
  latest.current = { model, state, amount, stepPosition, sectionPosition, active, background, placements, analysis };
  useLayoutEffect(() => {
    const lifetime = { active };
    reportLifetime.current = lifetime;
    return () => { lifetime.active = false; };
  }, [model, state.revision, active]);
  useEffect(() => { if (active) invalidate(); }, [state.revision, placements, sectionPosition, active, invalidate, analysis.key, analysis.ready, analysis.arrived]);
  const invalidateReport = useCallback(() => {
    lastReported.current = "";
    invalidate();
  }, [invalidate]);
  // A new backdrop, or a capture's own ray tracing, is drawn at the same revision, so it needs a report of its own, as a new
  // size does.
  useLayoutEffect(invalidateReport, [background, state.appearance, invalidateReport]);
  const assertCaptureReady = useCallback(() => {
    const current = latest.current;
    if (!current.active || contextLost.current) throw new Error("The live model renderer is not available for capture");
    if (current.amount !== current.state.explode) throw new Error("Finish adjusting the explosion slider before capturing");
    if (current.stepPosition !== current.state.step) throw new Error("Wait for the assembly step to finish moving before capturing");
    if (current.sectionPosition !== current.state.section.position) throw new Error("Finish adjusting the section plane before capturing");
    if (!current.analysis.ready) throw new Error("The analysis view is still being computed. Capture it again once it has settled.");
    if (lastReported.current !== reportKey(current.state, current.analysis) ||
        fitted.current !== `${current.state.topologyRevision}:${current.state.fitNonce}`) {
      throw new Error("The view is still updating. Capture it again once it has settled.");
    }
  }, [contextLost, fitted]);

  useFrame(() => {
    const current = latest.current;
    if (!current.active || contextLost.current || !current.analysis.ready || lastReported.current === reportKey(current.state, current.analysis) ||
        current.model.topologyRevision !== current.state.topologyRevision ||
        current.amount !== current.state.explode || current.stepPosition !== current.state.step || current.sectionPosition !== current.state.section.position ||
        fitted.current !== `${current.state.topologyRevision}:${current.state.fitNonce}`) return;
    lastReported.current = reportKey(current.state, current.analysis);
    const camera = controller.camera;
    const visible = current.placements.filter((part) => !current.state.hiddenIds.includes(part.node.id));
    camera.updateMatrixWorld();
    const origin = sceneOrigin(current.model);
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
    const pointPlacement = visible.find((item) => item.node.id === current.state.selectedPoint?.nodeId);
    let selectedPointScreen: number[] | null = null;
    if (pointPlacement && current.state.selectedPoint) {
      const point = new Vector3(...current.state.selectedPoint.point as [number, number, number]).applyMatrix4(new Matrix4().fromArray(pointPlacement.matrix));
      point.sub(new Vector3(...origin)).project(camera);
      selectedPointScreen = [(point.x + 1) * size.width / 2, (1 - point.y) * size.height / 2];
    }
    // Counted from what is mounted for drawing, not from the manifest, so a dropped overlay or surface shows up.
    let faultMarks = 0, sectionOutlineSegments = 0, meshTriangles = 0, pickingTrees = 0, triangleEdgeSegments = 0, normalArrows = 0, analysisSurfaces = 0;
    scene.traverseVisible((object) => {
      const geometry = (object as { geometry?: { index?: { count: number } | null; instanceCount?: number; boundsTree?: unknown; getAttribute?: (name: string) => { count: number } } }).geometry;
      if (object.userData.meshFault) faultMarks += object.type === "Points" ? geometry?.getAttribute?.("position").count ?? 0 : geometry?.instanceCount ?? 0;
      if (object.userData.sectionOutline) sectionOutlineSegments += geometry?.instanceCount ?? 0;
      if (object.userData.triangleEdges) triangleEdgeSegments += (geometry?.index?.count ?? 0) / 2;
      if (object.userData.normalArrows) normalArrows += geometry?.instanceCount ?? 0;
      if (object.userData.analysisMap && object.userData.analysisMap !== "none") analysisSurfaces++;
      if (object.userData.meshSurface) {
        meshTriangles += (geometry?.index?.count ?? 0) / 3;
        if (geometry?.boundsTree) pickingTrees++;
      }
    });
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
      pixels: [gl.domElement.width, gl.domElement.height], background: current.background,
      selectedPoint: current.state.selectedPoint, selectedPointScreen,
      faultMarks, sectionOutlineSegments, meshTriangles, pickingTrees,
      analysisKey: current.analysis.key, analysisStats: current.analysis.stats, triangleEdgeSegments, normalArrows, analysisSurfaces,
      ghostParts: visible.filter((part) => part.node.ghost).length,
      positions: visible.map((part) => ({ id: part.node.id, position: part.matrix.slice(12, 15) })),
      renderer: "React Three Fiber / WebGL2",
      inFrame,
      geometryDefinitions: resources.size,
      geometryIds: visible.map((part) => ({ id: part.node.id, geometry: resources.get(part.part).geometry.uuid })),
      camera: controller.snapshot(), appearance: current.state.appearance, materialFinish: current.state.materialFinish,
      section: { ...current.state.section },
      step: current.state.step,
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
