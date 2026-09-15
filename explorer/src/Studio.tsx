import { useLayoutEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import {
  Color,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  UniformsLib,
} from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js'

type Bounds = {
  min: [number, number, number]
  max: [number, number, number]
}

const ignoreRaycast = () => {}

type AreaLightTables = ReturnType<typeof RectAreaLightTexturesLib.init>
const tableKeys = ['LTC_FLOAT_1', 'LTC_FLOAT_2', 'LTC_HALF_1', 'LTC_HALF_2'] as const
const areaUniforms: typeof UniformsLib & Partial<AreaLightTables> = UniformsLib
const areaLibrary: typeof RectAreaLightTexturesLib & Partial<AreaLightTables> = RectAreaLightTexturesLib
let sharedAreaTables: { users: number; dispose: () => void } | null = null

function acquireAreaLightTables(): () => void {
  if (!sharedAreaTables) {
    if (tableKeys.every((key) => areaUniforms[key])) return () => {}
    const previousUniforms = { ...areaUniforms }
    const previousLibrary = { ...areaLibrary }
    const tables = { ...RectAreaLightTexturesLib.init() }
    for (const key of tableKeys) areaUniforms[key] = tables[key]

    // Three keeps these lookup tables globally; share ownership across mounted stages.
    sharedAreaTables = {
      users: 0,
      dispose: () => {
        for (const key of tableKeys) {
          if (areaUniforms[key] === tables[key]) {
            if (previousUniforms[key] === undefined) delete areaUniforms[key]
            else areaUniforms[key] = previousUniforms[key]
          }
          if (areaLibrary[key] === tables[key]) {
            if (previousLibrary[key] === undefined) delete areaLibrary[key]
            else areaLibrary[key] = previousLibrary[key]
          }
        }
        new Set(tableKeys.map((key) => tables[key])).forEach((texture) => texture.dispose())
      },
    }
  }

  const entry = sharedAreaTables
  entry.users += 1
  let released = false
  return () => {
    if (released) return
    released = true
    entry.users -= 1
    if (entry.users === 0) {
      entry.dispose()
      if (sharedAreaTables === entry) sharedAreaTables = null
    }
  }
}

function softboxRotation(position: [number, number, number]) {
  const light = new RectAreaLight()
  light.position.set(...position)
  light.up.set(0, 0, 1)
  light.lookAt(0, 0, 0)
  return light.quaternion
}

function createStudioEnvironment(renderer: WebGLRenderer): WebGLRenderTarget {
  const room = new Scene()
  room.background = new Color(0.15, 0.18, 0.22)
  const geometry = new PlaneGeometry(1, 1)
  const materials: MeshBasicMaterial[] = []
  const generator = new PMREMGenerator(renderer)

  const panel = (
    position: [number, number, number],
    size: [number, number],
    color: [number, number, number],
    intensity: number,
  ) => {
    const material = new MeshBasicMaterial({
      color: new Color(...color).multiplyScalar(intensity),
      side: DoubleSide,
      toneMapped: false,
    })
    materials.push(material)
    const mesh = new Mesh(geometry, material)
    mesh.position.set(...position)
    mesh.scale.set(size[0], size[1], 1)
    mesh.lookAt(0, 0, 0)
    room.add(mesh)
  }

  try {
    // These softboxes exist only in the reflection map, never in the CAD scene.
    panel([-3, -4, 6], [5, 4], [1, 0.96, 0.9], 4)
    panel([4, -1, 3], [2, 5], [0.86, 0.94, 1], 3)
    panel([0, 5, 4], [5, 3], [1, 1, 1], 5)
    panel([0, 0, 7], [4, 3], [1, 1, 1], 2.2)
    return generator.fromScene(room, 0.035, 0.1, 30, { size: 256 })
  } finally {
    generator.dispose()
    geometry.dispose()
    materials.forEach((material) => material.dispose())
    room.clear()
  }
}

/** Keep mounted across mode changes; Canvas owns shadows={enabled ? 'percentage' : false} on Three r185. */
export default function StudioStage({ bounds, enabled }: { bounds: Bounds; enabled: boolean }) {
  const { gl, scene, invalidate } = useThree()
  const environment = useRef<WebGLRenderTarget | null>(null)
  const keyLight = useRef<DirectionalLight>(null)
  const target = useMemo(() => new Object3D(), [])
  const broadPanelRotation = useMemo(() => softboxRotation([-0.9, 1.2, 1.6]), [])
  const sidePanelRotation = useMemo(() => softboxRotation([1.4, -0.8, 0.9]), [])
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
  const width = Math.max(0, bounds.max[0] - bounds.min[0])
  const depth = Math.max(0, bounds.max[1] - bounds.min[1])
  const height = Math.max(0, bounds.max[2] - bounds.min[2])
  const span = Math.max(width, depth, height, 0.001)
  const radius = Math.max(Math.hypot(width, depth, height) / 2, 0.001)
  const shadowExtent = radius * 1.7

  useLayoutEffect(acquireAreaLightTables, [])

  useLayoutEffect(() => {
    if (!enabled) return
    environment.current ??= createStudioEnvironment(gl)
    const texture = environment.current.texture
    const previousEnvironment = scene.environment
    const previousAutoUpdate = gl.shadowMap.autoUpdate

    scene.environment = texture
    gl.shadowMap.autoUpdate = true
    gl.shadowMap.needsUpdate = true
    invalidate()

    return () => {
      if (scene.environment === texture) scene.environment = previousEnvironment
      if (gl.shadowMap.autoUpdate === true) {
        gl.shadowMap.autoUpdate = previousAutoUpdate
        gl.shadowMap.needsUpdate = true
      }
      invalidate()
    }
  }, [enabled, gl, scene, invalidate])

  // Registered after state ownership so unmount restores the scene before disposing its texture.
  useLayoutEffect(() => () => {
    environment.current?.dispose()
    environment.current = null
  }, [gl])

  useLayoutEffect(() => {
    if (!enabled || !keyLight.current) return
    keyLight.current.shadow.camera.updateProjectionMatrix()
    keyLight.current.shadow.needsUpdate = true
    gl.shadowMap.needsUpdate = true
    invalidate()
  }, [enabled, shadowExtent, radius, center[0], center[1], center[2], gl, invalidate])

  if (!enabled) return null

  return (
    <group name="studio-stage" position={center}>
      <primitive object={target} dispose={null} />
      <rectAreaLight
        color="#fff8ee"
        intensity={5}
        position={[-span * 0.9, span * 1.2, span * 1.6]}
        quaternion={broadPanelRotation}
        width={span * 2.5}
        height={span * 1.6}
      />
      <rectAreaLight
        color="#e1edff"
        intensity={3}
        position={[span * 1.4, -span * 0.8, span * 0.9]}
        quaternion={sidePanelRotation}
        width={span * 1.2}
        height={span * 1.8}
      />
      <directionalLight
        ref={keyLight}
        color="#fff3e6"
        intensity={1.25}
        position={[span * 1.4, -span * 1.8, span * 2.5]}
        target={target}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-camera-near={radius * 0.05}
        shadow-camera-far={radius * 12}
        shadow-bias={-0.00005}
        shadow-normalBias={radius * 0.0005}
        shadow-radius={6}
        shadow-intensity={0.5}
      />
      <directionalLight
        color="#cbdfff"
        intensity={0.35}
        position={[-span * 1.8, -span * 0.5, span * 1.1]}
        target={target}
      />
      <directionalLight
        color="#ffffff"
        intensity={0.5}
        position={[span * 0.5, span * 1.6, span * 1.8]}
        target={target}
      />
      <mesh
        name="studio-floor"
        position={[0, 0, -height / 2 - span * 0.002]}
        scale={[span * 12, span * 12, 1]}
        receiveShadow
        raycast={ignoreRaycast}
      >
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial
          color="#26313d"
          roughness={0.92}
          metalness={0}
          envMapIntensity={0.35}
        />
      </mesh>
    </group>
  )
}
