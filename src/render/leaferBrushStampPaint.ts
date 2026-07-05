// leaferBrushStampPaint — Phase 4c: formalize markup brush (marker/highlighter
// freehand strokes) + stamp (SVG sticker) paint onto Leafer behind the
// RendererAdapter contract. This is the LAST Phase 4 paint set — after 4c the
// leafer mode paints image/frame/rect/ellipse/note/line/arrow/brush/stamp and
// only text-ish nodes (Phase 5 spike) remain DOM.
//
// DOM parity (CanvasNodeView MarkupNodeView brush/stamp branches):
//   - brush solid (marker/highlighter): the DOM paints a FILLED
//     perfect-freehand outline `<path d=brushOutlinePathFor(...) fill=stroke
//     fillOpacity=strokeOpacity stroke=none>`. Leafer consumes the SAME
//     brushGeometry.brushOutlinePathFor output as a Path `path` string (Leafer
//     parses SVG path data), fill = stroke color. A brush Path has no separate
//     stroke paint, so OBJECT-level opacity is exactly the DOM fillOpacity
//     semantics (same reasoning as the 4b Line fix; NOT the FU-10 shape case,
//     which has fill + stroke on one object).
//   - brush dashed: filled outlines cannot express dashes — the DOM keeps the
//     legacy polyline (`<polyline stroke=... strokeWidth=RAW width (not
//     brushRenderWidthFor) strokeOpacity dasharray w*2.2/w*1.6 round caps>`).
//     Leafer mirrors it with a points-Line + dashPattern + object opacity.
//   - default points: nodes without markupPoints fall back to the render-side
//     brush wave (CanvasNodeView defaultMarkupPointsFor brush branch:
//     (8,h*.6)(w*.32,h*.25)(w*.56,h*.68)(w-8,h*.3)) — kept here verbatim.
//   - stamp: the DOM renders `<img src=stampSrcFor(kind)>` with
//     object-fit:contain + drop-shadow(0 3px 6px rgba(0,0,0,0.22))
//     (.dom-markup-stamp-svg). Leafer paints a Rect with an image fill
//     `mode:'fit'` (= contain; Leafer's Image element defaults to 'stretch',
//     so we set the fill paint explicitly) + the same shadow numbers.
//   - rotation (FU-8): brush follows the 4b line approach — geometry.rotation
//     is BAKED into the local points (rotate around the node-box center
//     (w/2,h/2), pressure preserved) because point/path-defined Leafer objects
//     compute bounds from their data, so `origin:'center'` would rotate around
//     the data bbox center and drift from CSS. perfect-freehand's outline is
//     rotation-equivariant (isotropic round pen), so outline(rotate(points)) ==
//     rotate(outline(points)). Stamp is a box-defined Rect → Leafer `rotation`
//     + `origin:'center'` (same as 4a shapes / 3c images).
//
// Known 4c tradeoff (documented in leaferSpikeFilter.ts): the stamp
// just-placed pop animation + impact rays are DOM-only transient effects and
// do not replay in leafer mode; the in-progress brush preview is a MivoCanvas
// overlay (not a node) and stays DOM in both modes.
//
// Contract: create/update/delete 收支 goes through diffReconcilePlan; z-order
// via ctx.layerOf (2b-2, layer band × document order, shared across modules).
// One TOP-LEVEL Leafer object per node (children === expectedChildren is the
// e2e/visual-diff paint-evidence gate).
//
// D1 (hard constraint): pure paint. `hittable:false` is on the Leafer root;
// this module never subscribes to Leafer events and never touches the camera
// (locked by source-contract tests). Brush hit-testing stays in
// hitTest.ts/brushGeometry (canvas coords) — untouched.
//
// 0g three invariants: pan walks the camera only (paint effect does not depend
// on viewport.x/y); brush/stamp do not participate in threshold LOD (0g 口径:
// vector strokes / tiny SVG stickers, no bitmap decode cost at scale — same
// policy as 4a/4b); zoom settle behavior for image/text is untouched.

import { Line, Path, Rect } from 'leafer-ui'
import type { Leafer } from 'leafer-ui'
import type { MarkupPoint, MivoCanvasNode } from '../types/mivoCanvas'
import { brushOutlinePathFor } from '../canvas/brushGeometry'
import { stampSrcFor } from '../canvas/stampDefs'
import { debugLogger } from '../store/debugLogStore'
import { isLeaferBrushStampPaintedNode } from './leaferSpikeFilter'
import { projectNode, type RenderNode } from './projection'
import { dashPatternFor } from './leaferShapePaint'
import {
  diffReconcilePlan,
  type RendererReconcileCounts,
  type RendererSyncContext,
} from './rendererAdapter'

type BrushStampObject = Path | Line | Rect
type BrushStampEntryKind = 'brush-path' | 'brush-polyline' | 'stamp'

type BrushStampEntry = {
  nodeId: string
  object: BrushStampObject
  kind: BrushStampEntryKind
}

export type LeaferBrushStampPaint = {
  /** Reconcile painted brush/stamp nodes to `nodes`. Returns create/update/
   *  delete counts (收支 balance asserted in leaferBrushStampPaint.test.ts). */
  sync(nodes: MivoCanvasNode[], ctx: RendererSyncContext): RendererReconcileCounts
  /** Remove all objects (Leafer destroy / mode-switch path). */
  dispose(): void
  /** Painted entry count (for stats + reconcile assertions). */
  paintedCount(): number
}

export const SOURCE = 'Leafer BrushStamp'

/** .dom-markup-stamp-svg img drop-shadow(0 3px 6px rgba(0,0,0,0.22)) (App.css). */
export const STAMP_SHADOW = { x: 0, y: 3, blur: 6, color: 'rgba(0, 0, 0, 0.22)' }

const clampDim = (value: number) => Math.max(1, value)

const firstVisibleStroke = (r: RenderNode) => r.strokes.find((stroke) => stroke.visible)

/** DOM render-side default brush wave (CanvasNodeView defaultMarkupPointsFor
 *  brush branch) — the VISUAL fallback for strokes without markupPoints. */
export const defaultBrushPaintPointsFor = (r: RenderNode): MarkupPoint[] => {
  const { width, height } = r.geometry
  return [
    { x: 8, y: height * 0.6 },
    { x: width * 0.32, y: height * 0.25 },
    { x: width * 0.56, y: height * 0.68 },
    { x: width - 8, y: height * 0.3 },
  ]
}

/** Node-local brush points with FU-8 rotation baked in (rotate around the
 *  node-box center, pressure preserved — see header). */
export const brushLocalPointsFor = (r: RenderNode): MarkupPoint[] => {
  const points = r.markupPoints?.length ? r.markupPoints : defaultBrushPaintPointsFor(r)
  const rad = (r.geometry.rotation || 0) * (Math.PI / 180)
  if (!rad) return points
  const cx = r.geometry.width / 2
  const cy = r.geometry.height / 2
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return points.map((point) => ({
    x: cx + (point.x - cx) * cos - (point.y - cy) * sin,
    y: cy + (point.x - cx) * sin + (point.y - cy) * cos,
    ...(point.pressure !== undefined ? { pressure: point.pressure } : {}),
  }))
}

export type BrushStampPaintPlan = {
  kind: BrushStampEntryKind
  props: Record<string, unknown>
}

/**
 * Map a projected RenderNode → Leafer paint plan (object kind + props) for one
 * brush/stamp node. Every visual key is ALWAYS present within a kind
 * (undefined = clear) so the merging `set()` update path never keeps a stale
 * value; dashed↔solid and brush↔stamp change the KIND and recreate instead.
 */
export const brushStampPaintPlanFor = (
  r: RenderNode,
  zIndex: number | undefined,
): BrushStampPaintPlan => {
  const g = r.geometry
  const zProps = zIndex !== undefined ? { zIndex } : {}

  if (r.markupKind === 'stamp') {
    return {
      kind: 'stamp',
      props: {
        x: g.x,
        y: g.y,
        width: clampDim(g.width),
        height: clampDim(g.height),
        // Image element defaults to mode:'stretch' — set the fill paint
        // explicitly for object-fit:contain parity ('fit').
        fill: { type: 'image', url: stampSrcFor(r.markupStampKind), mode: 'fit' },
        shadow: { ...STAMP_SHADOW },
        rotation: g.rotation || 0,
        origin: 'center',
        ...zProps,
      },
    }
  }

  const stroke = firstVisibleStroke(r)
  const strokeWidth = stroke?.width ?? 0
  const strokeOpacity = stroke?.opacity ?? r.markupOpacity ?? 1
  const points = brushLocalPointsFor(r)

  if (stroke?.style === 'dashed') {
    // Filled freehand outlines cannot express dashes; the DOM keeps the legacy
    // polyline for dashed brushes — mirror it (RAW strokeWidth, round caps).
    return {
      kind: 'brush-polyline',
      props: {
        x: g.x,
        y: g.y,
        points: points.flatMap((point) => [point.x, point.y]),
        stroke: stroke.color,
        strokeWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        dashPattern: dashPatternFor(strokeWidth),
        opacity: strokeOpacity,
        ...zProps,
      },
    }
  }

  return {
    kind: 'brush-path',
    props: {
      x: g.x,
      y: g.y,
      // Same outline the DOM <path d=...> renders — brushGeometry is the single
      // source (perfect-freehand outline + quadratic midpoint smoothing).
      path: brushOutlinePathFor(points, strokeWidth, r.markupBrushKind || 'marker'),
      fill: stroke?.color,
      // Object-level opacity == DOM fillOpacity (a brush Path has no stroke).
      opacity: strokeOpacity,
      ...zProps,
    },
  }
}

const createBrushStampObject = (plan: BrushStampPaintPlan): BrushStampObject =>
  plan.kind === 'stamp' ? new Rect(plan.props) : plan.kind === 'brush-polyline' ? new Line(plan.props) : new Path(plan.props)

const setProps = (object: BrushStampObject, props: Record<string, unknown>) => {
  ;(object as { set: (props: unknown) => void }).set(props)
}

/**
 * Create a Leafer brush/stamp paint module bound to one Leafer instance. The
 * hook creates one when Leafer inits and disposes it when Leafer is destroyed;
 * all brush/stamp nodes seen by `sync` are reconciled against the previous
 * call's set.
 */
export const createLeaferBrushStampPaint = (leafer: Leafer): LeaferBrushStampPaint => {
  const entries = new Map<string, BrushStampEntry>()

  const destroyEntry = (entry: BrushStampEntry) => {
    entry.object.remove()
  }

  const sync: LeaferBrushStampPaint['sync'] = (nodes, ctx) => {
    // Defensive: the leaferSpikeFilter predicate guarantees only brush/stamp
    // markup nodes reach this module; anything else means filter/paint drifted
    // apart — surface it (fail visibly) and skip so 收支 stays balanced.
    const brushStampNodes: MivoCanvasNode[] = []
    for (const node of nodes) {
      if (isLeaferBrushStampPaintedNode(node)) {
        brushStampNodes.push(node)
      } else {
        debugLogger.warn(
          SOURCE,
          `skipped non-brush/stamp node ${node.id} (type=${node.type}, markupKind=${node.markupKind ?? '(none)'}) — filter/paint predicate drift`,
        )
      }
    }

    const prevIds = [...entries.keys()]
    const nextIds = brushStampNodes.map((node) => node.id)
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

    for (const node of brushStampNodes) {
      const projected = projectNode(node)
      const paintPlan = brushStampPaintPlanFor(projected, ctx.layerOf?.(node.id))
      const existing = entries.get(node.id)

      if (plan.created.has(node.id) || !existing) {
        const object = createBrushStampObject(paintPlan)
        entries.set(node.id, { nodeId: node.id, object, kind: paintPlan.kind })
        leafer.add(object)
        created += 1
        continue
      }

      if (existing.kind !== paintPlan.kind) {
        // dashed↔solid brush or brush↔stamp under the same id: the Leafer class
        // differs, so destroy + recreate — same kind-swap pattern as 3c/4a.
        destroyEntry(existing)
        const object = createBrushStampObject(paintPlan)
        entries.set(node.id, { nodeId: node.id, object, kind: paintPlan.kind })
        leafer.add(object)
      } else {
        setProps(existing.object, paintPlan.props)
      }
      updated += 1
    }

    return { created, updated, deleted }
  }

  const dispose: LeaferBrushStampPaint['dispose'] = () => {
    for (const entry of entries.values()) destroyEntry(entry)
    entries.clear()
  }

  const paintedCount: LeaferBrushStampPaint['paintedCount'] = () => entries.size

  return { sync, dispose, paintedCount }
}
