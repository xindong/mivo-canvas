// leaferShapePaint — Phase 4a: formalize frame / markup shape (rect / ellipse /
// note) paint onto Leafer behind the RendererAdapter contract.
//
// The 0g spike painted frame + markup-rect inline (useLeaferSpikeRenderer) from
// raw node fields with its own fallback colors — which drifted from the DOM
// visuals (no dashed frame border, no corner radius, no stroke opacity, no
// ellipse/note support at all). This module routes shape paint through the
// contract so:
//
//   - fills/strokes come from `projectNode` (Phase 1a sank the frame/markup
//     product visual defaults into the projection as synthetic solid fills /
//     strokes), so Leafer reads the SAME complete visuals the DOM renderer
//     reads — no re-implemented fallback chain.
//   - the DOM stroke semantics are reproduced: SVG rect/ellipse inset the
//     shape by strokeWidth/2 (CanvasNodeView.tsx) and the CSS borders are
//     box-sizing:border-box, i.e. the stroke always lies INSIDE the node box →
//     Leafer `strokeAlign: 'inside'` on the full node box covers the same
//     region. Dash pattern mirrors the SVG formula
//     `${strokeWidth * 2.2} ${strokeWidth * 1.6}` (CanvasNodeView.tsx:294; CSS
//     `dashed` borders have a browser-defined pattern — the SVG formula is the
//     single in-repo dash convention, applied to frame too).
//   - note mirrors .dom-markup-note (App.css): fill 'transparent' → '#fff1a8',
//     2px solid border, cornerRadius 6, shadow 0 12px 30px rgba(35,35,35,0.14).
//     The note TEXT layer (MarkupTextLayer) is DOM-only and stays out of scope
//     until Phase 5 — see leaferSpikeFilter.ts header note.
//   - create/update/delete 收支 goes through `diffReconcilePlan` (the
//     RendererAdapter contract's ground-truth diff — see rendererAdapter.ts).
//   - 2b-2 z-order: every object gets `zIndex` from `ctx.layerOf` (the hook
//     supplies Layer.Frame/Layer.Content × stable document order via
//     leaferZOrderMapFor), so frames paint under content and shapes/images
//     interleave in document order across paint modules — same ordering the
//     DOM zIndex + hitTest defaultZOrderCompare read from the projection.
//
// D1 (hard constraint): pure paint. `hittable:false` is set on the Leafer root,
// this module never subscribes to Leafer events and never touches the camera
// layer (asserted by the source-contract tests in leaferShapePaint.test.ts).
//
// 0g three invariants: pan walks the camera only — `sync` is NOT called during
// pan (the paint effect re-runs on node change, not viewport.x/y). Shapes do
// not participate in threshold LOD by design: 0g measured them as "本来就是
// 矩形" (solid vector fills, no texture/text cost), shouldUseEngineLod only
// covers image/text. Zoom settle behavior for image/text is untouched.

import { Ellipse, Rect } from 'leafer-ui'
import type { Leafer } from 'leafer-ui'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import { Layer } from './layers'
import { isLeaferShapePaintedNode } from './leaferSpikeFilter'
import { projectNode, type RenderNode } from './projection'
import {
  diffReconcilePlan,
  type RendererReconcileCounts,
  type RendererSyncContext,
} from './rendererAdapter'

type ShapeObject = Rect | Ellipse
type ShapeEntryKind = 'frame' | 'markup-rect' | 'markup-ellipse' | 'markup-note'

type ShapeEntry = {
  nodeId: string
  object: ShapeObject
  kind: ShapeEntryKind
}

export type LeaferShapePaint = {
  /** Reconcile painted shapes to `nodes`. Returns create/update/delete counts
   *  (收支 balance: every prev id is either updated or deleted, every new id is
   *  created exactly once, no id is both — asserted in leaferShapePaint.test.ts). */
  sync(nodes: MivoCanvasNode[], ctx: RendererSyncContext): RendererReconcileCounts
  /** Remove all objects (Leafer destroy / mode-switch path). */
  dispose(): void
  /** Painted entry count (for stats + reconcile assertions). */
  paintedCount(): number
}

export const SOURCE = 'Leafer Shape'

// Note visuals from .dom-markup-note (src/App.css) — the note border is a fixed
// 2px solid with 6px radius and a soft drop shadow; only its colors come from
// the node (fill/stroke). Kept as named constants so the DOM-parity tests and
// a future App.css change have one place to look.
const NOTE_FALLBACK_FILL = '#fff1a8'
const NOTE_STROKE_WIDTH = 2
const NOTE_CORNER_RADIUS = 6
const NOTE_SHADOW = { x: 0, y: 12, blur: 30, color: 'rgba(35, 35, 35, 0.14)' }
const MARKUP_RECT_CORNER_RADIUS_DEFAULT = 4

/** SVG dash formula from CanvasNodeView.tsx:294 (`${w * 2.2} ${w * 1.6}`). */
export const dashPatternFor = (strokeWidth: number): number[] => [
  strokeWidth * 2.2,
  strokeWidth * 1.6,
]

const HEX_COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i

const round3 = (value: number) => Math.round(value * 1000) / 1000

/**
 * FU-10: bake a stroke opacity into the color as `rgba()`.
 *
 * Leafer 2.1.10 does not apply `{type:'solid', color, opacity}` opacity on a
 * STROKE at render time (pixel-probed in PR #116: DOM #000@0.82 over beige =
 * (40,39,37), Leafer painted (0,0,0) full-opacity), so 4a's solid-paint-object
 * stroke rendered translucent markup borders fully opaque. Shapes carry fill +
 * stroke on ONE object, so the 4b fix (object-level opacity — exact for a Line,
 * which has no fill) is not available here: it would fade the fill too. Baking
 * the alpha into the rgba color reproduces the SVG strokeOpacity semantics
 * (stroke alpha = color alpha × strokeOpacity) without touching the fill.
 *
 * Supports the in-repo color forms (#rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba()).
 * Anything else (named colors, hsl, gradients) falls back to the original color
 * at full opacity — the pre-fix FU-10 behavior — and warns (fail visibly).
 */
export const strokeColorWithBakedOpacity = (color: string, opacity: number): string => {
  if (opacity >= 1) return color
  const trimmed = color.trim()

  const hex = HEX_COLOR_RE.exec(trimmed)
  if (hex) {
    const digits = hex[1]
    const size = digits.length <= 4 ? 1 : 2
    const channel = (index: number) => {
      const raw = digits.slice(index * size, index * size + size)
      return Number.parseInt(size === 1 ? raw + raw : raw, 16)
    }
    const hasAlpha = digits.length === 4 || digits.length === 8
    const baseAlpha = hasAlpha ? channel(3) / 255 : 1
    return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${round3(baseAlpha * opacity)})`
  }

  const rgb = RGB_COLOR_RE.exec(trimmed)
  if (rgb) {
    const baseAlpha = rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4])
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${round3(baseAlpha * opacity)})`
  }

  debugLogger.warn(
    SOURCE,
    `stroke opacity bake skipped for unsupported color "${color}" — painting at full opacity (FU-10 fallback)`,
  )
  return color
}

/** Layer a shape node paints in (2b-2 z-order): frame → Layer.Frame (bottom),
 *  markup shapes → Layer.Content — same policy projection.projectNode writes
 *  into RenderNode.layer. Exported for the hook's z-order map + tests. */
export const shapeLayerFor = (node: MivoCanvasNode): Layer =>
  node.type === 'frame' ? Layer.Frame : Layer.Content

/** Stable z-order for the Leafer children (2b-2): layer band × document order.
 *  Mirrors hitTest defaultZOrderCompare (layer → renderOrder(0) → doc order) so
 *  the Leafer canvas stacks like the DOM zIndex does. The hook builds this once
 *  per sync over the FULL painted list (shapes + images) and hands it to every
 *  paint module via ctx.layerOf, so cross-module insertion order stops mattering. */
export const LEAFER_Z_LAYER_STEP = 1_000_000
export const leaferZOrderMapFor = (nodes: MivoCanvasNode[]): Map<string, number> => {
  const map = new Map<string, number>()
  nodes.forEach((node, index) => {
    const layer = node.type === 'frame' ? Layer.Frame : Layer.Content
    map.set(node.id, layer * LEAFER_Z_LAYER_STEP + index)
  })
  return map
}

const shapeKindFor = (node: MivoCanvasNode): ShapeEntryKind | null => {
  if (node.type === 'frame') return 'frame'
  if (node.type !== 'markup') return null
  if (node.markupKind === 'rect') return 'markup-rect'
  if (node.markupKind === 'ellipse') return 'markup-ellipse'
  if (node.markupKind === 'note') return 'markup-note'
  return null
}

const clampDim = (value: number) => Math.max(1, value)

const firstVisibleSolidFillColor = (r: RenderNode): string | undefined => {
  for (const fill of r.fills) {
    if (fill.kind === 'solid' && fill.visible) return fill.color
  }
  return undefined
}

const firstVisibleStroke = (r: RenderNode) => r.strokes.find((stroke) => stroke.visible)

/**
 * Map a projected RenderNode → Leafer paint props for one shape kind.
 *
 * DOM-parity choices (locked by leaferShapePaint.test.ts):
 *  - fill is the solid fill COLOR only — the DOM SVG `fill` attr / CSS
 *    background ignore CanvasNodeFill.opacity (any translucency lives in the
 *    rgba color string), so Leafer does the same.
 *  - markup rect/ellipse stroke opacity = stroke.opacity ?? markupOpacity ?? 1
 *    (canvasRenderAdapter.markupRenderStyleFor), baked into an rgba() color
 *    only when < 1 (FU-10 — see strokeColorWithBakedOpacity).
 *  - frame stroke has no opacity channel in the DOM (CSS border-color) →
 *    always a plain color string.
 *  - note ignores markup stroke width/style entirely (fixed 2px solid border
 *    in .dom-markup-note) and falls back to #fff1a8 on 'transparent' fill
 *    (CanvasNodeView note branch).
 */
export const shapePaintPropsFor = (
  r: RenderNode,
  kind: ShapeEntryKind,
  zIndex: number | undefined,
): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    x: r.geometry.x,
    y: r.geometry.y,
    width: clampDim(r.geometry.width),
    height: clampDim(r.geometry.height),
    // FU-8: DOM applies `translate(x,y) rotate(θ)` with transformOrigin 50% 50%
    // (canvasRenderAdapter.nodeRenderBoxFor) — Leafer equivalent is rotation +
    // origin:'center' (x/y stay the unrotated box top-left). rotation is ALWAYS
    // present (0 default) so a rotate-then-reset update clears the old angle.
    rotation: r.geometry.rotation || 0,
    origin: 'center',
    ...(zIndex !== undefined ? { zIndex } : {}),
  }

  const fillColor = firstVisibleSolidFillColor(r)
  const stroke = firstVisibleStroke(r)

  if (kind === 'markup-note') {
    return {
      ...base,
      fill: !fillColor || fillColor === 'transparent' ? NOTE_FALLBACK_FILL : fillColor,
      stroke: stroke?.color,
      strokeWidth: NOTE_STROKE_WIDTH,
      strokeAlign: 'inside',
      cornerRadius: NOTE_CORNER_RADIUS,
      shadow: { ...NOTE_SHADOW },
    }
  }

  // Every visual key is ALWAYS present (undefined = clear): the update path
  // reuses this props object through Leafer's merging `set()`, so a state
  // rollback (dashed → solid, stroke removed, …) must explicitly unset the old
  // value instead of silently keeping it.
  const strokeWidth = stroke?.width ?? 0
  const dashed = stroke?.style === 'dashed'
  const props: Record<string, unknown> = {
    ...base,
    fill: fillColor,
    strokeWidth,
    strokeAlign: 'inside',
    dashPattern: dashed ? dashPatternFor(strokeWidth) : undefined,
  }

  if (kind === 'frame') {
    props.stroke = stroke?.color
    return props
  }

  // markup rect / ellipse — FU-10: translucent strokes bake the opacity into
  // the rgba color (Leafer ignores solid-paint-object opacity on strokes, and
  // object-level opacity would fade the fill too).
  const strokeOpacity = stroke?.opacity ?? r.markupOpacity ?? 1
  props.stroke = !stroke ? undefined : strokeColorWithBakedOpacity(stroke.color, strokeOpacity)
  if (kind === 'markup-rect') {
    props.cornerRadius = r.markupCornerRadius ?? MARKUP_RECT_CORNER_RADIUS_DEFAULT
  }
  return props
}

const createShapeObject = (kind: ShapeEntryKind, props: Record<string, unknown>): ShapeObject =>
  kind === 'markup-ellipse' ? new Ellipse(props) : new Rect(props)

const setProps = (object: ShapeObject, props: Record<string, unknown>) => {
  ;(object as { set: (props: unknown) => void }).set(props)
}

/**
 * Create a Leafer shape paint module bound to one Leafer instance. The hook
 * creates one when Leafer inits and disposes it when Leafer is destroyed; all
 * shape nodes seen by `sync` are reconciled against the previous call's set.
 */
export const createLeaferShapePaint = (leafer: Leafer): LeaferShapePaint => {
  const entries = new Map<string, ShapeEntry>()

  const destroyEntry = (entry: ShapeEntry) => {
    entry.object.remove()
  }

  const sync: LeaferShapePaint['sync'] = (nodes, ctx) => {
    // Defensive: the leaferSpikeFilter predicate guarantees only shape nodes
    // reach this module; a non-shape node here means filter/paint drifted apart
    // — surface it (fail visibly) and skip so收支 stays balanced on the rest.
    const shapeNodes: MivoCanvasNode[] = []
    for (const node of nodes) {
      if (isLeaferShapePaintedNode(node) && shapeKindFor(node)) {
        shapeNodes.push(node)
      } else {
        debugLogger.warn(
          SOURCE,
          `skipped non-shape node ${node.id} (type=${node.type}, markupKind=${node.markupKind ?? '(none)'}) — filter/paint predicate drift`,
        )
      }
    }

    const prevIds = [...entries.keys()]
    const nextIds = shapeNodes.map((node) => node.id)
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

    for (const node of shapeNodes) {
      const kind = shapeKindFor(node) as ShapeEntryKind
      const projected = projectNode(node)
      const props = shapePaintPropsFor(projected, kind, ctx.layerOf?.(node.id))
      const existing = entries.get(node.id)

      if (plan.created.has(node.id) || !existing) {
        const object = createShapeObject(kind, props)
        entries.set(node.id, { nodeId: node.id, object, kind })
        leafer.add(object)
        created += 1
        continue
      }

      if (existing.kind !== kind) {
        // markupKind changed under the same id (e.g. rect → ellipse): the Leafer
        // class differs, so destroy + recreate — same kind-swap pattern as 3c.
        destroyEntry(existing)
        const object = createShapeObject(kind, props)
        entries.set(node.id, { nodeId: node.id, object, kind })
        leafer.add(object)
      } else {
        setProps(existing.object, props)
      }
      updated += 1
    }

    return { created, updated, deleted }
  }

  const dispose: LeaferShapePaint['dispose'] = () => {
    for (const entry of entries.values()) destroyEntry(entry)
    entries.clear()
  }

  const paintedCount: LeaferShapePaint['paintedCount'] = () => entries.size

  return { sync, dispose, paintedCount }
}
