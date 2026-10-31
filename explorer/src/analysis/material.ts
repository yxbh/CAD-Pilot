// The analysis colour maps, zebra stripes and back-face colour, added to the surfaces' own physical material so
// lighting, section clipping and selection work as before. One set of uniforms per scene serves every surface.
import {
  ClampToEdgeWrapping, Color, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector2, Vector3,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { ANALYSIS_COLORS, RAMPS, rampColor, THICKNESS_SPAN, type AnalysisSettings, type AnalysisMap, type RampStops } from "../../shared/analysis.mjs";

const MAP_CODES: Record<AnalysisMap, number> = { none: 0, overhang: 1, thickness: 2, curvature: 3, zebra: 4 };
// Zebra bands per half turn of the reflected view direction.
const STRIPES = 8;
// Overhang faces this close to the lowest point along the build direction, facing straight down, rest on the plate.
const PLATE_TOLERANCE = 0.02;

function rampTexture(stops: RampStops): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * 4);
  for (let texel = 0; texel < size; texel++) data.set([...rampColor(stops, texel / (size - 1)), 255], texel * 4);
  const texture = new DataTexture(data, size, 1, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX = {
  "#include <common>": `#include <common>
#if ANALYSIS_MAP == 2 || ANALYSIS_MAP == 3
attribute float analysisValue;
varying float vAnalysisValue;
varying float vAnalysisKnown;
#endif
varying vec3 vAnalysisPosition;`,
  "#include <project_vertex>": `#include <project_vertex>
#if ANALYSIS_MAP == 2 || ANALYSIS_MAP == 3
// A vertex with no value is left out of the blend across its triangles rather than blended in as a huge number.
vAnalysisKnown = analysisValue > 1e29 ? 0.0 : 1.0;
vAnalysisValue = analysisValue * vAnalysisKnown;
#endif
vAnalysisPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
};

const FRAGMENT = {
  "#include <common>": `#include <common>
uniform sampler2D analysisRamp;
uniform vec2 analysisRange;
uniform vec3 analysisDirection;
uniform float analysisThreshold;
uniform float analysisPlate;
uniform vec3 analysisPlateColor;
uniform vec3 analysisNoValue;
uniform vec3 analysisBackface;
uniform vec3 analysisZebraLight;
uniform vec3 analysisZebraDark;
#if ANALYSIS_MAP == 2 || ANALYSIS_MAP == 3
varying float vAnalysisValue;
varying float vAnalysisKnown;
#endif
varying vec3 vAnalysisPosition;
vec3 analysisRampColor(float t) { return texture(analysisRamp, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb; }`,
  // After the shading normal is known and before lighting reads the surface colour.
  "#include <normal_fragment_maps>": `#include <normal_fragment_maps>
#if ANALYSIS_MAP == 1
{
  // The triangle's own outward normal in the world: flat and two-sided shading turn it toward the camera.
  vec3 outward = inverseTransformDirection(normal * faceDirection, viewMatrix);
  float down = -dot(outward, analysisDirection);
  float fromVertical = asin(clamp(down, -1.0, 1.0));
  if (down > 0.9998 && dot(vAnalysisPosition, analysisDirection) - analysisPlate < ${PLATE_TOLERANCE.toFixed(4)}) diffuseColor.rgb = analysisPlateColor;
  else if (fromVertical > analysisThreshold + 1e-4) diffuseColor.rgb = analysisRampColor((fromVertical - analysisThreshold) / (PI * 0.5 - analysisThreshold));
}
#elif ANALYSIS_MAP == 2 || ANALYSIS_MAP == 3
// Nearer a vertex with no value, no value; elsewhere the blend of the vertices that have one.
diffuseColor.rgb = vAnalysisKnown < 0.5 ? analysisNoValue
  : analysisRampColor((vAnalysisValue / vAnalysisKnown - analysisRange.x) / (analysisRange.y - analysisRange.x));
#endif
#ifdef ANALYSIS_BACKFACES
if (!gl_FrontFacing) diffuseColor.rgb = analysisBackface;
#endif`,
  // Reflections of parallel light strips, fixed to the view: the reflected view direction's angle about screen up.
  "#include <opaque_fragment>": `#if ANALYSIS_MAP == 4
{
  vec3 reflected = reflect(normalize(-vViewPosition), normal);
  float band = atan(reflected.x, reflected.z) / PI * ${STRIPES.toFixed(1)};
  float wave = abs(fract(band) * 2.0 - 1.0);
  float blur = clamp(fwidth(band) * 2.0, 1e-3, 0.5);
  outgoingLight = mix(analysisZebraDark, analysisZebraLight, smoothstep(0.5 - blur, 0.5 + blur, wave));
#ifdef ANALYSIS_BACKFACES
  if (!gl_FrontFacing) outgoingLight = analysisBackface;
#endif
}
#endif
#include <opaque_fragment>`,
};

const linear = (hex: string) => new Color(hex);

export class AnalysisShading {
  private readonly ramps = { overhang: rampTexture(RAMPS.overhang), thickness: rampTexture(RAMPS.thickness), curvature: rampTexture(RAMPS.curvature) };
  readonly uniforms = {
    analysisRamp: { value: this.ramps.overhang },
    analysisRange: { value: new Vector2(0, 1) },
    analysisDirection: { value: new Vector3(0, 0, 1) },
    analysisThreshold: { value: Math.PI / 4 },
    analysisPlate: { value: 0 },
    analysisPlateColor: { value: linear(ANALYSIS_COLORS.plate) },
    analysisNoValue: { value: linear(ANALYSIS_COLORS.noValue) },
    analysisBackface: { value: linear(ANALYSIS_COLORS.backface) },
    analysisZebraLight: { value: linear(ANALYSIS_COLORS.zebraLight) },
    analysisZebraDark: { value: linear(ANALYSIS_COLORS.zebraDark) },
  };

  /** plate: the lowest scene coordinate along the build direction; curvatureScale: the scale the legend shows. */
  update(analysis: AnalysisSettings, { plate = 0, curvatureScale = 1 }: { plate?: number; curvatureScale?: number }) {
    const { uniforms } = this;
    uniforms.analysisDirection.value.fromArray(analysis.buildDirection);
    uniforms.analysisThreshold.value = analysis.overhangAngle * Math.PI / 180;
    uniforms.analysisPlate.value = plate;
    if (analysis.map === "thickness") {
      uniforms.analysisRamp.value = this.ramps.thickness;
      uniforms.analysisRange.value.set(0, analysis.minimumWall * THICKNESS_SPAN);
    } else if (analysis.map === "curvature") {
      uniforms.analysisRamp.value = this.ramps.curvature;
      uniforms.analysisRange.value.set(-curvatureScale, curvatureScale);
    } else uniforms.analysisRamp.value = this.ramps.overhang;
  }

  /** The program a surface needs: its map (none until its data has arrived) and whether back faces are coloured. */
  static key(map: AnalysisMap, backfaces: boolean) {
    return `analysis:${map}:${backfaces}`;
  }

  patch(map: AnalysisMap, backfaces: boolean) {
    return (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, this.uniforms);
      const defines = `#define ANALYSIS_MAP ${MAP_CODES[map]}\n${backfaces ? "#define ANALYSIS_BACKFACES\n" : ""}`;
      shader.vertexShader = defines + Object.entries(VERTEX).reduce((code, [chunk, replacement]) => code.replace(chunk, replacement), shader.vertexShader);
      shader.fragmentShader = defines + Object.entries(FRAGMENT).reduce((code, [chunk, replacement]) => code.replace(chunk, replacement), shader.fragmentShader);
    };
  }

  dispose() {
    for (const texture of Object.values(this.ramps)) texture.dispose();
  }
}
