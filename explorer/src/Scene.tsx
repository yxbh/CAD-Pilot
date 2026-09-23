import { Canvas, events, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlwaysStencilFunc, BackSide, BufferAttribute, BufferGeometry, Color, DecrementWrapStencilOp, DoubleSide,
  EdgesGeometry, FrontSide, IncrementWrapStencilOp, KeepStencilOp, Matrix4, Mesh, NotEqualStencilFunc,
  Plane, PlaneGeometry, ReplaceStencilOp,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { center, diagonal, edgeSegments, faceAtTriangle, facePositions, hoverTarget, mergeBounds, placeParts, type CadEdge, type CadFace, type HoverTarget, type Model, type Part, type Placement, type ViewState } from "./model.ts";
import type { CameraState, RenderReport, ViewCapture } from "./host.ts";
import { edgeAtSegment, GeometryResources, type EdgeRange, type PartResources } from "./resources.ts";
import { prioritizeEdges, visibleEdgeHits } from "./edgePicking.ts";
import { useRenderReports } from "./useRenderReports.ts";
import { observeGraphicsContext } from "./graphicsLifecycle.ts";
import { CameraController, type ViewPreset } from "./camera.ts";
import { AxisIndicator, createAxisStore, type AxisStore } from "./AxisIndicator.tsx";
import StudioStage from "./Studio.tsx";
import { appearanceFor, type MaterialFinish } from "./appearance.ts";
import type { SectionSettings } from "../shared/section.mjs";
import {
  clipCadEdges, sceneSectionPlane, sectionMeshRaycast, sectionOutlineSegments,
  visibleFacePoint, visibleFaceTriangleCount,
} from "./section.ts";

type Props = {
  model: Model;
  state: ViewState;
  amount: number;
  sectionPosition: number;
  active: boolean;
  onSelect: (id: string, faceId?: string, edgeId?: string) => void;
  onError: (message: string) => void;
  registerCapture: (capture: (() => ViewCapture) | null) => void;
  onRendered: (report: RenderReport) => Promise<unknown>;
  onCameraChange: (camera: CameraState) => void;
  onView: (preset: ViewPreset) => void;
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

function CadLines({ geometry, color, width, visible = true, renderOrder = 0, picking, clippingPlane, onSelect, onHover, onHoverEnd }: {
  geometry: LineSegmentsGeometry;
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
  return <primitive object={lines} visible={visible} userData={{ cadEdges: true }}
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
  const matrix = useMemo(() => {
    const result = new Matrix4().fromArray(placement.matrix);
    for (let axis = 0; axis < 3; axis++) result.elements[12 + axis] -= origin[axis];
    return result;
  }, [placement, origin]);
  const outlinePositions = useMemo(() => sectionOutlineSegments(placement.part, placement.matrix, section),
    [placement.part, placement.matrix, section.axis, section.position, section.flipped]);
  const outline = useMemo(() => outlinePositions.length ? new LineSegmentsGeometry().setPositions(outlinePositions) : null, [outlinePositions]);
  useEffect(() => () => outline?.dispose(), [outline]);
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
      {outline && <CadLines geometry={outline} color="#102631" width={1.6} renderOrder={order + 2} />}
    </group>
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

function sectionAxis(axis: SectionSettings["axis"]) {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

function PartMesh({ placement, resources, origin, section, clippingPlane, selected, faceId, edgeId, hovered, hoverFaceId, hoverEdgeId, selectionMode, pickingEnabled, studio, finish, showEdges, onSelect, onHover, onHoverEnd }: {
  placement: Placement;
  resources: PartResources;
  origin: number[];
  section: SectionSettings;
  clippingPlane: Plane | null;
  selected: boolean;
  faceId: string | null;
  edgeId: string | null;
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
  const selectedFace = part.faces.find((item) => item.id === faceId) ?? null;
  const hoveredFace = part.faces.find((item) => item.id === hoverFaceId && item.id !== faceId) ?? null;
  const selectedEdge = part.edges?.find((item) => item.id === edgeId) ?? null;
  const hoveredEdge = part.edges?.find((item) => item.id === hoverEdgeId && item.id !== edgeId) ?? null;
  const matrix = useMemo(() => {
    const result = new Matrix4().fromArray(placement.matrix);
    for (let axis = 0; axis < 3; axis++) result.elements[12 + axis] -= origin[axis];
    return result;
  }, [placement, origin]);
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
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <mesh ref={surface} name="cad-surface" castShadow={studio} receiveShadow={studio}
        raycast={(raycaster, hits) => { if (surface.current) sectionMeshRaycast(surface.current, raycaster, hits, clippingPlane); }}
        onClick={(event) => {
        event.stopPropagation();
        if (!pickingEnabled || event.delta > 4 || (event.faceIndex ?? -1) < 0) return;
        if (selectionMode === "face") {
          const hitFace = faceAtTriangle(part, event.faceIndex ?? -1);
          if (hitFace) onSelect(node.id, hitFace.id);
        } else if (selectionMode === "part") onSelect(node.id);
        else onSelect("");
      }} onPointerMove={(event) => {
        if (!pickingEnabled) return;
        event.stopPropagation();
        if ((event.faceIndex ?? -1) < 0) { onHover(null); return; }
        onHover(hoverTarget(part, node.id, selectionMode, event.faceIndex ?? -1));
      }} onPointerOut={(event) => {
        if (!pickingEnabled) return;
        event.stopPropagation();
        onHoverEnd(node.id);
      }}>
        <primitive object={geometry} attach="geometry" />
        <meshPhysicalMaterial color={wholePartSelected ? "#7ee7da" : wholePartHovered ? "#79aeb9" : color}
          {...(studio ? appearanceFor(finish) : { roughness: 0.45, metalness: 0.15, clearcoat: 0, clearcoatRoughness: 0, envMapIntensity: 0 })}
          emissive={wholePartSelected ? "#167b75" : wholePartHovered ? "#134d59" : "#000000"}
          emissiveIntensity={wholePartSelected ? 0.3 : wholePartHovered ? 0.18 : 0}
          side={section.enabled ? DoubleSide : FrontSide} clippingPlanes={clippingPlane ? [clippingPlane] : []}
          clipShadows={section.enabled} />
      </mesh>
      <lineSegments visible={!resources.cadEdges && (showEdges || wholePartSelected || wholePartHovered)} raycast={() => undefined}>
        <primitive object={edges} attach="geometry" />
        <lineBasicMaterial color={wholePartSelected ? "#c5fff5" : wholePartHovered ? "#c9edf2" : "#0e2533"} transparent
          opacity={wholePartSelected ? 0.9 : wholePartHovered ? 0.75 : 0.45}
          clippingPlanes={clippingPlane ? [clippingPlane] : []} />
      </lineSegments>
      {resources.cadEdges && (!section.enabled || clippedEdges?.geometry) && <CadLines geometry={clippedEdges?.geometry ?? resources.cadEdges}
        color={wholePartSelected ? "#c5fff5" : wholePartHovered ? "#c9edf2" : selectionMode === "edge" ? "#7896a6" : "#0e2533"} width={1}
        visible={showEdges || selectionMode === "edge" || wholePartSelected || wholePartHovered}
        picking={pickingEnabled && selectionMode === "edge" ? {
          nodeId: node.id, ranges: clippedEdges?.ranges ?? resources.edgeRanges, tolerance: Math.max(diagonal(part.bounds) * 1e-5, 1e-6),
        } : undefined}
        onSelect={onSelect} onHover={onHover} onHoverEnd={onHoverEnd} />}
      {hoveredFace && <FaceOverlay part={part} face={hoveredFace} selected={false} clippingPlane={clippingPlane} />}
      {selectedFace && <FaceOverlay part={part} face={selectedFace} selected clippingPlane={clippingPlane} />}
      {hoveredEdge && <EdgeOverlay edge={hoveredEdge} selected={false} matrix={placement.matrix} section={section} />}
      {selectedEdge && <EdgeOverlay edge={selectedEdge} selected matrix={placement.matrix} section={section} />}
    </group>
  );
}

function Rig({ model, state, amount, sectionPosition, active, placements, resources, axes, onError, registerCapture, onRendered, onCameraChange }: Omit<Props, "onSelect"> & { placements: Placement[]; resources: GeometryResources; axes: AxisStore }) {
  const { gl, invalidate, scene, size, viewport: { dpr }, set } = useThree();
  const controller = useMemo(() => new CameraController(), []);
  const controls = useRef<OrbitControls | null>(null);
  const fitted = useRef("");
  const contextLost = useRef(false);
  const activeView = useRef(active);
  activeView.current = active;
  const { invalidateReport, assertCaptureReady } = useRenderReports({
    model, state, amount, sectionPosition, active, placements, resources, controller, fitted, contextLost, onRendered, onError,
  });
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
    const committed = placeParts(model, state.explode, state.direction, state.fixedId);
    const visible = committed.filter((item) => !state.hiddenIds.includes(item.node.id));
    const bounds = mergeBounds(visible.map((item) => item.bounds)) || model.bounds;
    const origin = center(model.bounds);
    const fitKey = `${state.topologyRevision}:${state.fitNonce}`;
    if (!fitted.current && state.camera) controller.restore(state.camera);
    else if (fitted.current !== fitKey) {
      controller.fit({
        min: bounds.min.map((value, axis) => value - origin[axis]) as [number, number, number],
        max: bounds.max.map((value, axis) => value - origin[axis]) as [number, number, number],
      }, state.cameraPreset);
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
  }, [model, state.cameraPreset, state.projection, state.fitNonce, controller, axes, gl, invalidate, set]);

  useEffect(() => {
    registerCapture(() => {
      assertCaptureReady();
      gl.render(scene, controller.camera);
      return {
        dataUrl: gl.domElement.toDataURL("image/png"), width: gl.domElement.width, height: gl.domElement.height,
        camera: controller.snapshot(),
      };
    });
    return () => registerCapture(null);
  }, [controller, gl, scene, registerCapture, assertCaptureReady]);

  return null;
}

export default function Scene(props: Props) {
  const { model, state, amount, sectionPosition } = props;
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const placements = useMemo(() => placeParts(model, amount, state.direction, state.fixedId), [model, amount, state.direction, state.fixedId]);
  const origin = useMemo(() => center(model.bounds), [model]);
  const section = useMemo(() => ({ ...state.section, position: sectionPosition }),
    [state.section.enabled, state.section.axis, state.section.flipped, sectionPosition]);
  const clippingPlane = useMemo(() => sceneSectionPlane(section, origin), [section, origin]);
  const resources = useMemo(() => new GeometryResources(model), [model]);
  const axes = useMemo(createAxisStore, []);
  const pickingEnabled = props.active && amount === state.explode && sectionPosition === state.section.position && !state.loading;
  const onHover = useCallback((next: HoverTarget | null) => setHovered((current) =>
    current?.nodeId === next?.nodeId && current?.faceId === next?.faceId && current?.edgeId === next?.edgeId ? current : next
  ), []);
  const onHoverEnd = useCallback((nodeId: string) => setHovered((current) => current?.nodeId === nodeId ? null : current), []);
  useEffect(() => setHovered(null), [model.topologyRevision, state.selectionMode, state.hiddenIds, state.explode, state.direction, state.fixedId,
    state.section.enabled, state.section.axis, state.section.position, state.section.flipped, pickingEnabled]);
  useEffect(() => () => resources.dispose(), [resources]);
  const displayedBounds = mergeBounds(placements.filter((part) => !state.hiddenIds.includes(part.node.id)).map((part) => part.bounds)) || model.bounds;
  const gridSize = Math.max(diagonal(model.bounds) * 2, 100);
  const studio = state.appearance === "studio";
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
    <Canvas frameloop={props.active ? "demand" : "never"} shadows={studio ? "percentage" : false} dpr={[1, 2]} camera={{ fov: 42, up: [0, 0, 1] }}
      events={(store) => ({
        ...events(store),
        filter: (hits, root) => prioritizeEdges(hits, root.camera, root.pointer, root.size.width, root.size.height),
      })}
      gl={{ antialias: true, preserveDrawingBuffer: true, stencil: true }}
      onPointerMissed={() => { if (props.active) props.onSelect(""); }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
        gl.domElement.setAttribute("aria-label", "Interactive STEP assembly");
      }}>
      <color attach="background" args={[studio ? "#29313d" : "#0b1722"]} />
      <StudioStage bounds={stageBounds} enabled={studio} />
      {!studio && <>
        <ambientLight intensity={1.25} />
        <hemisphereLight args={["#d9eefb", "#19222f", 2.2]} />
        <directionalLight position={[100, -120, 180]} intensity={3} />
        <directionalLight position={[-100, 100, 30]} intensity={1.2} color="#7bcbd8" />
        <gridHelper args={[gridSize, 24, "#2a485a", "#172f40"]} rotation={[Math.PI / 2, 0, 0]}
          position={[0, 0, displayedBounds.min[2] - origin[2] - 1]} />
      </>}
      {placements.filter((part) => !state.hiddenIds.includes(part.node.id)).map((placement) => (
        <PartMesh key={placement.node.id} placement={placement} resources={resources.get(placement.part)} origin={origin}
          selected={state.selectedIds.includes(placement.node.id)}
          faceId={state.selectedFace?.nodeId === placement.node.id ? state.selectedFace.faceId : null}
          edgeId={state.selectedEdge?.nodeId === placement.node.id ? state.selectedEdge.edgeId : null}
          hovered={state.selectionMode === "part" && hovered?.nodeId === placement.node.id}
          hoverFaceId={state.selectionMode === "face" && hovered?.nodeId === placement.node.id ? hovered.faceId : null}
          hoverEdgeId={state.selectionMode === "edge" && hovered?.nodeId === placement.node.id ? hovered.edgeId ?? null : null}
          selectionMode={state.selectionMode} pickingEnabled={pickingEnabled}
          section={section} clippingPlane={clippingPlane}
          studio={studio} finish={state.materialFinish} showEdges={state.showEdges}
          onSelect={props.onSelect} onHover={onHover} onHoverEnd={onHoverEnd} />
      ))}
      {clippingPlane && placements.filter((part) => !state.hiddenIds.includes(part.node.id) && part.part.sectionCaps === true).map((placement, index) => (
        <SectionCap key={`section:${placement.node.id}`} placement={placement} resources={resources.get(placement.part)}
          origin={origin} capCenter={capCenter} section={section} plane={clippingPlane} planeGeometry={capGeometry}
          order={10 + index * 3} studio={studio} />
      ))}
      <Rig {...props} placements={placements} resources={resources} axes={axes} />
    </Canvas>
    {props.active && <AxisIndicator store={axes} onChoose={props.onView} />}
    </>
  );
}
