// The ray-traced view: three-gpu-pathtracer's WebGL path tracer over the parts the view draws, lit by Studio's soft
// boxes, refined a sample at a time and denoised. It takes over the canvas while mounted; until its scene is prepared
// and its shader compiled, the Studio view shows instead.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import {
  BufferGeometry, Color, Euler, Mesh, MeshStandardMaterial, PlaneGeometry, Scene, type MeshPhysicalMaterial, type ShaderMaterial,
  type Texture,
} from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import { GenerateMeshBVHWorker } from "three-mesh-bvh/worker";
import { SOFTWARE_SECONDS, type TraceLimits, type TraceReport } from "../../shared/raytrace.mjs";
import { makeDenoiser } from "./denoiser.ts";
import { softboxStudio } from "./studio.ts";

export type TraceProgress = { phase: "preparing" | "compiling" | "tracing" | "resting"; samples: number; limit: number };
export type TraceControl = {
  /** Traces until the samples or seconds of tracing, whichever comes first, and leaves the result drawn on the canvas. */
  settle(limits: TraceLimits): Promise<TraceReport>;
};

// A tiny store the page's sample counter reads without re-rendering the scene every sample.
export function createTraceStore() {
  let progress: TraceProgress = { phase: "preparing", samples: 0, limit: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => progress,
    set(next: TraceProgress) {
      if (next.phase === progress.phase && next.samples === progress.samples && next.limit === progress.limit) return;
      progress = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type TraceStore = ReturnType<typeof createTraceStore>;

export function TraceStatus({ store }: { store: TraceStore }) {
  const progress = useSyncExternalStore(store.subscribe, store.get);
  const text = progress.phase === "preparing" ? "Preparing the ray-traced view..."
    : progress.phase === "compiling" ? "Compiling the path tracer..."
      : `Ray traced · ${progress.samples} of ${progress.limit} samples${progress.phase === "resting" ? "" : "..."}`;
  return <div className="trace-status" role="status">{text}</div>;
}

// Renderers that trace in software: a sample takes seconds rather than milliseconds.
const SOFTWARE = /SwiftShader|llvmpipe|softpipe|Basic Render|Software/i;
function rendererName(context: WebGLRenderingContext | WebGL2RenderingContext) {
  const info = context.getExtension("WEBGL_debug_renderer_info");
  return String(context.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER));
}
const TRACED = new Set(["cad-surface", "reference-surface"]);

/**
 * Two fixes to the tracer's shader, as VAULTaway's photo mode makes them. Its clearcoat squares a negative number with
 * pow(), which is NaN on Apple GPUs and turns every clear-coated part black. And it started each hit's shadow ray toward
 * a light where the path's next ray starts, under the surface when that went under it, so rough parts shadowed their own
 * light; the light is only ever sampled above the surface, so its ray starts there.
 */
function patchShader(material: ShaderMaterial) {
  const fixes: [string, string][] = [
    ["return pow( ( 1.0 - eta ) / ( 1.0 + eta ), 2.0 );", "float r = ( 1.0 - eta ) / ( 1.0 + eta ); return r * r;"],
    ["directLightContribution( - ray.direction, surf, state, hitPoint )",
      "directLightContribution( - ray.direction, surf, state, stepRayOrigin( ray.origin, ray.direction, surf.faceNormal, surfaceHit.dist ) )"],
  ];
  for (const [from, to] of fixes) {
    if (!material.fragmentShader.includes(from)) throw new Error("three-gpu-pathtracer's shader changed: check the ray-traced view's fixes in RayTraced.tsx");
    material.fragmentShader = material.fragmentShader.replace(from, to);
  }
  // The tracer starts with depth of field and fog on and no background map, and sets each as it first draws, compiling
  // its large shader again each time (tens of seconds in software). Set them as they will be: no lens blur or fog, and
  // a background.
  Object.assign(material.defines, { FEATURE_DOF: 0, FEATURE_FOG: 0, FEATURE_BACKGROUND_MAP: 1 });
  material.needsUpdate = true;
}
const FLOOR = new MeshStandardMaterial({ color: "#26313d", roughness: 0.92, metalness: 0 });

/**
 * limit: the samples to refine to on its own (a page's view; 0 traces only for captures). tiles: how many pieces each
 * way a sample is traced in, a frame each, so a page keeps answering. floor: where Studio's floor lies, or null for a
 * custom background. control receives settle() for captures; store, the progress.
 */
export function RayTraced({ limit, tiles, background, floor, control, store }: {
  limit: number; tiles: number; background: string; floor: { z: number; size: number; center: [number, number] } | null;
  control: RefObject<TraceControl | null>; store: TraceStore;
}) {
  const { gl, scene, camera, invalidate } = useThree();
  const name = useMemo(() => rendererName(gl.getContext()), [gl]);
  const parts = useMemo(() => {
    const traced = new Scene();
    traced.environment = softboxStudio();
    // The studio is drawn Y up; the model's up is Z.
    traced.environmentRotation = new Euler(Math.PI / 2, 0, 0);
    const worker = new GenerateMeshBVHWorker();
    // isCompiling is the tracer's own, missing from its type declarations.
    const tracer = new WebGLPathTracer(gl) as WebGLPathTracer & { readonly isCompiling: boolean; _pathTracer: { material: ShaderMaterial } };
    patchShader(tracer._pathTracer.material);
    tracer.setBVHWorker(worker);
    Object.assign(tracer, { minSamples: 1, renderDelay: 0, fadeDuration: 0, dynamicLowRes: true, lowResScale: 0.25, bounces: 5, filterGlossyFactor: 0.5 });
    const denoise = makeDenoiser(gl, () => traced, () => tracer.camera ?? camera);
    let denoised: Texture | null = null, denoisedAt = -1;
    tracer.renderToCanvasCallback = (target, renderer, quad) => {
      // Each whole sample is denoised once; tiles in between show the last.
      const whole = Math.floor(tracer.samples);
      if (whole !== denoisedAt || !denoised) { denoised = denoise(target, whole); denoisedAt = whole; }
      (quad.material as ShaderMaterial & { map: Texture }).map = denoised;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      quad.render(renderer);
      renderer.autoClear = autoClear;
    };
    return { traced, worker, tracer, denoise };
  }, [gl]);
  useEffect(() => () => {
    parts.tracer.dispose();
    parts.denoise.dispose();
    parts.worker.dispose();
    (parts.traced.environment as Texture | null)?.dispose();
  }, [parts]);
  // What the traced scene holds, and the camera the tracer follows: rebuilt or updated only when they change.
  const sync = useRef({ shape: "", look: "", camera: "", ready: false, building: false, stale: false });
  const goal = useRef<{ samples: number; seconds: number; since: number; resolve: (report: TraceReport) => void } | null>(null);
  const clock = useRef({ traced: 0, last: 0 });
  const limitRef = useRef(limit);
  limitRef.current = limit;
  parts.tracer.tiles.set(tiles, tiles);
  // Geometry shared with the view's surfaces, without the attributes the tracer adds to what it is given.
  const proxies = useMemo(() => new WeakMap<BufferGeometry, BufferGeometry>(), []);
  const floorGeometry = useMemo(() => new PlaneGeometry(1, 1), []);
  useEffect(() => () => floorGeometry.dispose(), [floorGeometry]);

  useEffect(() => {
    control.current = {
      settle: (limits) => new Promise((resolve) => {
        const software = SOFTWARE.test(name);
        goal.current = {
          samples: limits.samples, seconds: software ? Math.min(limits.seconds, SOFTWARE_SECONDS) : limits.seconds, since: performance.now(),
          resolve: (report) => resolve({ ...report, software, renderer: name }),
        };
        clock.current.traced = 0;
        invalidate();
      }),
    };
    return () => { control.current = null; };
  }, [control, name, invalidate]);

  function rebuild(surfaces: Mesh[]) {
    const { traced, tracer } = parts;
    traced.clear();
    traced.background = new Color(background);
    if (floor) {
      const plane = new Mesh(floorGeometry, FLOOR);
      plane.position.set(floor.center[0], floor.center[1], floor.z);
      plane.scale.set(floor.size, floor.size, 1);
      traced.add(plane);
    }
    for (const surface of surfaces) {
      let geometry = proxies.get(surface.geometry);
      if (!geometry) {
        geometry = new BufferGeometry();
        for (const [name, attribute] of Object.entries(surface.geometry.attributes)) if (name === "position" || name === "normal") geometry.setAttribute(name, attribute);
        geometry.setIndex(surface.geometry.index);
        proxies.set(surface.geometry, geometry);
      }
      const proxy = new Mesh(geometry, surface.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(surface.matrixWorld);
      traced.add(proxy);
    }
    sync.current.ready = false;
    sync.current.building = true;
    void tracer.setSceneAsync(traced, camera).then(() => {
      sync.current.building = false;
      sync.current.ready = !sync.current.stale;
      clock.current.traced = 0;
      invalidate();
    });
  }

  useFrame(() => {
    const { tracer } = parts;
    const state = sync.current;
    // The parts drawn, where they are, and how their materials look.
    const surfaces: Mesh[] = [];
    scene.traverseVisible((object) => { if ((object as Mesh).isMesh && TRACED.has(object.name)) surfaces.push(object as Mesh); });
    const shape = JSON.stringify([background, floor, surfaces.map((surface) => [surface.geometry.uuid, Array.from(surface.matrixWorld.elements)])]);
    const look = surfaces.map((surface) => {
      const material = surface.material as MeshPhysicalMaterial;
      return [material.uuid, material.color.getHex(), material.roughness, material.metalness, material.clearcoat, material.opacity].join();
    }).join(";");
    if (shape !== state.shape) {
      state.shape = shape;
      state.look = look;
      if (state.building) state.stale = true;
      else rebuild(surfaces);
    } else if (state.stale && !state.building) {
      state.stale = false;
      rebuild(surfaces);
    } else if (look !== state.look && state.ready) {
      state.look = look;
      tracer.updateMaterials();
    }
    const view = JSON.stringify([Array.from(camera.matrixWorld.elements), Array.from(camera.projectionMatrix.elements)]);
    if (view !== state.camera && state.ready) {
      state.camera = view;
      tracer.setCamera(camera);
    }
    const target = goal.current?.samples ?? limitRef.current;
    if (!state.ready || target === 0) {
      // Until the scene is ready, or with nothing to trace, the Studio view.
      gl.render(scene, camera);
      store.set({ phase: "preparing", samples: 0, limit: target });
      if (state.building) invalidate();
      return;
    }
    const now = performance.now();
    const seconds = goal.current?.seconds ?? Infinity;
    const running = tracer.samples < target && clock.current.traced < seconds;
    tracer.pausePathTracing = !running;
    // Tracing time runs between frames, where the GPU works; not inside renderSample(), where a renderer without
    // parallel shader compiling (software WebGL) compiles the tracer before its first sample.
    if (running && clock.current.last) clock.current.traced += (now - clock.current.last) / 1000;
    const compiling = tracer.isCompiling;
    tracer.renderSample();
    clock.current.last = running && !compiling ? performance.now() : 0;
    const samples = Math.floor(tracer.samples);
    store.set({ phase: compiling ? "compiling" : running ? "tracing" : "resting", samples, limit: target });
    if (running || compiling) invalidate();
    else if (goal.current) {
      const { resolve, since } = goal.current;
      goal.current = null;
      // The finished picture is on the canvas for the capture that waits on it.
      resolve({
        samples, asked: target, seconds: clock.current.traced, waited: (now - since) / 1000,
        stopped: samples >= target ? "samples" : "time", software: false, renderer: name,
      });
    }
  }, 1);
  return null;
}
