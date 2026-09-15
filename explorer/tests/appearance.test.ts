import assert from 'node:assert/strict'
import test from 'node:test'
import { appearanceFor } from '../src/appearance.ts'
import type { MaterialFinish } from '../src/appearance.ts'

const finishes: MaterialFinish[] = ['plastic', 'satin', 'polished', 'rubber']
const unitParameters = ['roughness', 'metalness', 'clearcoat', 'clearcoatRoughness'] as const

test('appearance presets contain only bounded physical surface parameters', () => {
  for (const finish of finishes) {
    const appearance = appearanceFor(finish)
    assert.deepEqual(
      Object.keys(appearance).sort(),
      [...unitParameters, 'envMapIntensity'].sort(),
      `${finish} must not override source color, opacity, or geometry`,
    )
    for (const key of unitParameters) {
      assert.ok(Number.isFinite(appearance[key]), `${finish}.${key} is finite`)
      assert.ok(appearance[key] >= 0 && appearance[key] <= 1, `${finish}.${key} is in [0, 1]`)
    }
    assert.ok(Number.isFinite(appearance.envMapIntensity), `${finish} environment intensity is finite`)
    assert.ok(appearance.envMapIntensity >= 0 && appearance.envMapIntensity <= 2)
  }
})

test('finishes produce visibly distinct diffuse and reflective responses', () => {
  const plastic = appearanceFor('plastic')
  const satin = appearanceFor('satin')
  const polished = appearanceFor('polished')
  const rubber = appearanceFor('rubber')

  assert.equal(plastic.metalness, 0)
  assert.ok(plastic.clearcoat >= 0.15)
  assert.ok(satin.metalness >= 0.6)
  assert.ok(satin.roughness - polished.roughness >= 0.2)
  assert.ok(polished.metalness >= 0.9)
  assert.ok(polished.roughness >= 0.05 && polished.roughness <= 0.2)
  assert.equal(rubber.metalness, 0)
  assert.equal(rubber.clearcoat, 0)
  assert.ok(rubber.roughness - plastic.roughness >= 0.4)
  assert.ok(polished.envMapIntensity - rubber.envMapIntensity >= 0.5)
  assert.equal(new Set(finishes.map((finish) => JSON.stringify(appearanceFor(finish)))).size, finishes.length)
})

test('callers cannot mutate the preset used by another mesh', () => {
  for (const finish of finishes) {
    const original = appearanceFor(finish)
    const edited = appearanceFor(finish)
    assert.notStrictEqual(original, edited)
    edited.roughness = -1
    edited.metalness = -1
    edited.clearcoat = -1
    edited.clearcoatRoughness = -1
    edited.envMapIntensity = -1
    assert.deepEqual(appearanceFor(finish), original)
  }
})
