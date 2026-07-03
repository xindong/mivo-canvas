// interactionAdapter — canonical shell pointer dispatch (P3-0b, SC6.1 完整达成).
//
// Owns the "唯一交互分发模型" contract (roadmap §8 P3-0): shell captures pointer
// → viewportMatrix.screenToCanvas → resolveHitTarget (topmostHit + edit-state
// short-circuit) → route to existing interaction hooks (B2's
// useNodeTransform/useMarqueeSelection/etc.).
//
// P3-0b wires this into useCanvasInteractionController.handleCanvasPointerDown
// (replacing the DOM-based `.dom-node` skip + per-node onPointerDown). The
// per-hook move/end dispatch (handleCanvasPointerMove/End fanning out to
// tryMove* hooks) is unchanged — only the pointer-DOWN hit-test entry changes.
//
// Behavior preservation: topmostHit reproduces the DOM dispatch for axis-aligned
// nodes (pointInRect) and rotated nodes (pointInRotatedRect). The documented
// difference is stroke tolerance for markup line/brush (topmostHit uses a 6-unit
// canvas tolerance vs SVG pointer-events:stroke width) — easier to hit thin
// strokes, framed as a correction (was too hard to click), not a regression.

import type { RenderNode } from './projection'
import { topmostHit, type HitTestOptions, type HitTestTarget } from './hitTest'

export type { HitTestTarget } from './hitTest'

export type CanvasPoint = { x: number; y: number }

// Edit-state short-circuit (roadmap §8 P3-0 + README §编辑态短路). When an edit
// overlay (crop/mask/text-edit) is active, it owns the pointer at Layer.EditOverlay
// (highest); the shell does NOT hit-test. Edit overlays capture their own events
// via pointer-events:auto, so the shell only receives events OUTSIDE the overlay
// — resolveHitTarget returns 'edit-overlay-cancel' so the caller can route to
// onCancelMaskEdit / cancel-crop rather than selecting a different node.
export type EditState = {
  activeEditNodeId?: string
  activeEditKind?: 'mask' | 'crop' | 'text-edit'
}

export type ResolveHitOptions = HitTestOptions & {
  editState?: EditState
}

export const isEditStateActive = (editState?: EditState): boolean =>
  Boolean(editState?.activeEditNodeId && editState?.activeEditKind)

/**
 * Resolve the topmost hit-test target at `point`. Short-circuits when an edit
 * overlay is active (returns null — the shell should not hit-test; the edit
 * overlay owns the pointer). Otherwise delegates to topmostHit (anchors first,
 * then nodes, front-to-back).
 *
 * Callers pass `nodes` in BACK-TO-FRONT z-order (use sortForHitTest for the
 * default frame < content < selected ordering).
 */
export const resolveHitTarget = (
  nodes: readonly RenderNode[],
  point: CanvasPoint,
  options: ResolveHitOptions = {},
): HitTestTarget | null => {
  // Edit-state short-circuit: the edit overlay has pointer priority; the shell
  // does not select/transform nodes underneath. (Edit overlays capture their own
  // events; this guards shell-received events during edit, e.g. outside-click.)
  if (isEditStateActive(options.editState)) return null
  return topmostHit(nodes, point, options)
}
