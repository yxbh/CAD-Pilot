export type MaterialFinish = 'plastic' | 'satin' | 'polished' | 'rubber'

type Appearance = {
  roughness: number
  metalness: number
  clearcoat: number
  clearcoatRoughness: number
  envMapIntensity: number
}

const presets: Record<MaterialFinish, Appearance> = {
  plastic: {
    roughness: 0.38,
    metalness: 0,
    clearcoat: 0.22,
    clearcoatRoughness: 0.28,
    envMapIntensity: 0.8,
  },
  satin: {
    roughness: 0.4,
    metalness: 0.78,
    clearcoat: 0,
    clearcoatRoughness: 0.3,
    envMapIntensity: 1,
  },
  polished: {
    roughness: 0.13,
    metalness: 0.96,
    clearcoat: 0.18,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.1,
  },
  rubber: {
    roughness: 0.92,
    metalness: 0,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.3,
  },
}

/** Cosmetic presets only; the caller retains the source color and geometry. */
export function appearanceFor(finish: MaterialFinish): Appearance {
  return { ...presets[finish] }
}
