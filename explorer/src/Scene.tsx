import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BufferAttribute, BufferGeometry, Color, DoubleSide, EdgesGeometry, Matrix4, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { center, diagonal, faceAtTriangle, facePositions, hoverTarget, mergeBounds, placeParts, type CadFace, type HoverTarget, type Model, type Part, type Placement, type ViewState } from "./model.ts";
import type { CameraState, RenderReport, ViewCapture } from "./host.ts";
import { GeometryResources, type PartResources } from "./resources.ts";
import { observeGraphicsContext } from "./graphicsLifecycle.ts";
import { CameraController, type ViewPreset } from "./camera.ts";
import { AxisIndicator, createAxisStore, type AxisStore } from "./AxisIndicator.tsx";
import StudioStage from "./Studio.tsx";
import { appearanceFor, type MaterialFinish } from "./appearance.ts";

type Props = {
  model: Model;
  state: ViewState;
  amount: number;
  active: boolean;
  onSelect: (id: string, faceId?: string) => void;
  onError: (message: string) => void;
  registerCapture: (capture: (() => ViewCapture) | null) => void;
  onRendered: (report: RenderReport) => Promise<unknown>;
  onCameraChange: (camera: CameraState) => void;
  onView: (preset: ViewPreset) => void;
};

function FaceOverlay({ part, face, selected }: { part: Part; face: CadFace; selected: boolean }) {
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
          depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      <lineSegments geometry={edges} raycast={() => undefined} renderOrder={selected ? 4 : 2}>
        <lineBasicMaterial color={selected ? "#d8ffff" : "#c9edf2"} transparent opacity={selected ? 1 : 0.8} depthWrite={false} />
      </lineSegments>
    </>
  );
}

function PartMesh({ placement, resources, origin, selected, faceId, hovered, hoverFaceId, selectionMode, pickingEnabled, studio, finish, showEdges, onSelect, onHover, onHoverEnd }: {
  placement: Placement;
  resources: PartResources;
  origin: number[];
  selected: boolean;
  faceId: string | null;
  hovered: boolean;
  hoverFaceId: string | null;
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
  const selectedFace = part.faces.find((item) => item.id === faceId) ?? null;
  const hoveredFace = part.faces.find((item) => item.id === hoverFaceId && item.id !== faceId) ?? null;
  const matrix = useMemo(() => {
    const result = new Matrix4().fromArray(placement.matrix);
    for (let axis = 0; axis < 3; axis++) result.elements[12 + axis] -= origin[axis];
    return result;
  }, [placement, origin]);
  const color = new Color(...node.color);
  const wholePartSelected = selected && !selectedFace;
  const wholePartHovered = hovered && !wholePartSelected;
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <mesh castShadow={studio} receiveShadow={studio} onClick={(event) => {
        event.stopPropagation();
        if (!pickingEnabled || event.delta > 4) return;
        if (selectionMode === "face") {
          const hitFace = faceAtTriangle(part, event.faceIndex ?? -1);
          if (hitFace) onSelect(node.id, hitFace.id);
        } else onSelect(node.id);
      }} onPointerMove={(event) => {
        if (!pickingEnabled) return;
        event.stopPropagation();
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
          emissiveIntensity={wholePartSelected ? 0.3 : wholePartHovered ? 0.18 : 0} />
      </mesh>
      <lineSegments visible={showEdges || wholePartSelected || wholePartHovered} raycast={() => undefined}>
        <primitive object={edges} attach="geometry" />
        <lineBasicMaterial color={wholePartSelected ? "#c5fff5" : wholePartHovered ? "#c9edf2" : "#0e2533"} transparent
          opacity={wholePartSelected ? 0.9 : wholePartHovered ? 0.75 : 0.45} />
      </lineSegments>
      {hoveredFace && <FaceOverlay part={part} face={hoveredFace} selected={false} />}
      {selectedFace && <FaceOverlay part={part} face={selectedFace} selected />}
    </group>
  );
}

function Rig({ model, state, amount, active, placements, resources, axes, onError, registerCapture, onRendered, onCameraChange }: Omit<Props, "onSelect"> & { placements: Placement[]; resources: GeometryResources; axes: AxisStore }) {
  const { gl, invalidate, scene, size, viewport: { dpr }, set } = useThree();
  const controller = useMemo(() => new CameraController(), []);
  const controls = useRef<OrbitControls | null>(null);
  const lastReported = useRef(-1);
  const fitted = useRef("");
  const contextLost = useRef(false);
  const latest = useRef({ model, state, amount, active, placements });
  latest.current = { model, state, amount, active, placements };
  const cameraChanged = useRef(onCameraChange);
  cameraChanged.current = onCameraChange;
  useLayoutEffect(() => observeGraphicsContext(gl.domElement, () => {
    contextLost.current = true;
    if (controls.current) controls.current.enabled = false;
    onError("Graphics context lost. Reload the canvas to restore the view.");
  }, () => {
    contextLost.current = false;
    if (controls.current) controls.current.enabled = latest.current.active;
    lastReported.current = -1;
    invalidate();
  }), [gl, invalidate, onError]);
  useEffect(() => {
    if (controls.current) controls.current.enabled = active && !contextLost.current;
    if (active) invalidate();
  }, [active, invalidate]);

  useLayoutEffect(() => {
    controller.resize(size.width, size.height);
    // A viewport change needs a fresh projection report even at the same revision.
    lastReported.current = -1;
    invalidate();
  }, [size.width, size.height, dpr, controller, invalidate]);

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
    orbit.enabled = latest.current.active && !contextLost.current;
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
      if (latest.current.active && orbitStarted !== JSON.stringify(current)) cameraChanged.current(current);
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
      if (!latest.current.active || contextLost.current) throw new Error("The live model renderer is not available for capture");
      if (latest.current.amount !== latest.current.state.explode) throw new Error("Finish adjusting the explosion slider before capturing");
      if (lastReported.current !== latest.current.state.revision ||
          fitted.current !== `${latest.current.state.topologyRevision}:${latest.current.state.fitNonce}`) {
        throw new Error("The view is still updating. Capture it again once it has settled.");
      }
      gl.render(scene, controller.camera);
      return {
        dataUrl: gl.domElement.toDataURL("image/png"), width: gl.domElement.width, height: gl.domElement.height,
        camera: controller.snapshot(),
      };
    });
    return () => registerCapture(null);
  }, [controller, gl, scene, registerCapture]);

  useEffect(() => { if (active) invalidate(); }, [state.revision, placements, active, invalidate]);
  useFrame(() => {
    const current = latest.current;
    if (!current.active || contextLost.current || lastReported.current === current.state.revision || current.model.topologyRevision !== current.state.topologyRevision ||
        current.amount !== current.state.explode ||
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
    if (selectedFace && selectedPlacement) {
      const point = new Vector3(...selectedFace.center).applyMatrix4(new Matrix4().fromArray(selectedPlacement.matrix));
      point.sub(new Vector3(...origin)).project(camera);
      selectedFaceScreen = [(point.x + 1) * size.width / 2, (1 - point.y) * size.height / 2];
    }
    const report: RenderReport = {
      revision: current.state.revision,
      modelHash: current.model.source.sha256,
      topologyRevision: current.model.topologyRevision,
      visibleParts: visible.length,
      selectedIds: current.state.selectedIds,
      selectedFace: current.state.selectedFace,
      highlightedTriangles: selectedFace?.triangleCount ?? 0,
      selectedFaceScreen,
      bounds: mergeBounds(visible.map((part) => part.bounds)),
      positions: visible.map((part) => ({ id: part.node.id, position: part.matrix.slice(12, 15) })),
      renderer: "React Three Fiber / WebGL2",
      inFrame,
      geometryDefinitions: resources.size,
      geometryIds: visible.map((part) => ({ id: part.node.id, geometry: resources.get(part.part).geometry.uuid })),
      camera: controller.snapshot(), appearance: current.state.appearance, materialFinish: current.state.materialFinish,
      projectedBounds: projected.length ? {
        min: [0, 1, 2].map((axis) => Math.min(...projected.map((point) => point[axis]))),
        max: [0, 1, 2].map((axis) => Math.max(...projected.map((point) => point[axis]))),
      } : null,
    };
    queueMicrotask(() => { void onRendered(report).catch((error: Error) => onError(error.message)); });
  });
  return null;
}

export default function Scene(props: Props) {
  const { model, state, amount } = props;
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const placements = useMemo(() => placeParts(model, amount, state.direction, state.fixedId), [model, amount, state.direction, state.fixedId]);
  const origin = useMemo(() => center(model.bounds), [model]);
  const resources = useMemo(() => new GeometryResources(model), [model]);
  const axes = useMemo(createAxisStore, []);
  const pickingEnabled = props.active && amount === state.explode && !state.loading;
  const onHover = useCallback((next: HoverTarget | null) => setHovered((current) =>
    current?.nodeId === next?.nodeId && current?.faceId === next?.faceId ? current : next
  ), []);
  const onHoverEnd = useCallback((nodeId: string) => setHovered((current) => current?.nodeId === nodeId ? null : current), []);
  useEffect(() => setHovered(null), [model.topologyRevision, state.selectionMode, pickingEnabled]);
  useEffect(() => () => resources.dispose(), [resources]);
  const displayedBounds = mergeBounds(placements.filter((part) => !state.hiddenIds.includes(part.node.id)).map((part) => part.bounds)) || model.bounds;
  const gridSize = Math.max(diagonal(model.bounds) * 2, 100);
  const studio = state.appearance === "studio";
  const stageBounds = useMemo(() => ({
    min: displayedBounds.min.map((value, axis) => value - origin[axis]) as [number, number, number],
    max: displayedBounds.max.map((value, axis) => value - origin[axis]) as [number, number, number],
  }), [...displayedBounds.min, ...displayedBounds.max, origin]);
  return (
    <>
    <Canvas frameloop={props.active ? "demand" : "never"} shadows={studio ? "percentage" : false} dpr={[1, 2]} camera={{ fov: 42, up: [0, 0, 1] }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onPointerMissed={() => { if (props.active) props.onSelect(""); }}
      onCreated={({ gl }) => {
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
          hovered={state.selectionMode === "part" && hovered?.nodeId === placement.node.id}
          hoverFaceId={state.selectionMode === "face" && hovered?.nodeId === placement.node.id ? hovered.faceId : null}
          selectionMode={state.selectionMode} pickingEnabled={pickingEnabled}
          studio={studio} finish={state.materialFinish} showEdges={state.showEdges}
          onSelect={props.onSelect} onHover={onHover} onHoverEnd={onHoverEnd} />
      ))}
      <Rig {...props} placements={placements} resources={resources} axes={axes} />
    </Canvas>
    {props.active && <AxisIndicator store={axes} onChoose={props.onView} />}
    </>
  );
}
