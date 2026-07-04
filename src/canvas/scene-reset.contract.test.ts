// src/canvas/scene-reset.contract.test.ts
// P2 rev-verify guard: the scene-reset useEffect in useCanvasInteractionController
// is a centralized timing contract — one requestAnimationFrame, inside which every
// registered interaction hook's reset is called so the next scene starts clean
// (no stale viewport pan, marquee box, node/group transform, text/brush state).
//
// The reviewer's gap: a future hook that adds a reset function but forgets to wire
// it into this rAF sequence would silently leak stale state on scene switches. This
// test is the guardrail.
//
// Why a source contract (not a runtime render test): the project has no React hook
// render harness (no @testing-library/react, no jsdom/happy-dom) and the existing
// canvas tests are pure-logic. A source-text check is the lightweight guard the
// reviewer asked for; it verifies the CALL SET (which resets are invoked) without
// over-constraining order (the rAF sequence may be reordered — only the set matters).
//
// Maintenance contract: when you add an interaction hook that owns a reset function,
// you MUST (1) call that reset inside this scene-reset rAF and (2) add its name to
// EXPECTED_SCENE_RESETS below. Both directions are asserted — a reset called but not
// listed, or listed but not called, fails this test.

import { describe, expect, it } from 'vitest'
// `?raw` import (typed by vite/client) reads the controller source as a string.
// Used instead of node:fs because the frontend tsconfig only loads vite/client types.
import controllerSource from './useCanvasInteractionController.ts?raw'

// The registered hooks' reset functions that MUST be called on every scene reset.
// Source of truth: the 7 interaction hooks that own mutable interaction state
// (viewport pan/zoom, marquee selection, node transform, group transform, text
// annotation, brush stamp, zoom tool). Global canvas events (useGlobalCanvasEvents) takes the
// resets as args — it doesn't own a reset of its own. The plain setState calls
// (setSnapGuides([]), setActiveSectionDropTargetId, etc.) are not hooks and are
// not part of this contract.
const EXPECTED_SCENE_RESETS = [
  'resetViewportForScene',
  'resetMarquee',
  'resetNodeTransform',
  'resetGroupTransform',
  'resetTextAnnotation',
  'resetBrushStamp',
  'resetZoomGesture',
] as const

// Extract the scene-reset useEffect body. Located by the "Scene reset:" marker
// comment (so a rename forces a test update, not a silent skip) up to the deps
// array close `])`. The deps array is keyed on sceneId — that's what makes it the
// scene-reset effect.
const extractSceneResetEffect = (source: string): string => {
  const commentIdx = source.indexOf('// Scene reset:')
  if (commentIdx < 0) {
    throw new Error('Scene-reset marker comment not found — the effect moved or was renamed. Update this test.')
  }
  const useEffectIdx = source.indexOf('useEffect(', commentIdx)
  if (useEffectIdx < 0) {
    throw new Error('useEffect not found after the "Scene reset:" comment.')
  }
  // The callback closes with `},` then the deps array `[sceneId, ...]`. Locating by
  // this marker ties the test to the contract (scene change triggers the effect).
  const depsIdx = source.indexOf('}, [sceneId', useEffectIdx)
  if (depsIdx < 0) {
    throw new Error('Scene-reset effect deps array not found (expected `}, [sceneId, ...]`). If the deps shape changed, update this test.')
  }
  const effectEnd = source.indexOf('])', depsIdx)
  if (effectEnd < 0) {
    throw new Error('Scene-reset effect close `])` not found.')
  }
  return source.slice(useEffectIdx, effectEnd + 2)
}

describe('contract: scene-reset rAF calls every registered hook reset (rev-verify guard)', () => {
  const effectBody = extractSceneResetEffect(controllerSource)

  it('scene-reset effect uses a single requestAnimationFrame + cleanup (timing contract)', () => {
    expect(effectBody).toContain('requestAnimationFrame')
    expect(effectBody).toContain('cancelAnimationFrame')
  })

  it.each(EXPECTED_SCENE_RESETS)(
    'scene-reset rAF calls %s exactly once',
    (resetName) => {
      // Count call sites (`resetName(`) — NOT references in the deps array
      // (`resetName]` / `, resetName`). One call site per rAF run = exactly once.
      const callRegex = new RegExp(`\\b${resetName}\\(`, 'g')
      const calls = effectBody.match(callRegex) || []
      expect(
        calls.length,
        `${resetName} must be called exactly once in the scene-reset rAF (found ${calls.length}). If you added a new hook with a reset, wire it here AND add it to EXPECTED_SCENE_RESETS.`,
      ).toBe(1)
    },
  )

  it('scene-reset rAF calls no reset beyond the expected set (catches a new hook wired but not listed)', () => {
    // Match any `reset\w+(` call site in the effect, then diff against the expected set.
    const calledNames = new Set(
      [...effectBody.matchAll(/\b(reset\w+)\s*\(/g)].map((m) => m[1]),
    )
    const expected = new Set<string>([...EXPECTED_SCENE_RESETS])
    const unexpected = [...calledNames].filter((name) => !expected.has(name))
    expect(
      unexpected,
      `Unexpected reset call(s) in scene-reset rAF: ${unexpected.join(', ')}. A new hook's reset was wired but not added to EXPECTED_SCENE_RESETS — add it (or remove the call if it isn't a scene-reset).`,
    ).toEqual([])
  })

  it('EXPECTED_SCENE_RESETS has no duplicates and is non-empty', () => {
    expect(EXPECTED_SCENE_RESETS.length).toBeGreaterThan(0)
    expect(new Set(EXPECTED_SCENE_RESETS).size).toBe(EXPECTED_SCENE_RESETS.length)
  })
})
