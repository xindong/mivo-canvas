// leaferStampFx — V2 stamp drop animation controller (leafer mode only).
//
// Restores the two-phase stamp landing animation that 4c left DOM-only:
//   1. pop    — sticker Rect scales 0.6 → 1.12 → 1 over 260ms with the CSS
//               `stamp-pop` cubic-bezier(0.34, 1.56, 0.64, 1) back-out overshoot
//               (App.css @keyframes stamp-pop). Opacity fades 0 → 1 across the
//               first 60% (matching the keyframes).
//   2. rays   — 8 impact-line Rects radiate from the stamp center outward +
//               fade over 420ms ease-out (App.css @keyframes stamp-impact-line).
//               Lines are Group-children SIBLINGS of the sticker so the pop
//               scale (applied to the sticker) does not deform them; destroyed
//               after 420ms.
//
// Why a controller, not a paint module: the animation is a TRANSIENT effect tied
// to placement (store.lastPlacedStampId, 520ms window — selectionSlice.noteStampPlaced),
// not to the node's persisted visual. leaferBrushStampPaint owns the stable Group +
// sticker; this module only drives the sticker + adds/removes transient ray children.
//
// D5 hard constraints:
//   - hand-written rAF driving `object.set()` — NO @leafer-in/animate dependency
//     (without that plugin UI.animate is a Plugin.need stub; verified
//     node_modules/@leafer-ui/display/src/UI.ts:511-516).
//   - never subscribes to Leafer events; never reads Leafer geometry back to the
//     store. Stamp geometry for the ray origin is read from the store (source of
//     truth), not from Leafer objects.
//   - the controller does NOT own the Group/sticker lifecycle — leaferBrushStampPaint
//     does. This module owns only: the rAF handle + the transient ray Rects.
//
// Race: lastPlacedStampId is set in the same store tick the node is created, but the
// Leafer object is materialized by the paint effect (React, after render). So the
// lookup may miss on the store-subscribe tick; we retry once on the next frame
// (after-sync) and give up with a visible warn if still absent.
//
// Cleanup: undo deleting the node mid-animation → the paint entry is disposed →
// getStampObject returns undefined (or a different sticker) → tick cancels itself +
// removes rays. Renderer unmount → dispose() cancels every rAF + removes rays.

import { Rect, type Group } from 'leafer-ui'
import { useCanvasStore } from '../store/canvasStore'
import { debugLogger } from '../store/debugLogStore'
import type { StampObjectHandle } from './leaferBrushStampPaint'

export const SOURCE = 'Leafer StampFx'

/** CSS `stamp-pop` timing-function (App.css:4001). */
const POP_BEZIER = makeCubicBezier(0.34, 1.56, 0.64, 1)
/** CSS `ease-out` keyword = cubic-bezier(0, 0, 0.58, 1) (App.css stamp-impact-line). */
const EASE_OUT = makeCubicBezier(0, 0, 0.58, 1)

const POP_DURATION_MS = 260
const IMPACT_DURATION_MS = 420
const IMPACT_LINE_COUNT = 8
const IMPACT_LINE_WIDTH = 3
const IMPACT_LINE_HEIGHT = 12
const IMPACT_LINE_COLOR = '#b3b3b3'
const IMPACT_LINE_RADIUS = 3
// CSS translateY(-70%) → -8.4px; translateY(-320%) → -38.4px (% of the 12px line).
const RAY_START_DISTANCE = IMPACT_LINE_HEIGHT * 0.7
const RAY_END_DISTANCE = IMPACT_LINE_HEIGHT * 3.2

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** cubic-bezier evaluator: given t∈[0,1] (the x axis), return the eased y. Solves
 *  the bezier x(s)=t for s via Newton-Raphson, then returns y(s). Handles the
 *  back-out control point (y1=1.56) whose y exceeds 1 mid-curve (overshoot). */
function makeCubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bezX = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s
  const bezY = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s
  const dBezX = (s: number) =>
    3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2)
  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let s = t
    for (let i = 0; i < 10; i++) {
      const x = bezX(s) - t
      if (Math.abs(x) < 1e-6) break
      const d = dBezX(s)
      if (Math.abs(d) < 1e-6) break
      s = clamp01(s - x / d)
    }
    return bezY(s)
  }
}

/** Pop scale at normalized time t∈[0,1] over POP_DURATION_MS. Mirrors the CSS
 *  stamp-pop keyframes (0%→0.6, 60%→1.12, 100%→1) with the back-out easing applied
 *  per segment (0→60% and 60→100%), so the scale overshoots past 1.12 mid-segment. */
const popScaleFor = (t: number): number => {
  if (t < 0.6) return lerp(0.6, 1.12, POP_BEZIER(t / 0.6))
  return lerp(1.12, 1, POP_BEZIER((t - 0.6) / 0.4))
}

/** Pop opacity at normalized time t. 0→1 across the first 60% (CSS keyframes), 1
 *  for the rest. Clamped — the back-out overshoot would otherwise push opacity >1. */
const popOpacityFor = (t: number): number => (t < 0.6 ? clamp01(POP_BEZIER(t / 0.6)) : 1)

/** Ray opacity at normalized time t∈[0,1] over IMPACT_DURATION_MS. CSS keyframes:
 *  0%→0, 35%→0.9, 100%→0, ease-out per segment. */
const rayOpacityFor = (t: number): number => {
  if (t < 0.35) return lerp(0, 0.9, EASE_OUT(t / 0.35))
  return lerp(0.9, 0, EASE_OUT((t - 0.35) / 0.65))
}

/** Ray distance from stamp center at normalized time t. CSS translateY -70%→-320%
 *  (single segment, ease-out). */
const rayDistanceFor = (t: number): number => lerp(RAY_START_DISTANCE, RAY_END_DISTANCE, EASE_OUT(t))

/** Ray vertical scale at normalized time t. CSS scaleY 0.3→1 (ease-out). */
const rayScaleYFor = (t: number): number => lerp(0.3, 1, EASE_OUT(t))

type ActiveFx = {
  nodeId: string
  sticker: Rect
  group: Group
  rays: Rect[]
  startTime: number
  raf: number
}

type Probe = {
  getActive: () => Array<{
    nodeId: string
    phase: 'pop' | 'impact' | 'settled'
    popProgress: number
    impactProgress: number
  }>
  getLastPlayed: () => { nodeId: string; atMs: number } | undefined
}

declare global {
  interface Window {
    __MIVO_STAMP_FX__?: Probe
  }
}

export type LeaferStampFxOptions = {
  /** Look up the stamp Group + sticker (from leaferBrushStampPaint.getStampObject). */
  getStampObject: (nodeId: string) => StampObjectHandle | undefined
  /** Injectable clock (production: performance.now). Unit tests drive this. */
  now?: () => number
  /** Injectable rAF (production: requestAnimationFrame). Unit tests drive this. */
  raf?: (cb: () => void) => number
  cancelRaf?: (handle: number) => void
}

export type LeaferStampFx = {
  dispose(): void
}

export const createLeaferStampFx = (options: LeaferStampFxOptions): LeaferStampFx => {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const raf = options.raf ?? ((cb: () => void) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(cb) : 0))
  const cancelRaf = options.cancelRaf ?? ((handle: number) => {
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(handle)
  })

  const active = new Map<string, ActiveFx>()
  let lastPlayed: { nodeId: string; atMs: number } | undefined

  const publishProbe = () => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return
    window.__MIVO_STAMP_FX__ = {
      getActive: () =>
        [...active.values()].map((entry) => {
          const elapsed = now() - entry.startTime
          const popProgress = clamp01(elapsed / POP_DURATION_MS)
          const impactProgress = clamp01(elapsed / IMPACT_DURATION_MS)
          const phase: 'pop' | 'impact' | 'settled' =
            impactProgress >= 1 ? 'settled' : popProgress >= 1 ? 'impact' : 'pop'
          return { nodeId: entry.nodeId, phase, popProgress, impactProgress }
        }),
      getLastPlayed: () => lastPlayed,
    }
  }

  const removeRays = (entry: ActiveFx) => {
    for (const ray of entry.rays) {
      try {
        ray.remove()
      } catch {
        // ray already destroyed (e.g. Group torn down by undo) — ignore.
      }
    }
    entry.rays = []
  }

  const cleanup = (nodeId: string) => {
    const entry = active.get(nodeId)
    if (!entry) return
    cancelRaf(entry.raf)
    removeRays(entry)
    active.delete(nodeId)
    publishProbe()
  }

  /** Normal end: reset the sticker to neutral (scale 1, opacity 1) + remove rays. */
  const finalize = (entry: ActiveFx) => {
    try {
      entry.sticker.set({ scaleX: 1, scaleY: 1, opacity: 1 })
    } catch {
      // sticker torn down — ignore.
    }
    removeRays(entry)
    active.delete(entry.nodeId)
    publishProbe()
  }

  const createRay = (group: Group, cx: number, cy: number, angleDeg: number): Rect => {
    const rad = angleDeg * (Math.PI / 180)
    const sinT = Math.sin(rad)
    const cosT = Math.cos(rad)
    const d = RAY_START_DISTANCE
    const lineCx = cx + d * sinT
    const lineCy = cy - d * cosT
    const ray = new Rect({
      x: lineCx - IMPACT_LINE_WIDTH / 2,
      y: lineCy - IMPACT_LINE_HEIGHT / 2,
      width: IMPACT_LINE_WIDTH,
      height: IMPACT_LINE_HEIGHT,
      fill: IMPACT_LINE_COLOR,
      cornerRadius: IMPACT_LINE_RADIUS,
      rotation: angleDeg,
      scaleY: 0.3,
      opacity: 0,
      origin: 'center',
    })
    group.add(ray)
    return ray
  }

  const updateRay = (ray: Rect, cx: number, cy: number, angleDeg: number, t: number) => {
    const rad = angleDeg * (Math.PI / 180)
    const sinT = Math.sin(rad)
    const cosT = Math.cos(rad)
    const d = rayDistanceFor(t)
    const lineCx = cx + d * sinT
    const lineCy = cy - d * cosT
    ray.set({
      x: lineCx - IMPACT_LINE_WIDTH / 2,
      y: lineCy - IMPACT_LINE_HEIGHT / 2,
      scaleY: rayScaleYFor(t),
      opacity: rayOpacityFor(t),
    })
  }

  const play = (handle: StampObjectHandle) => {
    const { nodeId, sticker, group } = handle
    // Cancel any in-flight animation on the same node first (re-placement).
    cleanup(nodeId)

    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (!node) {
      debugLogger.warn(SOURCE, `stamp fx: node ${nodeId} vanished before play — skipping`)
      return
    }
    const cx = node.x + node.width / 2
    const cy = node.y + node.height / 2

    const rays: Rect[] = []
    for (let i = 0; i < IMPACT_LINE_COUNT; i += 1) {
      rays.push(createRay(group, cx, cy, i * 45))
    }

    const startTime = now()
    lastPlayed = { nodeId, atMs: startTime }

    const entry: ActiveFx = { nodeId, sticker, group, rays, startTime, raf: 0 }
    active.set(nodeId, entry)
    publishProbe()

    const tick = () => {
      // Stale check: paint module disposed/recreated the entry (undo, kind swap,
      // or mode switch). Stop animating — the sticker reference no longer matches.
      const cur = options.getStampObject(nodeId)
      if (!cur || cur.sticker !== entry.sticker) {
        cleanup(nodeId)
        return
      }
      const elapsed = now() - startTime
      const popT = clamp01(elapsed / POP_DURATION_MS)
      const impactT = clamp01(elapsed / IMPACT_DURATION_MS)

      // Pop on the sticker (NOT the group — rays must not deform).
      try {
        const scale = popScaleFor(popT)
        sticker.set({ scaleX: scale, scaleY: scale, opacity: popOpacityFor(popT) })
      } catch {
        cleanup(nodeId)
        return
      }

      // Rays radiate + fade.
      for (let i = 0; i < entry.rays.length; i += 1) {
        updateRay(entry.rays[i], cx, cy, i * 45, impactT)
      }

      if (impactT >= 1) {
        finalize(entry)
        return
      }
      entry.raf = raf(tick)
    }
    entry.raf = raf(tick)
  }

  const tryPlay = (nodeId: string, isRetry: boolean) => {
    const handle = options.getStampObject(nodeId)
    if (handle) {
      play(handle)
      return
    }
    if (!isRetry) {
      // after-sync retry: defer to next frame so the paint effect has materialized
      // the Leafer object (lastPlacedStampId + node are set in the same store tick
      // as the node, but paint runs in a React effect after render).
      raf(() => tryPlay(nodeId, true))
    } else {
      debugLogger.warn(
        SOURCE,
        `stamp fx: object for ${nodeId} not found after sync — skipping (paint may have filtered it)`,
      )
    }
  }

  // Subscribe to lastPlacedStampId (plain store, no subscribeWithSelector — compare
  // the whole state before/after, the established pattern from useLeaferSpikeRenderer).
  const unsubscribe = useCanvasStore.subscribe((state, previousState) => {
    const cur = state.lastPlacedStampId
    const prev = previousState.lastPlacedStampId
    if (cur === prev) return
    if (!cur) return // 520ms window cleared — nothing to start.
    tryPlay(cur, false)
  })

  publishProbe()

  return {
    dispose() {
      for (const nodeId of [...active.keys()]) cleanup(nodeId)
      unsubscribe()
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        window.__MIVO_STAMP_FX__ = undefined
      }
    },
  }
}
