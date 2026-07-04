// hitTest — pure hit-test primitives (P3-0a, roadmap §8 P3-0).
//
// These are the canonical hit-test functions P3-0b's InteractionAdapter will
// call. P3-0a provides the functions + unit tests; NO wiring into the controller
// (that is P3-0b, after B2 interaction hooks land).
//
// Contract: caller passes `nodes` in BACK-TO-FRONT z-order (so we reverse for
// front-to-back iteration). Use `sortForHitTest` for the default ordering
// (frame < content < selected-elevated). Anchor marks live in the FloatingUI
// layer (above all content), so topmostHit checks anchors first, then nodes.
//
// D2 (docs/decisions/anchor-mvp-paradigm-notes.md §2): anchor selection is a
// FIRST-CLASS interaction state — clicking an anchor mark selects the anchor,
// not the underlying node. Hence the two-pass order.
//
// Coordinate convention: all points passed to these functions are in CANVAS
// space (screenToCanvas applied by the caller before calling). node.geometry
// is canvas-space; markupPoints are NODE-LOCAL (relative to geometry.x/y,
// matching the DOM SVG which renders inside the node's positioned container).
// markupPointsToCanvas applies the geometry offset before stroke hit-testing;
// it does NOT rotate (markup line/arrow nodes are not independently rotated).
// Phase 1b-2 (this file) keeps markupPoints local so persistence/useTextAnnotation/
// CanvasNodeView SVG stay untouched; the hit layer converts internally.

import type { RenderAnchor, RenderNode } from './projection'

export type CanvasPoint = { x: number; y: number }

/** Active edit-overlay kind. When an edit overlay is active, the shell short-circuits
 * hit-testing and returns an `edit-overlay-cancel` target so the caller can route to
 * the matching cancel handler (onCancelMaskEdit / cancel-crop / exit-text-edit). */
export type HitTestEditKind = 'mask' | 'crop' | 'text-edit'

export type HitTestTarget =
  | { kind: 'anchor'; nodeId: string; anchorId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'edit-overlay-cancel'; nodeId: string; editKind: HitTestEditKind }

export type HitTestOptions = {
  /** Canvas-space radius for point-anchor hit (default 8). */
  anchorHitRadius?: number
  /** Canvas-space tolerance for stroke/connector hit (default 6). */
  strokeHitTolerance?: number
  /** Skip locked nodes entirely (default false — locked nodes remain selectable
   * so the user can select+unlock; transform tools gate separately). */
  skipLocked?: boolean
}

const DEFAULT_ANCHOR_RADIUS = 8
const DEFAULT_STROKE_TOLERANCE = 6

// --- primitives --------------------------------------------------------------

export const pointInRect = (
  rect: { x: number; y: number; width: number; height: number },
  point: CanvasPoint,
): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height

const rotate = (angleRad: number, p: CanvasPoint): CanvasPoint => ({
  x: p.x * Math.cos(angleRad) - p.y * Math.sin(angleRad),
  y: p.x * Math.sin(angleRad) + p.y * Math.cos(angleRad),
})

// Hit-test a (possibly rotated) rect. Rotation is around the rect center
// (matches CSS transformOrigin: 50% 50% in canvasRenderAdapter).
export const pointInRotatedRect = (
  geometry: { x: number; y: number; width: number; height: number; rotation: number },
  point: CanvasPoint,
): boolean => {
  if (!geometry.rotation) return pointInRect(geometry, point)
  const cx = geometry.x + geometry.width / 2
  const cy = geometry.y + geometry.height / 2
  const local = { x: point.x - cx, y: point.y - cy }
  const rotated = rotate(-geometry.rotation * (Math.PI / 180), local)
  return Math.abs(rotated.x) <= geometry.width / 2 && Math.abs(rotated.y) <= geometry.height / 2
}

const distToSegment = (p: CanvasPoint, a: CanvasPoint, b: CanvasPoint): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export const distToPolyline = (p: CanvasPoint, points: CanvasPoint[]): number => {
  if (points.length === 0) return Infinity
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y)
  let min = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(p, points[i], points[i + 1])
    if (d < min) min = d
  }
  return min
}

// --- node hit ----------------------------------------------------------------

/**
 * Convert node-local markupPoints to canvas coords by adding geometry offset.
 * Phase 1b-2: markupPoints stay local in persistence/SVG; the hit layer
 * converts internally so callers keep passing canvas-space points.
 * Rotation is not applied (markup line/arrow nodes are not independently rotated).
 */
export const markupPointsToCanvas = (
  node: RenderNode,
  points: readonly CanvasPoint[],
): CanvasPoint[] =>
  points.map((p) => ({ x: node.geometry.x + p.x, y: node.geometry.y + p.y }))

/**
 * Default line/arrow endpoints when markupPoints is absent, matching the DOM
 * .markup-hit-line fallback (x1=0, y1=height, x2=width, y2=0 — bottom-left to
 * top-right). Returns node-local points; callers canvas-ize via markupPointsToCanvas.
 */
export const defaultLineMarkupPointsFor = (node: RenderNode): CanvasPoint[] => [
  { x: 0, y: node.geometry.height },
  { x: node.geometry.width, y: 0 },
]

/**
 * Stroke hit tolerance for line/arrow, aligning with the DOM .markup-hit-line
 * element whose strokeWidth is max(14, markupStrokeWidth + 10) with round caps
 * (effective hit radius = strokeWidth / 2). `fallback` is the caller-supplied
 * generic stroke tolerance; we take the max so thin lines stay grabbable.
 */
const lineHitTolerance = (fallback: number, strokeWidth: number): number =>
  Math.max(fallback, Math.max(14, strokeWidth + 10) / 2)

/** Bounds hit (rotated rect) for any node. */
export const pointInNodeBounds = (node: RenderNode, point: CanvasPoint): boolean =>
  pointInRotatedRect(node.geometry, point)

/**
 * Stroke hit for thin markup (line/arrow/brush/rect-border). Returns true if the
 * point is within `tolerance` of the stroke path. For rect, hits the border only
 * (not the interior — interior is covered by pointInNodeBounds). For ellipse /
 * note / stamp, returns false (bounds hit in pointInNode suffices).
 *
 * Phase 1b-2: markupPoints are node-local; line/arrow/brush convert to canvas
 * coords here. line/arrow tolerance aligns with DOM .markup-hit-line.
 */
export const pointInMarkupStroke = (
  node: RenderNode,
  point: CanvasPoint,
  tolerance: number,
): boolean => {
  if (!node.markupKind) return false
  const g = node.geometry

  switch (node.markupKind) {
    case 'line':
    case 'arrow': {
      const local =
        node.markupPoints && node.markupPoints.length >= 2
          ? node.markupPoints
          : defaultLineMarkupPointsFor(node)
      const pts = markupPointsToCanvas(node, local)
      const tol = lineHitTolerance(tolerance, node.markupStrokeWidth ?? 0)
      return distToSegment(point, pts[0], pts[1]) <= tol
    }
    case 'brush': {
      if (!node.markupPoints || node.markupPoints.length < 2) return false
      const pts = markupPointsToCanvas(node, node.markupPoints)
      return distToPolyline(point, pts) <= tolerance
    }
    case 'rect': {
      // Border hit: 4 edges of the geometry rect.
      const tl = { x: g.x, y: g.y }
      const tr = { x: g.x + g.width, y: g.y }
      const br = { x: g.x + g.width, y: g.y + g.height }
      const bl = { x: g.x, y: g.y + g.height }
      return (
        distToSegment(point, tl, tr) <= tolerance ||
        distToSegment(point, tr, br) <= tolerance ||
        distToSegment(point, br, bl) <= tolerance ||
        distToSegment(point, bl, tl) <= tolerance
      )
    }
    case 'ellipse':
    case 'note':
    case 'stamp':
      return false
    default:
      return false
  }
}

/**
 * True if the point hits the node. line/arrow are STROKE-ONLY (a click inside
 * the line's bounding rect but off the stroke falls through to nodes below —
 * matches FigJam line semantics). rect/ellipse/note/stamp hit by bounds (rect
 * border also stroke-toleranced); brush hits by bounds OR stroke (filled path
 * covers the bbox interior; stroke covers the polyline sweep).
 */
export const pointInNode = (node: RenderNode, point: CanvasPoint, tolerance: number): boolean => {
  if (node.markupKind === 'line' || node.markupKind === 'arrow') {
    return pointInMarkupStroke(node, point, tolerance)
  }
  return pointInNodeBounds(node, point) || pointInMarkupStroke(node, point, tolerance)
}

// --- anchor hit --------------------------------------------------------------

export const pointInAnchor = (anchor: RenderAnchor, point: CanvasPoint, radius: number): boolean => {
  if (anchor.type === 'point') return Math.hypot(point.x - anchor.x, point.y - anchor.y) <= radius
  // box: point-in-rect (box anchor geometry is the box itself)
  return point.x >= anchor.x && point.x <= anchor.x + (anchor.width ?? 0) && point.y >= anchor.y && point.y <= anchor.y + (anchor.height ?? 0)
}

// --- z-order -----------------------------------------------------------------

// Default back-to-front comparator: frame < content < selected. P3-0b may replace
// with a richer comparator (e.g. explicit DOM order / Layer assignment).
export const defaultZOrderCompare = (a: RenderNode, b: RenderNode): number => {
  const rank = (n: RenderNode): number => {
    if (n.type === 'frame') return 0 // Frame layer (bottom)
    if (n.selected) return 2 // SelectedElevated
    return 1 // Content
  }
  return rank(a) - rank(b)
}

/** Return a back-to-front copy using defaultZOrderCompare (stable). */
export const sortForHitTest = (nodes: readonly RenderNode[]): RenderNode[] =>
  [...nodes].sort(defaultZOrderCompare)

// --- topmost hit (two-pass: anchors then nodes) ------------------------------

const isHittable = (node: RenderNode, skipLocked: boolean): boolean =>
  !node.hidden && (!skipLocked || !node.locked)

/**
 * Find the topmost target at `point`. Pass `nodes` in BACK-TO-FRONT z-order.
 * Anchors are checked first (FloatingUI layer, above all content); then nodes
 * (Content/Frame layer, front-to-back). Returns null if nothing is hit.
 */
export const topmostHit = (
  nodes: readonly RenderNode[],
  point: CanvasPoint,
  options: HitTestOptions = {},
): HitTestTarget | null => {
  const anchorRadius = options.anchorHitRadius ?? DEFAULT_ANCHOR_RADIUS
  const strokeTolerance = options.strokeHitTolerance ?? DEFAULT_STROKE_TOLERANCE
  const skipLocked = options.skipLocked ?? false

  // Front-to-back iteration.
  const ordered = [...nodes].reverse()

  // Pass 1: anchors (above all content).
  for (const node of ordered) {
    if (!isHittable(node, skipLocked)) continue
    if (!node.anchors) continue
    for (const anchor of node.anchors) {
      if (pointInAnchor(anchor, point, anchorRadius)) {
        return { kind: 'anchor', nodeId: node.id, anchorId: anchor.id }
      }
    }
  }

  // Pass 2: nodes (bounds + stroke).
  for (const node of ordered) {
    if (!isHittable(node, skipLocked)) continue
    if (pointInNode(node, point, strokeTolerance)) {
      return { kind: 'node', nodeId: node.id }
    }
  }

  return null
}

/** Convenience: topmost NODE hit only (ignores anchors). */
export const topmostNodeHit = (
  nodes: readonly RenderNode[],
  point: CanvasPoint,
  options: HitTestOptions = {},
): HitTestTarget | null => {
  const strokeTolerance = options.strokeHitTolerance ?? DEFAULT_STROKE_TOLERANCE
  const skipLocked = options.skipLocked ?? false
  for (const node of [...nodes].reverse()) {
    if (!isHittable(node, skipLocked)) continue
    if (pointInNode(node, point, strokeTolerance)) return { kind: 'node', nodeId: node.id }
  }
  return null
}

/** Convenience: topmost ANCHOR hit only (ignores node bodies). */
export const topmostAnchorHit = (
  nodes: readonly RenderNode[],
  point: CanvasPoint,
  options: HitTestOptions = {},
): HitTestTarget | null => {
  const anchorRadius = options.anchorHitRadius ?? DEFAULT_ANCHOR_RADIUS
  const skipLocked = options.skipLocked ?? false
  for (const node of [...nodes].reverse()) {
    if (!isHittable(node, skipLocked)) continue
    if (!node.anchors) continue
    for (const anchor of node.anchors) {
      if (pointInAnchor(anchor, point, anchorRadius)) {
        return { kind: 'anchor', nodeId: node.id, anchorId: anchor.id }
      }
    }
  }
  return null
}
