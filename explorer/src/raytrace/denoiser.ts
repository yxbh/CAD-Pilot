// The ray-traced view's denoiser: smooths the path tracer's noise without blurring across the parts' outlines. Adapted
// from VAULTaway's photo mode (see the README's provenance).
import {
  Color, FloatType, HalfFloatType, Matrix4, Mesh, MeshBasicMaterial, NearestFilter, OrthographicCamera, ShaderMaterial,
  WebGLRenderTarget, type Camera, type MeshStandardMaterial, type Scene, type Texture, type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

// Samples by which outlines show the trace itself (anti-aliased) rather than the filter (stepped); sooner is grainy.
const RAW_OUTLINE_SAMPLES = 128;

export type Denoise = ((target: WebGLRenderTarget, samples: number) => Texture) & { reset(): void; dispose(): void };

/**
 * An edge-avoiding à-trous filter (Dammertz et al. 2010): five passes of a 5×5 kernel at spacings of 1 to 16 px,
 * steered by normals, depth and part colours drawn with the ordinary renderer, so it smooths noise without blurring
 * across edges. Lighting is filtered with the part colours divided out, the filter eases off as samples accumulate, and
 * along outlines it hands over to the trace, whose pixels are anti-aliased.
 */
export function makeDenoiser(renderer: WebGLRenderer, scene: () => Scene, camera: () => Camera): Denoise {
  let guides: WebGLRenderTarget | null = null, albedo: WebGLRenderTarget | null = null;
  let ping: WebGLRenderTarget | null = null, pong: WebGLRenderTarget | null = null, lastSamples = Infinity;
  const albedoMaterials = new WeakMap<Mesh, MeshBasicMaterial>();
  // Front faces only: parts sit flush against each other, and back faces at the same depth would flicker through.
  const guideMaterial = new ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vPosition;
      void main() {
        vN = normalMatrix * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vPosition = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vN; varying vec3 vPosition;
      void main() {
        // View-space normal and depth (0 = background). A mesh file has no normals: its triangle's own, toward the camera.
        vec3 n = length(vN) > 0.0 ? normalize(vN) : normalize(cross(dFdx(vPosition), dFdy(vPosition)));
        gl_FragColor = vec4(n, -vPosition.z);
      }`,
  });
  const quad = new FullScreenQuad(new ShaderMaterial({
    uniforms: {
      colorTex: { value: null }, rawTex: { value: null }, gTex: { value: null }, albedoTex: { value: null },
      stepPx: { value: 1 }, first: { value: true }, last: { value: false }, sigmaL: { value: 1 }, rawOutlines: { value: 0 },
      projInv: { value: new Matrix4() }, ortho: { value: false },
    },
    vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: /* glsl */`
      uniform sampler2D colorTex, rawTex, gTex, albedoTex;
      uniform int stepPx;
      uniform bool first, last, ortho;
      uniform float sigmaL, rawOutlines;
      uniform mat4 projInv;
      const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
      // A pixel the trace gave no number (NaN or infinity, very rarely) is left out, or every pass would spread it.
      // Told by its bits: with fast math, as on Apple GPUs, isnan() and isinf() can be compiled to false.
      bool bad(vec3 c) { return any(equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u))); }
      vec3 clean(vec3 c) { return bad(c) ? vec3(0.0) : c; }
      vec3 viewPos(ivec2 p, vec2 size, float depth) {
        vec4 v = projInv * vec4((vec2(p) + 0.5) / size * 2.0 - 1.0, 1.0, 1.0);
        if (ortho) return vec3(v.xy / v.w, -depth);
        return v.xyz / -v.z * depth;
      }
      // A pixel's part colour, to divide out; none for the background.
      vec3 albedoAt(ivec2 p, float depth) { return depth <= 0.0 ? vec3(1.0) : max(texelFetch(albedoTex, p, 0).rgb, vec3(0.04)); }
      // Whether q lies on p's part: 1 on it, 0 across an outline (another colour, or a surface in front or behind).
      float onPart(vec4 g0, vec3 p0, vec3 a0, ivec2 q, vec4 g, vec3 a, vec2 size) {
        vec3 da = a - a0;
        return exp(-abs(dot(g0.xyz, viewPos(q, size, g.w) - p0)) / (0.004 * g0.w)) * exp(-dot(da, da) * 400.0);
      }
      void main() {
        ivec2 size = textureSize(colorTex, 0), p = ivec2(gl_FragCoord.xy);
        vec4 g0 = texelFetch(gTex, p, 0);
        vec3 a0 = albedoAt(p, g0.w), c0 = clean(texelFetch(colorTex, p, 0).rgb);
        if (first) c0 /= a0;
        if (g0.w <= 0.0) { gl_FragColor = vec4(last ? c0 * a0 : c0, 1.0); return; }
        vec3 p0 = viewPos(p, vec2(size), g0.w);
        float l0 = dot(c0, LUM);
        const float K[3] = float[3](0.375, 0.25, 0.0625);
        vec3 sum = vec3(0.0); float wsum = 0.0;
        for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
          ivec2 q = clamp(p + ivec2(dx, dy) * stepPx, ivec2(0), size - 1);
          vec4 g = texelFetch(gTex, q, 0);
          if (g.w <= 0.0) continue;
          vec3 a = albedoAt(q, g.w), c = texelFetch(colorTex, q, 0).rgb;
          if (bad(c)) continue;
          if (first) c /= a;
          float l = dot(c, LUM);
          float w = K[abs(dx)] * K[abs(dy)] * onPart(g0, p0, a0, q, g, a, vec2(size))
            * pow(max(dot(g0.xyz, g.xyz), 0.0), 32.0)
            * exp(-abs(l - l0) / (sigmaL * 0.5 * (l + l0) + 1e-3));
          sum += c * w; wsum += w;
        }
        vec3 c = wsum > 0.0 ? sum / wsum : vec3(0.0);
        if (!last) { gl_FragColor = vec4(c, 1.0); return; }
        // Guides are drawn a sample a pixel, so filtered outlines come out in steps; there the trace's own anti-aliased
        // pixels take over as samples build up.
        float outline = 0.0;
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
          ivec2 q = clamp(p + ivec2(dx, dy), ivec2(0), size - 1);
          vec4 g = texelFetch(gTex, q, 0);
          outline = max(outline, g.w <= 0.0 ? 1.0 : 1.0 - smoothstep(0.1, 0.5, onPart(g0, p0, a0, q, g, albedoAt(q, g.w), vec2(size))));
        }
        vec3 raw = clean(texelFetch(rawTex, p, 0).rgb);
        gl_FragColor = vec4(mix(c * a0, raw, outline * rawOutlines), 1.0);
      }`,
  }));
  const uniforms = (quad.material as ShaderMaterial).uniforms;
  let valid = false;

  function targets(width: number, height: number) {
    if (ping && ping.width === width && ping.height === height) return false;
    for (const target of [guides, albedo, ping, pong]) target?.dispose();
    const options = { minFilter: NearestFilter, magFilter: NearestFilter };
    guides = new WebGLRenderTarget(width, height, { ...options, type: FloatType });
    albedo = new WebGLRenderTarget(width, height, { ...options, type: HalfFloatType });
    ping = new WebGLRenderTarget(width, height, { ...options, type: HalfFloatType, depthBuffer: false });
    pong = new WebGLRenderTarget(width, height, { ...options, type: HalfFloatType, depthBuffer: false });
    return true;
  }
  // Normals and depth, then part colours, drawn from the traced camera.
  function renderGuides() {
    const traced = scene(), view = camera();
    const background = traced.background, clear = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
    traced.background = null;
    renderer.setClearColor(0x000000, 0);
    traced.overrideMaterial = guideMaterial;
    renderer.setRenderTarget(guides);
    renderer.clear();
    renderer.render(traced, view);
    traced.overrideMaterial = null;
    const swapped: [Mesh, Mesh["material"]][] = [];
    traced.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      let material = albedoMaterials.get(object);
      if (!material) albedoMaterials.set(object, material = new MeshBasicMaterial());
      material.color.copy((object.material as MeshStandardMaterial).color);
      swapped.push([object, object.material]);
      object.material = material;
    });
    renderer.setRenderTarget(albedo);
    renderer.clear();
    renderer.render(traced, view);
    for (const [object, material] of swapped) object.material = material;
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    traced.background = background;
  }

  return Object.assign((target: WebGLRenderTarget, samples: number): Texture => {
    // Samples only grow between draws, so no growth means the tracer started over: the camera or the scene changed.
    if (targets(target.width, target.height) || samples <= lastSamples || !valid) renderGuides();
    lastSamples = samples;
    const view = camera();
    uniforms.gTex.value = guides!.texture;
    uniforms.albedoTex.value = albedo!.texture;
    uniforms.projInv.value.copy(view.projectionMatrixInverse);
    uniforms.ortho.value = view instanceof OrthographicCamera;
    uniforms.rawTex.value = target.texture;
    uniforms.rawOutlines.value = Math.min(1, samples / RAW_OUTLINE_SAMPLES);
    const was = renderer.getRenderTarget();
    for (let pass = 0; pass < 5; pass++) {
      uniforms.colorTex.value = pass === 0 ? target.texture : (pass % 2 ? ping! : pong!).texture;
      uniforms.stepPx.value = 1 << pass;
      uniforms.first.value = pass === 0;
      uniforms.last.value = pass === 4;
      uniforms.sigmaL.value = Math.min(1.5, 3 / Math.sqrt(Math.max(1, samples))) * 0.6 ** pass;
      renderer.setRenderTarget(pass % 2 ? pong : ping);
      quad.render(renderer);
    }
    renderer.setRenderTarget(was);
    valid = true;
    return ping!.texture;
  }, {
    reset() { valid = false; lastSamples = Infinity; },
    dispose() {
      for (const target of [guides, albedo, ping, pong]) target?.dispose();
      guideMaterial.dispose();
      quad.material.dispose();
      quad.dispose();
    },
  });
}
