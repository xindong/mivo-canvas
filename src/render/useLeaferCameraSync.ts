// useLeaferCameraSync — formal one-way camera sync hook (Phase 2b-1).
//
// Extracts the spike's camera-sync pattern (useLeaferSpikeRenderer:355-381) into a
// standalone, testable hook + pure helper. The spike is NOT refactored (0g-validated
// behavior preserved); this is the formal contract 2b-2's LeaferRendererHost will wire.
//
// D1 (hard constraint): the camera is ONE-WAY — React/gesture → engine
// (zoomLayer.set). This hook MUST NOT subscribe to Leafer events (`leafer.on`) or
// read zoomLayer internals to back-write the store. The D1 spy test
// (useLeaferCameraSync.test.ts) asserts `leafer.on` is never called by the sync.
//
// Directionality note (avoid misreads): the engine-spike camera bridge
// (registerEngineSpikeCamera / applyEngineSpikeCamera) is a NON-React path used
// during pan freeze — but its direction is STILL gesture→engine (the pan handler
// calls applyEngineSpikeCamera, the bridge broadcasts to registered adapters which
// call zoomLayer.set). It is NOT Leafer→store. D1 forbids the reverse.

import { useEffect, type MutableRefObject } from 'react'
import { registerEngineSpikeCamera } from './engineSpikeCameraBridge'
import type { ViewportState } from './useLeaferSpikeRenderer'

/** The Leafer surface this hook writes to. Structurally minimal so tests can pass
 *  a fake (with `on` spy for the D1 assertion) without instantiating Leafer. */
export type LeaferCameraSurface = {
  zoomLayer: {
    set: (props: { x: number; y: number; scaleX: number; scaleY: number }) => void
  }
  /** Present on real Leafer; the D1 test spies this to assert it is NEVER called. */
  on?: (...args: unknown[]) => unknown
}

/**
 * Pure camera write. Extracted from the hook so it is testable without a React
 * render harness. Null-safe: a not-yet-ready leafer is a no-op (no throw).
 */
export const applyCameraToLeafer = (
  leafer: LeaferCameraSurface | null,
  viewport: ViewportState,
): void => {
  if (!leafer) return
  leafer.zoomLayer.set({
    x: viewport.x,
    y: viewport.y,
    scaleX: viewport.scale,
    scaleY: viewport.scale,
  })
}

export type UseLeaferCameraSyncOptions = {
  /** Ref to the Leafer instance (null until mount completes). */
  leaferRef: MutableRefObject<LeaferCameraSurface | null>
  /** True once the Leafer instance is mounted + ready. */
  ready: boolean
  /** Current viewport (React commit path reads this). */
  viewport: ViewportState
  /** false → no-op (rendererMode !== 'leafer' or adapter disabled). */
  enabled: boolean
  /** true while a pan is frozen — skip zoomLayer.set so pan only walks the frozen
   *  canvas transform (0g invariant 1: pan = camera only, no React re-render). */
  isFrozen: boolean
}

/**
 * One-way camera sync. Two paths, both gesture→engine:
 *  1. React effect — viewport commit → zoomLayer.set (the normal zoom/settle path).
 *  2. Bridge registration — pan freeze期, the gesture handler calls
 *     applyEngineSpikeCamera directly (bypassing React) → this adapter's callback
 *     → zoomLayer.set. Same direction; never Leafer→store (D1).
 */
export function useLeaferCameraSync({
  leaferRef,
  ready,
  viewport,
  enabled,
  isFrozen,
}: UseLeaferCameraSyncOptions): void {
  // Destructure so the effect deps can list primitives (viewport is a new object
  // each render — listing it would re-run every commit; x/y/scale is the intent).
  const { x, y, scale } = viewport

  // React-path: viewport commit → zoomLayer.set
  useEffect(() => {
    if (!enabled || !ready || isFrozen) return
    applyCameraToLeafer(leaferRef.current, { x, y, scale })
  }, [enabled, ready, isFrozen, x, y, scale, leaferRef])

  // Bridge-path: non-React pan freeze → zoomLayer.set (gesture→engine, NOT Leafer→store)
  useEffect(() => {
    if (!enabled || !ready) return undefined
    return registerEngineSpikeCamera((nextViewport) => {
      if (isFrozen) return
      applyCameraToLeafer(leaferRef.current, nextViewport)
    })
  }, [enabled, ready, isFrozen, leaferRef])
}
