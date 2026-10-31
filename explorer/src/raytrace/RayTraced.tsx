// The ray-traced view: three-gpu-pathtracer's WebGL path tracer over the parts the view draws, lit by Studio's soft
// boxes, refined a sample at a time and denoised. It takes over the canvas while mounted; until its scene is prepared
// and its shader compiled, the Studio view shows instead.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import {
  ACESFilmicToneMapping, BufferGeometry, Color, Euler, Matrix3, Mesh, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, Scene,
  Vector2, Vector3, type Camera, type MeshPhysicalMaterial, type ShaderMaterial, type Texture, type WebGLRenderer, type WebGLRenderTarget,
} from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import { GenerateMeshBVHWorker } from "three-mesh-bvh/worker";
import { PAGE_SAMPLES, SOFTWARE_SECONDS, type TraceLimits, type TraceReport } from "../../shared/raytrace.mjs";
import { makeDenoiser } from "./denoiser.ts";
import { softboxStudio } from "./studio.ts";

export type TraceProgress = { phase: "preparing" | "compiling" | "tracing" | "resting" | "software"; samples: number; limit: number };
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
  const text = progress.phase === "software" ? "Ray tracing needs a GPU. This browser draws in software, so the view stays Studio's; renders and captures still trace."
    : progress.phase === "preparing" ? "Preparing the ray-traced view..."
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

// The tracer's fields reached into here: each of its two tracers (full and low resolution), how they compile and where
// they draw, missing from its type declarations.
type TracerPass = {
  material: ShaderMaterial; _primaryTarget: WebGLRenderTarget; _fsQuad: { _mesh: Mesh }; compileMaterial(): Promise<unknown>; dispose(): void;
};
type Tracer = WebGLPathTracer & { readonly isCompiling: boolean; _pathTracer: TracerPass; _lowResPathTracer: TracerPass };
const QUAD_CAMERA = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * Two fixes to the tracer's shader, as VAULTaway's photo mode makes them. Its clearcoat squares a negative number with
 * pow(), which is NaN on Apple GPUs and turns every clear-coated part black. And it started each hit's shadow ray toward
 * a light where the path's next ray starts, under the surface when that went under it, so rough parts shadowed their own
 * light; the light is only ever sampled above the surface, so its ray starts there.
 */
function patchShader(material: ShaderMaterial, camera: Camera) {
  const fixes: [string, string][] = [
    ["return pow( ( 1.0 - eta ) / ( 1.0 + eta ), 2.0 );", "float r = ( 1.0 - eta ) / ( 1.0 + eta ); return r * r;"],
    ["directLightContribution( - ray.direction, surf, state, hitPoint )",
      "directLightContribution( - ray.direction, surf, state, stepRayOrigin( ray.origin, ray.direction, surf.faceNormal, surfaceHit.dist ) )"],
  ];
  for (const [from, to] of fixes) {
    if (!material.fragmentShader.includes(from)) throw new Error("three-gpu-pathtracer's shader changed: check the ray-traced view's fixes in RayTraced.tsx");
    material.fragmentShader = material.fragmentShader.replace(from, to);
  }
  // The tracer starts with depth of field and fog on, no background map and a perspective camera, and sets each as it
  // first draws, compiling its large shader again each time (tens of seconds in software). Set them as they will be: no
  // lens blur or fog, a background, and this view's projection (an orthographic projection matrix ends in 1).
  Object.assign(material.defines, {
    FEATURE_DOF: 0, FEATURE_FOG: 0, FEATURE_BACKGROUND_MAP: 1, CAMERA_TYPE: camera.projectionMatrix.elements[15] > 0 ? 1 : 0,
  });
  material.needsUpdate = true;
}

/** Frees what the tracer made on the GPU: its own dispose() leaves its shader's data (the parts, their tree, the light). */
function disposeTracer(tracer: Tracer) {
  for (const { value } of Object.values(tracer._pathTracer.material.uniforms)) (value as { dispose?: () => void } | null)?.dispose?.();
  tracer._pathTracer.material.dispose();
  tracer._lowResPathTracer.dispose();
  tracer.dispose();
}

// three.js's ACES filmic tone mapping (tonemapping_pars_fragment), undone for a colour: the light the canvas shows as it.
// The raster view clears to its backdrop's colour as it is; a traced backdrop is light, tone mapped like the parts.
const ACES_IN_INVERSE = new Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777).invert();
const ACES_OUT_INVERSE = new Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602).invert();
function backdropLight(color: string, renderer: WebGLRenderer) {
  const shown = new Color(color);
  if (renderer.toneMapping !== ACESFilmicToneMapping) return shown;
  // RRTAndODTFit is a ratio of quadratics: solved for its input, the positive root. It nears 1/0.983729 at most.
  const fitted = new Vector3(shown.r, shown.g, shown.b).applyMatrix3(ACES_OUT_INVERSE).toArray().map((value) => {
    const u = Math.min(Math.max(value, 0), 1.016);
    const a = 1 - 0.983729 * u, b = 0.0245786 - 0.432951 * u, c = -(0.000090537 + 0.238081 * u);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  });
  const light = new Vector3(...fitted).applyMatrix3(ACES_IN_INVERSE).multiplyScalar(0.6 / renderer.toneMappingExposure);
  return new Color(Math.max(light.x, 0), Math.max(light.y, 0), Math.max(light.z, 0));
}

const FLOOR = new MeshStandardMaterial({ color: "#26313d", roughness: 0.92, metalness: 0 });

type Props = {
  page: boolean; background: string; floor: { z: number; size: number; center: [number, number] } | null;
  control: RefObject<TraceControl | null>; store: TraceStore;
};

/**
 * page: a person's view, which refines on its own in tiles (a frame each, so the page keeps answering); the background
 * renderer traces whole samples, and only for captures. floor: where Studio's floor lies, or null for a custom
 * background. control receives settle() for captures; store, the progress.
 */
export function RayTraced(props: Props) {
  const { gl } = useThree();
  const name = useMemo(() => rendererName(gl.getContext()), [gl]);
  const software = SOFTWARE.test(name);
  // A page without a GPU keeps the Studio view: software WebGL compiles the tracer in the browser's one GPU process,
  // holding every tab's drawing for a minute or more.
  return props.page && software ? <StudioOnly {...props} name={name} /> : <Tracing {...props} name={name} software={software} />;
}

// A page drawing in software: the Studio view, and captures of it, untraced.
function StudioOnly({ control, store, name }: Props & { name: string }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    store.set({ phase: "software", samples: 0, limit: 0 });
    control.current = {
      settle: async (limits) => ({ samples: 0, asked: limits.samples, seconds: 0, waited: 0, stopped: "untraced", software: true, renderer: name }),
    };
    return () => { control.current = null; };
  }, [control, store, name]);
  useFrame(() => gl.render(scene, camera), 1);
  return null;
}

function Tracing({ page, background, floor, control, store, name, software }: Props & { name: string; software: boolean }) {
  const { gl, scene, camera, invalidate } = useThree();
  const parts = useMemo(() => {
    const traced = new Scene();
    traced.environment = softboxStudio();
    // The studio is drawn Y up; the model's up is Z.
    traced.environmentRotation = new Euler(Math.PI / 2, 0, 0);
    const worker = new GenerateMeshBVHWorker();
    const tracer = new WebGLPathTracer(gl) as Tracer;
    // Each tracer draws its shader into its own float target, which three.js compiles as a different program from one
    // drawn to the canvas (no tone mapping, linear output). Compile it with that target bound, or the first sample
    // compiles it all over again, and waits for it. The low-resolution tracer draws with the full one's shader, so it
    // never compiles one of its own.
    const unused = tracer._lowResPathTracer.material;
    tracer._lowResPathTracer.material = tracer._pathTracer.material;
    unused.dispose();
    for (const pass of [tracer._pathTracer, tracer._lowResPathTracer]) {
      pass.compileMaterial = () => {
        const was = gl.getRenderTarget();
        gl.setRenderTarget(pass._primaryTarget);
        const done = gl.compileAsync(pass._fsQuad._mesh, QUAD_CAMERA);
        gl.setRenderTarget(was);
        return done;
      };
    }
    patchShader(tracer._pathTracer.material, camera);
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
  // A capture waiting on the trace, and a way to let it go when the trace cannot finish.
  const goal = useRef<{ samples: number; seconds: number; since: number; resolve: (report: TraceReport) => void; reject: (error: Error) => void } | null>(null);
  const abandon = (message: string) => {
    const waiting = goal.current;
    goal.current = null;
    waiting?.reject(new Error(message));
  };
  useEffect(() => () => {
    abandon("The ray-traced view closed before it finished tracing");
    disposeTracer(parts.tracer);
    parts.denoise.dispose();
    parts.worker.dispose();
    (parts.traced.environment as Texture | null)?.dispose();
  }, [parts]);
  // What the traced scene holds, and the camera and canvas the tracer follows: rebuilt or updated only when they change.
  const sync = useRef({ shape: "", look: "", camera: "", ready: false, building: false, stale: false });
  const clock = useRef({ traced: 0, last: 0 });
  const limit = page ? PAGE_SAMPLES : 0;
  parts.tracer.tiles.setScalar(page ? 2 : 1);
  // While the shader compiles, the Studio view.
  parts.tracer.rasterizeSceneCallback = () => gl.render(scene, camera);
  // Geometry shared with the view's surfaces, without the attributes the tracer adds to what it is given.
  const proxies = useMemo(() => new WeakMap<BufferGeometry, BufferGeometry>(), []);
  const floorGeometry = useMemo(() => new PlaneGeometry(1, 1), []);
  useEffect(() => () => floorGeometry.dispose(), [floorGeometry]);

  useEffect(() => {
    control.current = {
      settle: (limits) => new Promise((resolve, reject) => {
        abandon("A newer capture replaced this one");
        goal.current = {
          samples: limits.samples, seconds: software ? Math.min(limits.seconds, SOFTWARE_SECONDS) : limits.seconds, since: performance.now(),
          resolve: (report) => resolve({ ...report, software, renderer: name }), reject,
        };
        clock.current.traced = 0;
        invalidate();
      }),
    };
    return () => { control.current = null; };
  }, [control, name, software, invalidate]);

  function rebuild(surfaces: Mesh[]) {
    const { traced, tracer } = parts;
    traced.clear();
    traced.background = backdropLight(background, gl);
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
    }, (error: unknown) => {
      sync.current.building = false;
      abandon(`The ray-traced view could not prepare its scene: ${error instanceof Error ? error.message : String(error)}`);
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
    // A new canvas size starts the trace over too: the tracer would only resize its targets inside the next sample,
    // after this frame has decided from the old ones whether to trace.
    const view = JSON.stringify([Array.from(camera.matrixWorld.elements), Array.from(camera.projectionMatrix.elements), gl.getDrawingBufferSize(new Vector2()).toArray()]);
    if (view !== state.camera && state.ready) {
      state.camera = view;
      tracer.setCamera(camera);
    }
    const target = goal.current?.samples ?? limit;
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
