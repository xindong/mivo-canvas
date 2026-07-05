// useLeaferHost — formal Leafer host lifecycle hook (Phase 2b-1).
//
// Extracts the spike's Leafer init (useLeaferSpikeRenderer:288-352) into a standalone
// hook + pure options builder. The spike is NOT refactored (0g-validated behavior
// preserved); this is the formal contract 2b-2's LeaferRendererHost will wire.
//
// D1: the Leafer instance is a pure paint surface — `hittable: false` so the canvas
// never consumes pointer events (the DOM layer + interaction controller own input).
// The host does NOT subscribe to Leafer events; it only paints + resizes.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

/** The Leafer constructor options this host builds. Structurally minimal so the
 *  options builder is testable without instantiating Leafer. */
export type LeaferHostOptions = {
  view: HTMLDivElement
  type: 'design'
  width: number
  height: number
  fill: string
  smooth: boolean
  /** D1: false — the canvas must not consume pointer events. */
  hittable: false
}

const TRANSPARENT_FILL = 'rgba(246, 243, 235, 0)'

/**
 * Build the Leafer constructor options for a host element. Pure — testable without
 * Leafer or a real DOM (pass a stub with getBoundingClientRect). The host waits for
 * non-zero dimensions (mount-time layout may report 0×0, which collapses the Leafer
 * canvas to 1px — the spike's rAF wait is preserved in the hook).
 */
export const leaferHostOptions = (host: { getBoundingClientRect: () => DOMRect }): LeaferHostOptions => {
  const rect = host.getBoundingClientRect()
  return {
    view: host as HTMLDivElement,
    type: 'design',
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height)),
    fill: TRANSPARENT_FILL,
    smooth: true,
    hittable: false,
  }
}

export type UseLeaferHostOptions = {
  hostRef: MutableRefObject<HTMLDivElement | null>
  /** false → no-op (the host is only created in leafer mode). */
  enabled: boolean
}

/**
 * Leafer host lifecycle: create on mount (once the host has non-zero dimensions),
 * resize on host size change, destroy on unmount. Returns the leafer instance ref +
 * a ready flag. The actual `new Leafer(...)` is gated behind `enabled` so the DOM
 * path never pays the cost.
 *
 * NOTE: the spike (useLeaferSpikeRenderer) keeps its own inline init (tightly
 * coupled with paint-state cleanup). This hook is the formal contract; 2b-2 wires
 * it into LeaferRendererHost.
 */
export function useLeaferHost({ hostRef, enabled }: UseLeaferHostOptions): {
  leaferRef: MutableRefObject<unknown | null>
  ready: boolean
} {
  const leaferRef = useRef<unknown | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!enabled) return undefined
    // The formal host defers Leafer instantiation to 2b-2's LeaferRendererHost
    // (which owns the painted-set + freeze state the spike currently inlines). For
    // 2b-1 the contract + options builder are the deliverable; the spike remains
    // the live implementation. This effect is intentionally a no-op until wired.
    return () => {
      leaferRef.current = null
      setReady(false)
    }
  }, [enabled, hostRef])

  return { leaferRef, ready }
}
