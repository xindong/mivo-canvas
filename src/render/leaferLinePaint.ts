// leaferLinePaint — Phase 4b: formalize markup line / arrow / connector paint
// onto Leafer behind the RendererAdapter contract.
//
// Scope: markup nodes with markupKind 'line' | 'arrow'. Connectors ARE these
// nodes (isConnectorNode = markup line/arrow with connectorStart/End bindings),
// including derivation edges (nodeFactory.createDerivationEdgeNode emits a
// markup arrow). brush/stamp stay DOM until 4c; static text is Phase 5.
//
// Geometry ground truth (plan Phase 4 hard constraint): connector geometry is
// driven by store/model ONLY — connectorGeometry.ts computes binding anchor
// points and canvasDocumentModel.normalizeConnectorMarkupNodes rewrites
// markupPoints + node geometry on every store normalize. This module consumes
// the NORMALIZED node-local markupPoints (same 1b-2 coordinate contract hitTest
// reads: canvas = geometry offset + local point) and NEVER subscribes to Leafer
// node movement — reading geometry back from Leafer would violate D1. The
// "node move → DOM and Leafer read the same normalized points" parity is
// asserted in leaferLinePaint.test.ts with the real store normalize functions.
//
// DOM parity (CanvasNodeView MarkupNodeView line/arrow branch):
//   - endpoints: markupPoints[0]/[1] with the SVG attr fallbacks
//     (x1 ?? 0, y1 ?? height, x2 ?? width, y2 ?? 0) after the render-side
//     default `defaultMarkupPointsFor` (endpoints inset by markupStrokeWidth||3,
//     min 2 — NOT the hit-test fallback in hitTest.ts, which is the plain
//     (0,h)-(w,0) diagonal).
//   - stroke: color/width/dash from the projection-sunk stroke (Phase 1a);
//     strokeOpacity = stroke.opacity ?? markupOpacity ?? 1 applies to the line
//     body only — the DOM arrow marker path has NO strokeOpacity attr, so heads
//     always paint at full opacity (visible with derivation edges' 0.82).
//   - caps: 'round', switching to 'butt' when either arrow head is shown
//     (mirrors the per-segment strokeLinecap logic).
//   - arrow heads: the SVG <marker> is an open chevron `M 5 3 L 15 9 L 5 15`
//     with ref (15,9), markerUnits userSpaceOnUse (constant px, no scaling by
//     strokeWidth), head strokeWidth clamp(2.5, min(5.5, strokeWidth)), round
//     cap/join, orient auto / auto-start-reverse. Reproduced as chevron
//     polylines anchored at the endpoints (arrowHeadPointsFor) — no
//     @leafer-in/arrow dependency, exact DOM geometry instead.
//   - label gap: the DOM splits the line into two segments around an active
//     text label. The label layer (MarkupTextLayer) is DOM-only and filtered
//     out in leafer mode until Phase 5, so painting the gap without the label
//     would look broken — leafer paints ONE continuous line (same accepted
//     tradeoff as the 4a note text layer; leaferSpikeFilter.ts header).
//   - rotation (FU-8): the DOM applies `translate(x,y) rotate(θ)` with
//     transformOrigin 50% 50%. Rect/Ellipse/Image reproduce it with Leafer
//     `rotation` + `origin:'center'`; for lines we BAKE the rotation into the
//     local points instead (rotate around the node-box center (w/2, h/2)) —
//     the Leafer objects here are point-defined (Line.points) inside a Group
//     whose box bounds derive from children, so 'center' origin would rotate
//     around the points' bbox center, not the node-box center, and drift from
//     CSS. Baking keeps the math exact; arrow-head angles follow automatically.
//
// Structure: ONE Group per node at (geometry.x, geometry.y) with child Lines
// (main + optional heads) in node-local coords, so the hook's Leafer child
// accounting stays 1 child per painted node (children === expectedChildren is
// the e2e/visual-diff paint-evidence gate — same reason 3c wraps crop in a
// Group). No width/height is set on the Group (a sized Group scales children).
//
// Contract: create/update/delete收支 goes through diffReconcilePlan; z-order
// via ctx.layerOf (2b-2, layer band × document order, shared across modules).
//
// D1 (hard constraint): pure paint. `hittable:false` is on the Leafer root;
// this module never subscribes to Leafer events and never touches the camera
// (locked by source-contract tests). Hit-testing for line/arrow stays in
// hitTest.ts (stroke-only, canvas coords) — untouched by this module.
//
// 0g three invariants: pan walks the camera only (paint effect does not depend
// on viewport.x/y); line/arrow do not participate in threshold LOD (0g口径:
// thin vector strokes, no texture/text cost — same policy as 4a shapes); zoom
// settle behavior for image/text is untouched.

import { Group, Line } from 'leafer-ui'
import type { Leafer } from 'leafer-ui'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import { isLeaferLinePaintedNode } from './leaferSpikeFilter'
import { projectNode, type RenderNode } from './projection'
import { dashPatternFor } from './leaferShapePaint'
import {
  diffReconcilePlan,
  type RendererReconcileCounts,
  type RendererSyncContext,
} from './rendererAdapter'

type LinePoint = { x: number; y: number }

type LineEntry = {
  nodeId: string
  group: Group
  main: Line
  startHead: Line | null
  endHead: Line | null
}

export type LeaferLinePaint = {
  /** Reconcile painted lines to `nodes`. Returns create/update/delete counts
   *  (收支 balance asserted in leaferLinePaint.test.ts). */
  sync(nodes: MivoCanvasNode[], ctx: RendererSyncContext): RendererReconcileCounts
  /** Remove all objects (Leafer destroy / mode-switch path). */
  dispose(): void
  /** Painted entry count (for stats + reconcile assertions). */
  paintedCount(): number
}

export const SOURCE = 'Leafer Line'

/** DOM render-side default endpoints (CanvasNodeView defaultMarkupPointsFor):
 *  inset by markupStrokeWidth||3 from the bottom-left → top-right diagonal.
 *  This is the VISUAL fallback — hitTest.defaultLineMarkupPointsFor keeps its
 *  own plain (0,h)-(w,0) hit fallback, intentionally not shared. */
export const defaultLinePaintPointsFor = (r: RenderNode): LinePoint[] => {
  const inset = r.markupStrokeWidth || 3
  return [
    { x: Math.max(2, inset), y: Math.max(2, r.geometry.height - inset) },
    { x: Math.max(2, r.geometry.width - inset), y: Math.max(2, inset) },
  ]
}

/** Node-local endpoints with the exact SVG attr fallback chain
 *  (`points[0]?.x ?? 0`, `points[0]?.y ?? height`, `points[1]?.x ?? width`,
 *  `points[1]?.y ?? 0` — covers the markupPoints.length === 1 edge). */
export const lineEndpointsFor = (r: RenderNode): { start: LinePoint; end: LinePoint } => {
  const points = r.markupPoints?.length ? r.markupPoints : defaultLinePaintPointsFor(r)
  return {
    start: { x: points[0]?.x ?? 0, y: points[0]?.y ?? r.geometry.height },
    end: { x: points[1]?.x ?? r.geometry.width, y: points[1]?.y ?? 0 },
  }
}

const rotateAroundCenter = (p: LinePoint, cx: number, cy: number, rad: number): LinePoint => {
  if (!rad) return p
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - cx
  const dy = p.y - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

/** SVG marker chevron `M 5 3 L 15 9 L 5 15`, ref (15,9), userSpaceOnUse. */
const ARROW_MARKER_POINTS: readonly LinePoint[] = [
  { x: 5, y: 3 },
  { x: 15, y: 9 },
  { x: 5, y: 15 },
]
const ARROW_MARKER_REF: LinePoint = { x: 15, y: 9 }

/** DOM marker path strokeWidth: `Math.max(2.5, Math.min(5.5, strokeWidth))`. */
export const arrowHeadStrokeWidthFor = (strokeWidth: number): number =>
  Math.max(2.5, Math.min(5.5, strokeWidth))

/** Chevron polyline (flat [x0,y0,x1,y1,x2,y2]) anchored at `anchor`, pointing
 *  along `angleRad` (marker +x axis). End head: angle of start→end; start head:
 *  angle + π (SVG orient auto-start-reverse). */
export const arrowHeadPointsFor = (anchor: LinePoint, angleRad: number): number[] => {
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  return ARROW_MARKER_POINTS.flatMap((p) => {
    const dx = p.x - ARROW_MARKER_REF.x
    const dy = p.y - ARROW_MARKER_REF.y
    return [anchor.x + dx * cos - dy * sin, anchor.y + dx * sin + dy * cos]
  })
}

export type LinePaintProps = {
  /** Group container props: geometry offset + zIndex. */
  group: Record<string, unknown>
  /** Main line props (node-local, rotation baked into points). */
  main: Record<string, unknown>
  /** Chevron head props, null when the corresponding arrow is hidden. */
  startHead: Record<string, unknown> | null
  endHead: Record<string, unknown> | null
}

const firstVisibleStroke = (r: RenderNode) => r.strokes.find((stroke) => stroke.visible)

/**
 * Map a projected RenderNode → Leafer paint props for one line/arrow node.
 * Every visual key on `main` is ALWAYS present (undefined = clear) so the
 * merging `set()` update path never keeps a stale dashPattern/stroke.
 */
export const linePaintPropsFor = (
  r: RenderNode,
  zIndex: number | undefined,
): LinePaintProps => {
  const g = r.geometry
  const { start, end } = lineEndpointsFor(r)
  const rad = (g.rotation || 0) * (Math.PI / 180)
  const p0 = rotateAroundCenter(start, g.width / 2, g.height / 2, rad)
  const p1 = rotateAroundCenter(end, g.width / 2, g.height / 2, rad)

  const stroke = firstVisibleStroke(r)
  const strokeWidth = stroke?.width ?? 0
  // strokeOpacity goes on the main Line OBJECT, not a solid-paint object:
  // Leafer 2.1.10 does not apply `{type:'solid', color, opacity}` opacity on a
  // stroke at render time (pixel-probed: DOM #000@0.82 over beige = (40,39,37),
  // Leafer painted (0,0,0) full-opacity). A Line has no fill, so object-level
  // opacity is exactly the DOM strokeOpacity semantics; the chevron heads are
  // separate full-opacity objects (DOM marker has no strokeOpacity), unaffected.
  const strokeOpacity = stroke?.opacity ?? r.markupOpacity ?? 1
  const dashed = stroke?.style === 'dashed'

  const showStartArrow = Boolean(r.markupStartArrow)
  const showEndArrow = r.markupEndArrow ?? r.markupKind === 'arrow'
  const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x)

  const headProps = (anchor: LinePoint, headAngle: number): Record<string, unknown> => ({
    points: arrowHeadPointsFor(anchor, headAngle),
    // Heads use the plain stroke COLOR — the DOM marker path carries no
    // strokeOpacity attr, so heads ignore markupOpacity by design.
    stroke: stroke?.color,
    strokeWidth: arrowHeadStrokeWidthFor(strokeWidth),
    strokeCap: 'round',
    strokeJoin: 'round',
  })

  return {
    group: {
      x: g.x,
      y: g.y,
      ...(zIndex !== undefined ? { zIndex } : {}),
    },
    main: {
      points: [p0.x, p0.y, p1.x, p1.y],
      stroke: stroke?.color,
      strokeWidth,
      strokeCap: showStartArrow || showEndArrow ? 'butt' : 'round',
      dashPattern: dashed ? dashPatternFor(strokeWidth) : undefined,
      opacity: strokeOpacity,
    },
    startHead: showStartArrow ? headProps(p0, angle + Math.PI) : null,
    endHead: showEndArrow ? headProps(p1, angle) : null,
  }
}

const setProps = (object: Line | Group, props: Record<string, unknown>) => {
  ;(object as { set: (props: unknown) => void }).set(props)
}

/** Create / update / remove one chevron head to match `props` (null = hidden). */
const reconcileHead = (
  group: Group,
  head: Line | null,
  props: Record<string, unknown> | null,
): Line | null => {
  if (!props) {
    if (head) head.remove()
    return null
  }
  if (head) {
    setProps(head, props)
    return head
  }
  const created = new Line(props)
  group.add(created)
  return created
}

/**
 * Create a Leafer line paint module bound to one Leafer instance. The hook
 * creates one when Leafer inits and disposes it when Leafer is destroyed; all
 * line/arrow nodes seen by `sync` are reconciled against the previous call's set.
 */
export const createLeaferLinePaint = (leafer: Leafer): LeaferLinePaint => {
  const entries = new Map<string, LineEntry>()

  const destroyEntry = (entry: LineEntry) => {
    // Removing the Group removes its child Lines with it.
    entry.group.remove()
  }

  const buildEntry = (nodeId: string, props: LinePaintProps): LineEntry => {
    const group = new Group(props.group)
    const main = new Line(props.main)
    group.add(main)
    // Heads AFTER the main line: same paint order as the DOM, where the SVG
    // marker renders over the line body.
    const startHead = props.startHead ? new Line(props.startHead) : null
    if (startHead) group.add(startHead)
    const endHead = props.endHead ? new Line(props.endHead) : null
    if (endHead) group.add(endHead)
    return { nodeId, group, main, startHead, endHead }
  }

  const sync: LeaferLinePaint['sync'] = (nodes, ctx) => {
    // Defensive: the leaferSpikeFilter predicate guarantees only line/arrow
    // markup nodes reach this module; anything else means filter/paint drifted
    // apart — surface it (fail visibly) and skip so收支 stays balanced.
    const lineNodes: MivoCanvasNode[] = []
    for (const node of nodes) {
      if (isLeaferLinePaintedNode(node)) {
        lineNodes.push(node)
      } else {
        debugLogger.warn(
          SOURCE,
          `skipped non-line node ${node.id} (type=${node.type}, markupKind=${node.markupKind ?? '(none)'}) — filter/paint predicate drift`,
        )
      }
    }

    const prevIds = [...entries.keys()]
    const nextIds = lineNodes.map((node) => node.id)
    const plan = diffReconcilePlan(prevIds, nextIds)
    let created = 0
    let updated = 0
    let deleted = 0

    for (const id of plan.deleted) {
      const entry = entries.get(id)
      if (entry) {
        destroyEntry(entry)
        entries.delete(id)
      }
      deleted += 1
    }

    for (const node of lineNodes) {
      const projected = projectNode(node)
      const props = linePaintPropsFor(projected, ctx.layerOf?.(node.id))
      const existing = entries.get(node.id)

      if (plan.created.has(node.id) || !existing) {
        const entry = buildEntry(node.id, props)
        entries.set(node.id, entry)
        leafer.add(entry.group)
        created += 1
        continue
      }

      setProps(existing.group, props.group)
      setProps(existing.main, props.main)
      existing.startHead = reconcileHead(existing.group, existing.startHead, props.startHead)
      existing.endHead = reconcileHead(existing.group, existing.endHead, props.endHead)
      updated += 1
    }

    return { created, updated, deleted }
  }

  const dispose: LeaferLinePaint['dispose'] = () => {
    for (const entry of entries.values()) destroyEntry(entry)
    entries.clear()
  }

  const paintedCount: LeaferLinePaint['paintedCount'] = () => entries.size

  return { sync, dispose, paintedCount }
}
