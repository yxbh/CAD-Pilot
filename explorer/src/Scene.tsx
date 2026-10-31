import { Canvas, events, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AlwaysStencilFunc, BackSide, BufferAttribute, BufferGeometry, Color, DecrementWrapStencilOp, DoubleSide,
  EdgesGeometry, FrontSide, IncrementWrapStencilOp, KeepStencilOp, Matrix4, Mesh, NotEqualStencilFunc,
  Plane, PlaneGeometry, ReplaceStencilOp,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { center, diagonal, edgeSegments, faceAtTriangle, facePositions, hoverTarget, isMesh, mergeBounds, placeParts, sceneOrigin, type CadEdge, type CadFace, type HoverTarget, type Model, type Part, type Placement, type PointSelection, type ViewState } from "./model.ts";
import type { CameraState, CaptureView, RenderReport } from "./host.ts";
import { edgeAtSegment, GeometryResources, type AnalysisResources, type EdgeRange, type FaultResources, type PartResources } from "./resources.ts";
import { prioritizeEdges, visibleEdgeHits } from "./edgePicking.ts";
import { useRenderReports } from "./useRenderReports.ts";
import { observeGraphicsContext } from "./graphicsLifecycle.ts";
import { CameraController, type ViewPreset } from "./camera.ts";
import { AxisIndicator, createAxisStore, type AxisStore } from "./AxisIndicator.tsx";
import StudioStage from "./Studio.tsx";
import { appearanceFor, type MaterialFinish } from "./appearance.ts";
import type { SectionSettings } from "../shared/section.mjs";
import { sequencePose } from "../shared/placement.mjs";
import {
  clipCadEdges, sceneSectionPlane, sectionMeshRaycast, sectionOutlineSegments,
  visibleFacePoint, visibleFaceTriangleCount,
} from "./section.ts";
import { ANALYSIS_COLORS, FAULT_COLORS, type AnalysisLegend, type AnalysisSettings } from "../shared/analysis.mjs";
import { analysisDrawn, traceLimits } from "../shared/raytrace.mjs";
import { createTraceStore, RayTraced, TraceStatus, type TraceControl } from "./raytrace/RayTraced.tsx";
import { AnalysisShading } from "./analysis/material.ts";
import { useAnalysis, type AnalysisView } from "./analysis/useAnalysis.ts";
import { withLegend } from "./analysis/legend.ts";
import { LegendOverlay } from "./ui/LegendOverlay.tsx";

type Props = {
  model: Model;
  state: ViewState;
  amount: number;
  stepPosition: number | null;
  sectionPosition: number;
  active: boolean;
  onSelect: (id: string, faceId?: string, edgeId?: string, point?: Pick<PointSelection, "triangle" | "point">) => void;
  onError: (message: string) => void;
  registerCapture: (capture: CaptureView | null) => void;
  onRendered: (report: RenderReport) => Promise<unknown>;
  onCameraChange: (camera: CameraState) => void;
  onView: (preset: ViewPreset) => void;
  // The background renderer follows the saved view at its own size: the person's camera once they moved it,
  // otherwise a fresh fit of cameraPreset. It shows no on-screen controls.
  headless?: boolean;
  background?: string | null;
};

function FaceOverlay({ part, face, selected, clippingPlane }: { part: Part; face: CadFace; selected: boolean; clippingPlane: Plane | null }) {
  const geometry = useMemo(() => {
    const result = new BufferGeometry();
    result.setAttribute("position", new BufferAttribute(facePositions(part, face), 3));
    return result;
  }, [part, face]);
  const edges = useMemo(() => new EdgesGeometry(geometry, 180), [geometry]);
  useEffect(() => () => { geometry.dispose(); edges.dispose(); }, [geometry, edges]);
  return (
    <>
      <mesh geometry={geometry} raycast={() => undefined} renderOrder={selected ? 3 : 1}>
        <meshBasicMaterial color={selected ? "#13d9f0" : "#8ecbd4"} transparent opacity={selected ? 0.7 : 0.3} side={DoubleSide}
          depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2}
          clippingPlanes={clippingPlane ? [clippingPlane] : []} />
      </mesh>
      <lineSegments geometry={edges} raycast={() => undefined} renderOrder={selected ? 4 : 2}>
        <lineBasicMaterial color={selected ? "#d8ffff" : "#c9edf2"} transparent opacity={selected ? 1 : 0.8} depthWrite={false}
          clippingPlanes={clippingPlane ? [clippingPlane] : []} />
      </lineSegments>
    </>
  );
}

function CadLines({ geometry, color, width, visible = true, renderOrder = 0, picking, clippingPlane, tag, onSelect, onHover, onHoverEnd }: {
  geometry: LineSegmentsGeometry;
  tag?: string;
  color: string;
  width: number;
  visible?: boolean;
  renderOrder?: number;
  picking?: { nodeId: string; ranges: EdgeRange[]; tolerance: number };
  clippingPlane?: Plane | null;
  onSelect?: Props["onSelect"];
  onHover?: (target: HoverTarget | null) => void;
  onHoverEnd?: (nodeId: string) => void;
}) {
  const { scene, size } = useThree();
  const material = useMemo(() => new LineMaterial({
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), []);
  const lines = useMemo(() => new LineSegments2(geometry, material), [geometry, material]);
  material.color.set(color);
  material.linewidth = width;
  material.resolution.set(size.width, size.height);
  material.clippingPlanes = clippingPlane ? [clippingPlane] : [];
  lines.renderOrder = renderOrder;
  useEffect(() => () => material.dispose(), [material]);
  return <primitive object={lines} visible={visible} userData={{ cadEdges: true, ...(tag ? { [tag]: true } : {}) }}
    raycast={(raycaster: Parameters<LineSegments2["raycast"]>[0], hits: Parameters<LineSegments2["raycast"]>[1]) => {
      if (!picking) return;
      for (const hit of visibleEdgeHits(lines, raycaster, scene.getObjectsByProperty("name", "cad-surface"),
        size.width, size.height, picking.tolerance)) hits.push(hit);
    }}
    onClick={(event: ThreeEvent<MouseEvent>) => {
      if (!picking || event.delta > 4) return;
      event.stopPropagation();
      const edge = edgeAtSegment(picking.ranges, event.faceIndex ?? -1);
      if (edge) onSelect?.(picking.nodeId, undefined, edge.id);
    }}
    onPointerMove={(event: ThreeEvent<PointerEvent>) => {
      if (!picking) return;
      event.stopPropagation();
      const edge = edgeAtSegment(picking.ranges, event.faceIndex ?? -1);
      onHover?.(edge ? { nodeId: picking.nodeId, faceId: null, edgeId: edge.id } : null);
    }}
    onPointerOut={() => { if (picking) onHoverEnd?.(picking.nodeId); }} />;
}

function EdgeOverlay({ edge, selected, matrix, section }: { edge: CadEdge; selected: boolean; matrix: number[]; section: SectionSettings }) {
  const positions = useMemo(() => section.enabled ? clipCadEdges([edge], matrix, section).positions : edgeSegments(edge),
    [edge, matrix, section.enabled, section.axis, section.position, section.flipped]);
  const geometry = useMemo(() => positions.length ? new LineSegmentsGeometry().setPositions(positions) : null, [positions]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  return geometry ? <CadLines geometry={geometry} color={selected ? "#13d9f0" : "#b5e9f1"} width={selected ? 4 : 2.5} /> : null;
}

// Dashed paths from each waiting part to where it is installed, like the explode lines in printed instructions.
function SequenceTrails({ placements, origin }: { placements: Placement[]; origin: number[] }) {
  const { size } = useThree();
  const positions = useMemo(() => placements.flatMap(({ bounds, offset }) => {
    if (!offset || Math.hypot(...offset) < 1e-6) return [];
    const start = center(bounds).map((value, axis) => value - origin[axis]);
    return [...start, ...start.map((value, axis) => value - offset[axis])];
  }), [placements, origin]);
  // One line object for the panel's lifetime; only its small geometry is replaced as parts move.
  const lines = useMemo(() => new LineSegments2(new LineSegmentsGeometry(),
    new LineMaterial({ color: 0x8adfc9, dashed: true, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.75, depthTest: false })), []);
  const geometry = useMemo(() => positions.length ? new LineSegmentsGeometry().setPositions(positions) : null, [positions]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => { lines.geometry.dispose(); lines.material.dispose(); }, [lines]);
  if (!geometry) return null;
  if (lines.geometry !== geometry) {
    lines.geometry = geometry;
    lines.computeLineDistances();
  }
  lines.material.linewidth = 1.5;
  lines.material.resolution.set(size.width, size.height);
  return <primitive object={lines} renderOrder={5} raycast={() => null} />;
}

function partMatrix(placement: Placement, origin: number[]) {
  const result = new Matrix4().fromArray(placement.matrix);
  for (let axis = 0; axis < 3; axis++) result.elements[12 + axis] -= origin[axis];
  return result;
}

// Where the plane cuts a part. Closed parts also get a cap; open meshes and surfaces show just this line.
function SectionOutline({ placement, origin, section, order }: { placement: Placement; origin: number[]; section: SectionSettings; order: number }) {
  const matrix = useMemo(() => partMatrix(placement, origin), [placement, origin]);
  const positions = useMemo(() => sectionOutlineSegments(placement.part, placement.matrix, section),
    [placement.part, placement.matrix, section.axis, section.position, section.flipped]);
  const outline = useMemo(() => positions.length ? new LineSegmentsGeometry().setPositions(positions) : null, [positions]);
  useEffect(() => () => outline?.dispose(), [outline]);
  return outline ? <group matrix={matrix} matrixAutoUpdate={false}>
    <CadLines geometry={outline} color={placement.part.sectionCaps ? "#102631" : "#f2b65f"} width={1.6} renderOrder={order} tag="sectionOutline" />
  </group> : null;
}

function SectionCap({ placement, resources, origin, capCenter, section, plane, planeGeometry, order, studio }: {
  placement: Placement;
  resources: PartResources;
  origin: number[];
  capCenter: [number, number, number];
  section: SectionSettings;
  plane: Plane;
  planeGeometry: PlaneGeometry;
  order: number;
  studio: boolean;
}) {
  const matrix = useMemo(() => partMatrix(placement, origin), [placement, origin]);
  const capPosition: [number, number, number] = [...capCenter];
  capPosition[sectionAxis(section.axis)] = section.position - origin[sectionAxis(section.axis)];
  const capRotation: [number, number, number] = section.axis === "x"
    ? [0, Math.PI / 2, 0] : section.axis === "y" ? [-Math.PI / 2, 0, 0] : [0, 0, 0];
  const capColor = useMemo(() => new Color(...placement.node.color).lerp(new Color("#f2b65f"), studio ? 0.68 : 0.58),
    [placement.node.color, studio]);
  const stencil = {
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    clippingPlanes: [plane],
    stencilWrite: true,
    stencilFunc: AlwaysStencilFunc,
    stencilFail: KeepStencilOp,
  };
  return <>
    <group matrix={matrix} matrixAutoUpdate={false}>
      <mesh renderOrder={order} raycast={() => undefined}>
        <primitive object={resources.geometry} attach="geometry" />
        <meshBasicMaterial {...stencil} side={BackSide}
          stencilZFail={IncrementWrapStencilOp} stencilZPass={IncrementWrapStencilOp} />
      </mesh>
      <mesh renderOrder={order} raycast={() => undefined}>
        <primitive object={resources.geometry} attach="geometry" />
        <meshBasicMaterial {...stencil} side={FrontSide}
          stencilZFail={DecrementWrapStencilOp} stencilZPass={DecrementWrapStencilOp} />
      </mesh>
    </group>
    <SectionOutline placement={placement} origin={origin} section={section} order={order + 2} />
    <mesh position={capPosition} rotation={capRotation} renderOrder={order + 1}
      receiveShadow={studio} raycast={() => undefined}
      onAfterRender={(renderer) => renderer.clearStencil()}>
      <primitive object={planeGeometry} attach="geometry" />
      <meshBasicMaterial color={capColor} toneMapped={false} side={DoubleSide}
        stencilWrite stencilRef={0} stencilFunc={NotEqualStencilFunc}
        stencilFail={ReplaceStencilOp} stencilZFail={ReplaceStencilOp} stencilZPass={ReplaceStencilOp}
        polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
    </mesh>
  </>;
}

// Mesh faults (shared/analysis.mjs FAULT_COLORS) are drawn through the surface so hidden ones show too.
function FaultLines({ geometry, color, clippingPlane }: { geometry: LineSegmentsGeometry; color: string; clippingPlane: Plane | null }) {
  const { size } = useThree();
  const lines = useMemo(() => new LineSegments2(geometry, new LineMaterial({ color, linewidth: 2.5, transparent: true, opacity: 0.95, depthTest: false })), [geometry, color]);
  useEffect(() => () => lines.material.dispose(), [lines]);
  lines.material.resolution.set(size.width, size.height);
  lines.material.clippingPlanes = clippingPlane ? [clippingPlane] : [];
  return <primitive object={lines} renderOrder={40} raycast={() => null} userData={{ meshFault: true }} />;
}

function MeshFaults({ faults, clippingPlane }: { faults: FaultResources; clippingPlane: Plane | null }) {
  return <>
    {faults.open && <FaultLines geometry={faults.open} color={FAULT_COLORS.open} clippingPlane={clippingPlane} />}
    {faults.overshared && <FaultLines geometry={faults.overshared} color={FAULT_COLORS.overshared} clippingPlane={clippingPlane} />}
    {faults.flipped && <FaultLines geometry={faults.flipped} color={FAULT_COLORS.flipped} clippingPlane={clippingPlane} />}
    {faults.degenerate && <points geometry={faults.degenerate} renderOrder={41} raycast={() => undefined} userData={{ meshFault: true }}>
      <pointsMaterial color={FAULT_COLORS.degenerate} size={7} sizeAttenuation={false} depthTest={false} transparent
        clippingPlanes={clippingPlane ? [clippingPlane] : []} />
    </points>}
  </>;
}

// Per-face normals as short two-pixel lines, hidden where the surface is in front of them.
function NormalArrows({ geometry, clippingPlane }: { geometry: LineSegmentsGeometry; clippingPlane: Plane | null }) {
  const { size } = useThree();
  const lines = useMemo(() => new LineSegments2(geometry, new LineMaterial({ vertexColors: true, linewidth: 2 })), [geometry]);
  useEffect(() => () => lines.material.dispose(), [lines]);
  lines.material.resolution.set(size.width, size.height);
  lines.material.clippingPlanes = clippingPlane ? [clippingPlane] : [];
  return <primitive object={lines} raycast={() => null} userData={{ normalArrows: true }} />;
}

function PointMarker({ point }: { point: number[] }) {
  const geometry = useMemo(() => {
    const result = new BufferGeometry();
    result.setAttribute("position", new BufferAttribute(new Float32Array(point), 3));
    return result;
  }, [point[0], point[1], point[2]]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <points geometry={geometry} renderOrder={42} raycast={() => undefined}>
    <pointsMaterial color="#13d9f0" size={11} sizeAttenuation={false} depthTest={false} transparent />
  </points>;
}

function sectionAxis(axis: SectionSettings["axis"]) {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

const STUDIO_BACKGROUND = "#29313d";
// Where Studio's floor lies (Studio.tsx), for the ray-traced view to trace the same floor.
function studioFloor({ min, max }: { min: number[]; max: number[] }) {
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.001);
  return { z: min[2] - span * 0.002, size: span * 12, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] as [number, number] };
}

// A colour map is read from the surface's colour, so metal and clear-coat finishes would hide it.
const MAPPED_FINISH = { roughness: 0.55, metalness: 0, clearcoat: 0, clearcoatRoughness: 0 };

function PartMesh({ placement, resources, faults, analysis, analysisData, shading, showValues, origin, section, clippingPlane, selected, faceId, edgeId, point, hovered, hoverFaceId, hoverEdgeId, selectionMode, pickingEnabled, studio, finish, showEdges, onSelect, onHover, onHoverEnd }: {
  placement: Placement;
  resources: PartResources;
  faults: FaultResources | null;
  analysis: AnalysisSettings;
  analysisData: AnalysisResources;
  shading: AnalysisShading;
  showValues: (values: Float32Array) => void;
  origin: number[];
  section: SectionSettings;
  clippingPlane: Plane | null;
  selected: boolean;
  faceId: string | null;
  edgeId: string | null;
  point: number[] | null;
  hovered: boolean;
  hoverFaceId: string | null;
  hoverEdgeId: string | null;
  selectionMode: ViewState["selectionMode"];
  pickingEnabled: boolean;
  studio: boolean;
  finish: MaterialFinish;
  showEdges: boolean;
  onSelect: Props["onSelect"];
  onHover: (target: HoverTarget | null) => void;
  onHoverEnd: (nodeId: string) => void;
}) {
  const { part, node } = placement;
  const { geometry, edges } = resources;
  const surface = useRef<Mesh>(null);
  const mesh = isMesh(part);
  // A ghost is a see-through reference: drawn after solid parts, never picked, without outlines.
  const ghost = !!node.ghost;
  const picking = pickingEnabled && !ghost;
  const selectedFace = part.faces.find((item) => item.id === faceId) ?? null;
  const hoveredFace = part.faces.find((item) => item.id === hoverFaceId && item.id !== faceId) ?? null;
  const selectedEdge = part.edges?.find((item) => item.id === edgeId) ?? null;
  const hoveredEdge = part.edges?.find((item) => item.id === hoverEdgeId && item.id !== edgeId) ?? null;
  const matrix = useMemo(() => partMatrix(placement, origin), [placement, origin]);
  const clippedEdges = useMemo(() => {
    if (!section.enabled || !resources.cadEdges) return null;
    const clipped = clipCadEdges(part.edges ?? [], placement.matrix, section);
    return {
      ...clipped,
      geometry: clipped.positions.length ? new LineSegmentsGeometry().setPositions(clipped.positions) : null,
    };
  }, [part, resources.cadEdges, placement.matrix, section.enabled, section.axis, section.position, section.flipped]);
  useEffect(() => () => clippedEdges?.geometry?.dispose(), [clippedEdges]);
  const color = new Color(...node.color);
  const wholePartSelected = selected && !selectedFace && !selectedEdge;
  const wholePartHovered = hovered && !wholePartSelected;
  // Ghosts stay plain references. A map that reads values per vertex waits for them, shading normally meanwhile.
  const values = analysis.map === "thickness" ? analysisData.thickness?.values
    : analysis.map === "curvature" ? analysisData.curvature?.[analysis.curvature] : undefined;
  const map = ghost || ((analysis.map === "thickness" || analysis.map === "curvature") && !values) ? "none" : analysis.map;
  const backfaces = !ghost && analysis.backfaces;
  const triangleEdges = !ghost && analysis.triangleEdges ? analysisData.edges : undefined;
  const normalArrows = !ghost && analysis.normals ? analysisData.normals : undefined;
  useLayoutEffect(() => { if (values) showValues(values); }, [values, showValues]);
  const program = AnalysisShading.key(map, backfaces);
  const patch = useMemo(() => shading.patch(map, backfaces), [shading, map, backfaces]);
  const finishSettings = map === "overhang" || map === "thickness" || map === "curvature"
    ? { ...MAPPED_FINISH, envMapIntensity: studio ? 0.35 : 0 }
    : studio ? appearanceFor(finish) : { roughness: 0.45, metalness: 0.15, clearcoat: 0, clearcoatRoughness: 0, envMapIntensity: 0 };
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <mesh ref={surface} name={ghost ? "reference-surface" : "cad-surface"} castShadow={studio && !ghost} receiveShadow={studio && !ghost}
        userData={{ meshSurface: mesh, analysisMap: map }}
        raycast={(raycaster, hits) => {
          if (ghost || !surface.current) return;
          sectionMeshRaycast(surface.current, raycaster, hits, clippingPlane);
        }}
        onClick={(event) => {
        event.stopPropagation();
        if (!picking || event.delta > 4 || (event.faceIndex ?? -1) < 0) return;
        if (selectionMode === "point") {
          const local = surface.current!.worldToLocal(event.point.clone());
          onSelect(node.id, undefined, undefined, { triangle: event.faceIndex!, point: local.toArray() });
        } else if (selectionMode === "face" && !mesh) {
          const hitFace = faceAtTriangle(part, event.faceIndex ?? -1);
          if (hitFace) onSelect(node.id, hitFace.id);
        } else if (selectionMode === "part" || mesh) onSelect(node.id);
        else onSelect("");
      }} onPointerMove={(event) => {
        if (!picking) return;
        event.stopPropagation();
        if ((event.faceIndex ?? -1) < 0) { onHover(null); return; }
        onHover(hoverTarget(part, node.id, selectionMode, event.faceIndex ?? -1));
      }} onPointerOut={(event) => {
        if (!picking) return;
        event.stopPropagation();
        onHoverEnd(node.id);
      }}>
        <primitive object={geometry} attach="geometry" />
        <meshPhysicalMaterial key={program} onBeforeCompile={patch} customProgramCacheKey={() => program}
          color={wholePartSelected ? "#7ee7da" : wholePartHovered ? "#79aeb9" : color}
          {...finishSettings}
          emissive={wholePartSelected ? "#167b75" : wholePartHovered ? "#134d59" : "#000000"}
          emissiveIntensity={wholePartSelected ? 0.3 : wholePartHovered ? 0.18 : 0}
          flatShading={mesh} transparent={ghost} opacity={ghost ? 0.28 : 1} depthWrite={!ghost} toneMapped={map !== "zebra"}
          side={backfaces || section.enabled || ghost || (mesh && !part.closed) ? DoubleSide : FrontSide} clippingPlanes={clippingPlane ? [clippingPlane] : []}
          clipShadows={section.enabled}
          // Triangle edges are drawn on the surface itself, so it steps back a little in depth.
          polygonOffset={!!triangleEdges} polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      {triangleEdges && <lineSegments raycast={() => undefined} userData={{ triangleEdges: true }}>
        <primitive object={triangleEdges} attach="geometry" />
        <lineBasicMaterial color={ANALYSIS_COLORS.triangleEdges} transparent opacity={0.42} depthWrite={false}
          clippingPlanes={clippingPlane ? [clippingPlane] : []} />
      </lineSegments>}
      {normalArrows && <NormalArrows geometry={normalArrows} clippingPlane={clippingPlane} />}
      {edges && !ghost && <lineSegments visible={!resources.cadEdges && (showEdges || wholePartSelected || wholePartHovered)} raycast={() => undefined}>
        <primitive object={edges} attach="geometry" />
        <lineBasicMaterial color={wholePartSelected ? "#c5fff5" : wholePartHovered ? "#c9edf2" : "#0e2533"} transparent
          opacity={wholePartSelected ? 0.9 : wholePartHovered ? 0.75 : 0.45}
          clippingPlanes={clippingPlane ? [clippingPlane] : []} />
      </lineSegments>}
      {resources.cadEdges && !ghost && (!section.enabled || clippedEdges?.geometry) && <CadLines geometry={clippedEdges?.geometry ?? resources.cadEdges}
        color={wholePartSelected ? "#c5fff5" : wholePartHovered ? "#c9edf2" : selectionMode === "edge" ? "#7896a6" : "#0e2533"} width={1}
        visible={showEdges || selectionMode === "edge" || wholePartSelected || wholePartHovered}
        picking={picking && selectionMode === "edge" ? {
          nodeId: node.id, ranges: clippedEdges?.ranges ?? resources.edgeRanges, tolerance: Math.max(diagonal(part.bounds) * 1e-5, 1e-6),
        } : undefined}
        onSelect={onSelect} onHover={onHover} onHoverEnd={onHoverEnd} />}
      {hoveredFace && <FaceOverlay part={part} face={hoveredFace} selected={false} clippingPlane={clippingPlane} />}
      {selectedFace && <FaceOverlay part={part} face={selectedFace} selected clippingPlane={clippingPlane} />}
      {hoveredEdge && <EdgeOverlay edge={hoveredEdge} selected={false} matrix={placement.matrix} section={section} />}
      {selectedEdge && <EdgeOverlay edge={selectedEdge} selected matrix={placement.matrix} section={section} />}
      {faults && <MeshFaults faults={faults} clippingPlane={clippingPlane} />}
      {point && <PointMarker point={point} />}
    </group>
  );
}

function Rig({ model, state, amount, stepPosition, sectionPosition, active, headless, background, placements, resources, analysis, trace, axes, onError, registerCapture, onRendered, onCameraChange }: Omit<Props, "onSelect"> & {
  placements: Placement[]; resources: GeometryResources; analysis: AnalysisView; trace: RefObject<TraceControl | null>; axes: AxisStore;
}) {
  const { gl, invalidate, scene, size, viewport: { dpr }, set } = useThree();
  const controller = useMemo(() => new CameraController(), []);
  const controls = useRef<OrbitControls | null>(null);
  const fitted = useRef("");
  const contextLost = useRef(false);
  const activeView = useRef(active);
  activeView.current = active;
  const { invalidateReport, assertCaptureReady } = useRenderReports({
    model, state, amount, stepPosition, sectionPosition, active, background: background ?? null, placements, resources, analysis, controller, fitted, contextLost, onRendered, onError,
  });
  // A capture carries the legend that explains its colours.
  const legend = useRef<AnalysisLegend | null>(analysis.legend);
  legend.current = analysis.legend;
  const stats = useRef(analysis.stats);
  stats.current = analysis.stats;
  const traced = useRef(false);
  traced.current = state.appearance === "raytraced";
  const cameraChanged = useRef(onCameraChange);
  cameraChanged.current = onCameraChange;
  useLayoutEffect(() => observeGraphicsContext(gl.domElement, () => {
    contextLost.current = true;
    if (controls.current) controls.current.enabled = false;
    onError("Graphics context lost. Reload the canvas to restore the view.");
  }, () => {
    contextLost.current = false;
    if (controls.current) controls.current.enabled = activeView.current;
    invalidateReport();
  }), [gl, invalidateReport, onError]);
  useEffect(() => {
    if (controls.current) controls.current.enabled = active && !contextLost.current;
    if (active) invalidate();
  }, [active, invalidate]);

  useLayoutEffect(() => {
    controller.resize(size.width, size.height);
    // A viewport change needs a fresh projection report even at the same revision.
    invalidateReport();
  }, [size.width, size.height, dpr, controller, invalidateReport]);

  useLayoutEffect(() => {
    const committed = placeParts(model, state.explode, state.direction, state.fixedId, sequencePose(state));
    const visible = committed.filter((item) => !state.hiddenIds.includes(item.node.id));
    const bounds = mergeBounds(visible.map((item) => item.bounds)) || model.bounds;
    const origin = sceneOrigin(model);
    const fitKey = `${state.topologyRevision}:${state.fitNonce}`;
    if (headless ? state.cameraPinned && state.camera : !fitted.current && state.camera) controller.restore(state.camera!);
    else if (headless || fitted.current !== fitKey) {
      controller.fit({
        min: bounds.min.map((value, axis) => value - origin[axis]) as [number, number, number],
        max: bounds.max.map((value, axis) => value - origin[axis]) as [number, number, number],
      }, state.cameraPreset, state.projection);
    }
    controller.setProjection(state.projection);
    const camera = controller.camera;
    set({ camera });
    const orbit = new OrbitControls(camera, gl.domElement);
    orbit.target.copy(controller.target);
    orbit.enableDamping = false;
    orbit.zoomToCursor = true;
    orbit.enabled = activeView.current && !contextLost.current;
    orbit.minDistance = camera.near * 10;
    orbit.maxDistance = camera.far * 0.4;
    orbit.minZoom = 0.02;
    orbit.maxZoom = 500;
    const changed = () => {
      controller.target.copy(orbit.target);
      axes.update(camera.quaternion);
      invalidate();
    };
    let orbitStarted: string | null = null;
    const started = () => { orbitStarted = JSON.stringify(controller.snapshot()); };
    const ended = () => {
      controller.target.copy(orbit.target);
      const current = controller.snapshot();
      if (activeView.current && orbitStarted !== JSON.stringify(current)) cameraChanged.current(current);
      orbitStarted = null;
    };
    orbit.addEventListener("change", changed);
    orbit.addEventListener("start", started);
    orbit.addEventListener("end", ended);
    controls.current = orbit;
    orbit.update();
    axes.update(camera.quaternion);
    fitted.current = fitKey;
    invalidate();
    return () => {
      orbit.removeEventListener("change", changed);
      orbit.removeEventListener("start", started);
      orbit.removeEventListener("end", ended);
      orbit.dispose();
      controls.current = null;
    };
  }, [model, state.cameraPreset, state.projection, state.fitNonce, controller, axes, gl, invalidate, set,
    // The background renderer refits when its size changes and follows a camera the person moved.
    headless ? `${size.width}x${size.height}:${state.cameraPinned ? JSON.stringify(state.camera) : ""}` : ""]);

  useEffect(() => {
    registerCapture((limits) => {
      assertCaptureReady();
      // A ray-traced view is captured once it has traced far enough; its picture is then on the canvas.
      if (traced.current) {
        if (!trace.current) throw new Error("The ray-traced view is not ready");
        return trace.current.settle(limits ?? traceLimits()).then((report) => ({
          dataUrl: gl.domElement.toDataURL("image/png"), width: gl.domElement.width, height: gl.domElement.height,
          camera: controller.snapshot(), trace: report,
        }));
      }
      gl.render(scene, controller.camera);
      return {
        dataUrl: legend.current ? withLegend(gl.domElement, legend.current, gl.getPixelRatio()) : gl.domElement.toDataURL("image/png"),
        width: gl.domElement.width, height: gl.domElement.height, camera: controller.snapshot(), analysisStats: stats.current,
      };
    });
    return () => registerCapture(null);
  }, [controller, gl, scene, registerCapture, assertCaptureReady, trace]);

  return null;
}

export default function Scene(props: Props) {
  const { model, state, amount, stepPosition, sectionPosition } = props;
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const placements = useMemo(() => placeParts(model, amount, state.direction, state.fixedId, sequencePose(state, stepPosition)),
    // The sequence's digest, not its object identity, which every state event replaces.
    [model, amount, state.direction, state.fixedId, state.assembly?.digest, state.stepMode, stepPosition]);
  const origin = useMemo(() => sceneOrigin(model), [model]);
  const section = useMemo(() => ({ ...state.section, position: sectionPosition }),
    [state.section.enabled, state.section.axis, state.section.flipped, sectionPosition]);
  const clippingPlane = useMemo(() => sceneSectionPlane(section, origin), [section, origin]);
  // Geometry is built once per composed model: arranging files gives a new model object over the same parts.
  const resources = useMemo(() => new GeometryResources(model), [model.parts]);
  const axes = useMemo(createAxisStore, []);
  const shading = useMemo(() => new AnalysisShading(), []);
  // The ray-traced view draws Studio's light and finishes, without analysis views, section cuts or outlines.
  const traced = state.appearance === "raytraced";
  const trace = useRef<TraceControl | null>(null);
  const traceStore = useMemo(createTraceStore, []);
  const drawnAnalysis = analysisDrawn(state.appearance, state.analysis);
  useEffect(() => () => shading.dispose(), [shading]);
  const shown = useMemo(() => placements.filter((part) => !state.hiddenIds.includes(part.node.id)), [placements, state.hiddenIds]);
  // The legend lists fault colours only while a shown mesh has faults to draw.
  const faultsShown = state.showFaults && shown.some(({ part, node }) => !node.ghost && part.faults && Object.values(part.faults).some(Boolean));
  const analysis = useAnalysis({ analysis: drawnAnalysis, placements: shown, resources, origin, faults: faultsShown && !traced, onError: props.onError });
  shading.update(drawnAnalysis, { plate: analysis.plate, curvatureScale: analysis.stats.curvatureScale });
  const pickingEnabled = props.active && amount === state.explode && stepPosition === state.step && sectionPosition === state.section.position && !state.loading;
  // Dense meshes that can be picked get their picking trees from a worker; ghosts, hidden parts and the background
  // renderer, which never picks, do not ask.
  useEffect(() => {
    if (props.headless) return;
    const pickable = new Set(model.nodes.filter((node) => node.partId && !node.ghost && !state.hiddenIds.includes(node.id)).map((node) => node.partId));
    for (const part of model.parts) if (pickable.has(part.id)) resources.requestTree(part);
  }, [model, resources, state.hiddenIds, props.headless]);
  const onHover = useCallback((next: HoverTarget | null) => setHovered((current) =>
    current?.nodeId === next?.nodeId && current?.faceId === next?.faceId && current?.edgeId === next?.edgeId ? current : next
  ), []);
  const onHoverEnd = useCallback((nodeId: string) => setHovered((current) => current?.nodeId === nodeId ? null : current), []);
  useEffect(() => setHovered(null), [model.topologyRevision, state.selectionMode, state.hiddenIds, state.explode, state.direction, state.fixedId, state.step, state.stepMode,
    state.section.enabled, state.section.axis, state.section.position, state.section.flipped, pickingEnabled]);
  useEffect(() => () => resources.dispose(), [resources]);
  const displayedBounds = mergeBounds(shown.map((part) => part.bounds)) || model.bounds;
  const gridSize = Math.max(diagonal(model.bounds) * 2, 100);
  const studio = state.appearance !== "inspect";
  const capSize = Math.max(diagonal(displayedBounds) * 2, diagonal(model.bounds) * 2, 100);
  const capGeometry = useMemo(() => new PlaneGeometry(capSize, capSize), [capSize]);
  useEffect(() => () => capGeometry.dispose(), [capGeometry]);
  const capCenter = center(displayedBounds).map((value, axis) => value - origin[axis]) as [number, number, number];
  const stageBounds = useMemo(() => ({
    min: displayedBounds.min.map((value, axis) => value - origin[axis]) as [number, number, number],
    max: displayedBounds.max.map((value, axis) => value - origin[axis]) as [number, number, number],
  }), [...displayedBounds.min, ...displayedBounds.max, origin]);
  return (
    <>
    <Canvas frameloop={props.active ? "demand" : "never"} shadows={studio ? "percentage" : false} dpr={props.headless ? 1 : [1, 2]} camera={{ fov: 42, up: [0, 0, 1] }}
      events={(store) => ({
        ...events(store),
        filter: (hits, root) => prioritizeEdges(hits, root.camera, root.pointer, root.size.width, root.size.height),
      })}
      gl={{ antialias: true, preserveDrawingBuffer: true, stencil: true }}
      onPointerMissed={() => { if (props.active) props.onSelect(""); }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
        gl.domElement.setAttribute("aria-label", "Interactive model");
      }}>
      <color attach="background" args={[props.background ?? (studio ? STUDIO_BACKGROUND : "#0b1722")]} />
      {/* A custom backdrop is for presentation images: it replaces Studio's floor and leaves out the inspection grid. */}
      <StudioStage bounds={stageBounds} enabled={studio} floor={!props.background} />
      {!studio && <>
        <ambientLight intensity={1.25} />
        <hemisphereLight args={["#d9eefb", "#19222f", 2.2]} />
        <directionalLight position={[100, -120, 180]} intensity={3} />
        <directionalLight position={[-100, 100, 30]} intensity={1.2} color="#7bcbd8" />
        {!props.background && <gridHelper args={[gridSize, 24, "#2a485a", "#172f40"]} rotation={[Math.PI / 2, 0, 0]}
          position={[0, 0, displayedBounds.min[2] - origin[2] - 1]} />}
      </>}
      {shown.map((placement) => (
        <PartMesh key={placement.node.id} placement={placement} resources={resources.get(placement.part)} origin={origin}
          faults={state.showFaults && !placement.node.ghost ? resources.faults(placement.part) : null}
          selected={state.selectedIds.includes(placement.node.id)}
          faceId={state.selectedFace?.nodeId === placement.node.id ? state.selectedFace.faceId : null}
          edgeId={state.selectedEdge?.nodeId === placement.node.id ? state.selectedEdge.edgeId : null}
          point={state.selectedPoint?.nodeId === placement.node.id ? state.selectedPoint.point : null}
          hovered={hovered?.nodeId === placement.node.id && hovered.faceId === null && !hovered.edgeId}
          hoverFaceId={state.selectionMode === "face" && hovered?.nodeId === placement.node.id ? hovered.faceId : null}
          hoverEdgeId={state.selectionMode === "edge" && hovered?.nodeId === placement.node.id ? hovered.edgeId ?? null : null}
          selectionMode={state.selectionMode} pickingEnabled={pickingEnabled}
          section={section} clippingPlane={clippingPlane}
          studio={studio} finish={state.materialFinish} showEdges={state.showEdges}
          analysis={drawnAnalysis} analysisData={resources.analysis(placement.part)} shading={shading}
          showValues={(values) => resources.showValues(placement.part, values)}
          onSelect={props.onSelect} onHover={onHover} onHoverEnd={onHoverEnd} />
      ))}
      {clippingPlane && shown.filter((part) => !part.node.ghost).map((placement, index) => (
        placement.part.sectionCaps === true
          ? <SectionCap key={`section:${placement.node.id}`} placement={placement} resources={resources.get(placement.part)}
            origin={origin} capCenter={capCenter} section={section} plane={clippingPlane} planeGeometry={capGeometry}
            order={10 + index * 3} studio={studio} />
          : <SectionOutline key={`section:${placement.node.id}`} placement={placement} origin={origin} section={section} order={10 + index * 3} />
      ))}
      {stepPosition !== null && <SequenceTrails placements={shown} origin={origin} />}
      {traced && <RayTraced page={!props.headless} background={props.background ?? STUDIO_BACKGROUND}
        floor={props.background ? null : studioFloor(stageBounds)} control={trace} store={traceStore} />}
      <Rig {...props} placements={placements} resources={resources} analysis={analysis} trace={trace} axes={axes} />
    </Canvas>
    {props.active && !props.headless && <AxisIndicator store={axes} onChoose={props.onView} />}
    {!props.headless && analysis.legend && <LegendOverlay legend={analysis.legend} />}
    {!props.headless && traced && <TraceStatus store={traceStore} />}
    </>
  );
}
