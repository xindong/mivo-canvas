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
//
// Edit-overlay dispatch contract (Phase 1b-3): when an edit overlay (mask/crop/
// text-edit) is active, it owns the pointer at Layer.EditOverlay (highest,
// pointer-events:auto). Overlay-INTERNAL pointer events are captured by the
// overlay DOM itself and never reach the shell. The shell only receives events
// OUTSIDE the overlay (e.g. outside-click to dismiss); resolveHitTarget returns
// an `edit-overlay-cancel` target for those so the caller can route to the
// matching cancel handler and return WITHOUT selecting/transforming nodes
// underneath. The actual cancel + return wiring lands in 1b-4 (shell dispatch);
// this module only produces the target.

import type { RenderNode } from './projection'
import { topmostHit, type HitTestEditKind, type HitTestOptions, type HitTestTarget } from './hitTest'

export type { HitTestTarget, HitTestEditKind } from './hitTest'

export type CanvasPoint = { x: number; y: number }

// Edit-state short-circuit (roadmap §8 P3-0 + README §编辑态短路). When an edit
// overlay (crop/mask/text-edit) is active, it owns the pointer at Layer.EditOverlay
// (highest); the shell does NOT hit-test. Edit overlays capture their own events
// via pointer-events:auto, so the shell only receives events OUTSIDE the overlay
// — resolveHitTarget returns `edit-overlay-cancel` so the caller can route to
// onCancelMaskEdit / cancel-crop / exit-text-edit rather than selecting a node.
export type EditState = {
  activeEditNodeId?: string
  activeEditKind?: HitTestEditKind
}

export type ResolveHitOptions = HitTestOptions & {
  editState?: EditState
}

export const isEditStateActive = (editState?: EditState): boolean =>
  Boolean(editState?.activeEditNodeId && editState?.activeEditKind)

/**
 * Resolve the topmost hit-test target at `point`. Short-circuits when an edit
 * overlay is active: returns an `edit-overlay-cancel` target (the edit overlay
 * owns the pointer; the shell should not hit-test or select/transform nodes
 * underneath). The caller routes the cancel target to the matching handler and
 * returns WITHOUT delegating to topmostHit. Otherwise delegates to topmostHit
 * (anchors first, then nodes, front-to-back).
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
  // events via pointer-events:auto; this guards shell-received events during edit,
  // e.g. outside-click.) Extract locals for TS optional narrowing, then surface a
  // cancel target the caller can route to the matching cancel handler.
  const editNodeId = options.editState?.activeEditNodeId
  const editKind = options.editState?.activeEditKind
  if (editNodeId && editKind) {
    return { kind: 'edit-overlay-cancel', nodeId: editNodeId, editKind }
  }
  return topmostHit(nodes, point, options)
}

/**
 * Shell-space → canvas-space → resolveHitTarget. Pure: takes the shell rect
 * (getBoundingClientRect), viewport (x/y/scale), back-to-front hit-test nodes,
 * and clientX/clientY. No store/canvas imports — the controller feeds params.
 *
 * Phase 1b-4: the shell dispatches pointerdown via this; useMaskPointArmed also
 * peeks it (armed image-hit → beginMaskEdit) so the per-node wrapper is gone.
 */
export type ViewportLike = { x: number; y: number; scale: number }
export type ShellRectLike = { left: number; top: number }

export const resolveCanvasHitAtClientPoint = (
  shellRect: ShellRectLike | undefined,
  viewport: ViewportLike,
  nodes: readonly RenderNode[],
  clientX: number,
  clientY: number,
  options: ResolveHitOptions = {},
): HitTestTarget | null => {
  const canvasX = (clientX - (shellRect?.left ?? 0) - viewport.x) / viewport.scale
  const canvasY = (clientY - (shellRect?.top ?? 0) - viewport.y) / viewport.scale
  return resolveHitTarget(nodes, { x: canvasX, y: canvasY }, options)
}
