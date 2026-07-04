import { describe, expect, it } from 'vitest'
import type { RenderAnchor, RenderNode } from './projection'
import {
  defaultLineMarkupPointsFor,
  defaultZOrderCompare,
  distToPolyline,
  markupPointsToCanvas,
  pointInAnchor,
  pointInMarkupStroke,
  pointInNode,
  pointInNodeBounds,
  pointInRect,
  pointInRotatedRect,
  sortForHitTest,
  topmostAnchorHit,
  topmostHit,
  topmostNodeHit,
} from './hitTest'

const makeNode = (overrides: Partial<RenderNode> & { id: string }): RenderNode => ({
  type: 'image',
  status: 'ready',
  title: 'n',
  geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
  hidden: false,
  locked: false,
  favorited: false,
  selected: false,
  fills: [],
  strokes: [],
  ...overrides,
})

const makeAnchor = (overrides: Partial<RenderAnchor> & { id: string }): RenderAnchor => ({
  type: 'point',
  targetNodeId: 'n1',
  x: 50,
  y: 50,
  instruction: 'do',
  ...overrides,
})

describe('primitives', () => {
  it('pointInRect hits inside, misses outside', () => {
    const rect = { x: 10, y: 10, width: 80, height: 80 }
    expect(pointInRect(rect, { x: 50, y: 50 })).toBe(true)
    expect(pointInRect(rect, { x: 10, y: 10 })).toBe(true) // inclusive
    expect(pointInRect(rect, { x: 90, y: 90 })).toBe(true)
    expect(pointInRect(rect, { x: 91, y: 50 })).toBe(false)
    expect(pointInRect(rect, { x: 50, y: 91 })).toBe(false)
  })

  it('pointInRotatedRect handles rotation around center', () => {
    const g = { x: 0, y: 0, width: 100, height: 40, rotation: 90 }
    // 100×40 rect rotated 90° around center (50,20) → a 40×100 vertical bar:
    // x span [30,70] (50±20), y span [-30,70] (20±50).
    expect(pointInRotatedRect(g, { x: 50, y: 70 })).toBe(true) // top edge
    expect(pointInRotatedRect(g, { x: 50, y: -30 })).toBe(true) // bottom edge
    expect(pointInRotatedRect(g, { x: 50, y: 0 })).toBe(true) // inside
    expect(pointInRotatedRect(g, { x: 30, y: 20 })).toBe(true) // left edge (thin axis)
    expect(pointInRotatedRect(g, { x: 50, y: 80 })).toBe(false) // past top (|80-20|=60 > 50)
    expect(pointInRotatedRect(g, { x: 80, y: 20 })).toBe(false) // off thin axis (|80-50|=30 > 20)
    // No rotation → delegates to pointInRect.
    expect(pointInRotatedRect({ ...g, rotation: 0 }, { x: 50, y: 20 })).toBe(true)
  })

  it('distToPolyline measures to the nearest segment', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    expect(distToPolyline({ x: 50, y: 0 }, pts)).toBe(0)
    expect(distToPolyline({ x: 50, y: 6 }, pts)).toBe(6)
    expect(distToPolyline({ x: 106, y: 50 }, pts)).toBe(6) // nearest to vertical segment
    expect(distToPolyline({ x: 0, y: 0 }, [pts[0]])).toBe(0) // single point
  })
})

describe('pointInNodeBounds / pointInNode', () => {
  it('hits an axis-aligned node', () => {
    const node = makeNode({ id: 'n1', geometry: { x: 10, y: 10, width: 80, height: 80, rotation: 0 } })
    expect(pointInNodeBounds(node, { x: 50, y: 50 })).toBe(true)
    expect(pointInNodeBounds(node, { x: 5, y: 5 })).toBe(false)
  })

  it('pointInNode = bounds OR stroke', () => {
    const node = makeNode({ id: 'n1', geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } })
    expect(pointInNode(node, { x: 50, y: 50 }, 6)).toBe(true) // bounds
    expect(pointInNode(node, { x: 200, y: 200 }, 6)).toBe(false)
  })
})

describe('markupPointsToCanvas / defaultLineMarkupPointsFor', () => {
  it('markupPointsToCanvas offsets node-local points by geometry.x/y', () => {
    const node = makeNode({ id: 'l', geometry: { x: 200, y: 100, width: 100, height: 0, rotation: 0 } })
    const canvas = markupPointsToCanvas(node, [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
    expect(canvas).toEqual([
      { x: 200, y: 100 },
      { x: 300, y: 100 },
    ])
  })

  it('defaultLineMarkupPointsFor returns bottom-left → top-right local endpoints', () => {
    const node = makeNode({ id: 'l', geometry: { x: 0, y: 0, width: 80, height: 60, rotation: 0 } })
    expect(defaultLineMarkupPointsFor(node)).toEqual([
      { x: 0, y: 60 },
      { x: 80, y: 0 },
    ])
  })
})

describe('pointInMarkupStroke', () => {
  const tol = 6
  it('hits a line segment within tolerance (strokeWidth 0 → effective tol 7)', () => {
    const node = makeNode({
      id: 'l1',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 0, y: 0, width: 100, height: 0, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    })
    expect(pointInMarkupStroke(node, { x: 50, y: 0 }, tol)).toBe(true) // on the line
    expect(pointInMarkupStroke(node, { x: 50, y: 5 }, tol)).toBe(true) // within tol
    expect(pointInMarkupStroke(node, { x: 50, y: 7 }, tol)).toBe(true) // lineHitTolerance bumps to 7
    expect(pointInMarkupStroke(node, { x: 50, y: 8 }, tol)).toBe(false) // past bumped tol
    expect(pointInMarkupStroke(node, { x: 200, y: 0 }, tol)).toBe(false) // past the end segment
  })

  it('line: local points + geometry offset hit in canvas space', () => {
    // Node at (200,100); local points (0,0)→(100,0) → canvas (200,100)→(300,100).
    const node = makeNode({
      id: 'l2',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 200, y: 100, width: 100, height: 0, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    })
    expect(pointInMarkupStroke(node, { x: 250, y: 100 }, tol)).toBe(true) // on canvas line
    expect(pointInMarkupStroke(node, { x: 250, y: 107 }, tol)).toBe(true) // within bumped tol 7
    expect(pointInMarkupStroke(node, { x: 50, y: 100 }, tol)).toBe(false) // pre-offset local x=50 — not on canvas line
    expect(pointInMarkupStroke(node, { x: 250, y: 108 }, tol)).toBe(false) // past tol
  })

  it('line: falls back to default endpoints when markupPoints missing', () => {
    // geometry 80×60, no points → default local (0,60)→(80,0) → canvas (10,70)→(90,10).
    const node = makeNode({
      id: 'l3',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 10, y: 10, width: 80, height: 60, rotation: 0 },
    })
    const mid = { x: 10 + 40, y: 10 + 30 } // canvas midpoint of the default diagonal
    expect(pointInMarkupStroke(node, mid, tol)).toBe(true)
    expect(pointInMarkupStroke(node, { x: 10, y: 10 }, tol)).toBe(false) // corner, off the diagonal
  })

  it('line endpoint tolerance aligns with DOM .markup-hit-line (max(14, sw+10)/2)', () => {
    // strokeWidth 0 → DOM strokeWidth=max(14,10)=14 → radius 7. Endpoint at canvas (200,100).
    const thin = makeNode({
      id: 'lt',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 200, y: 100, width: 100, height: 0, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      markupStrokeWidth: 0,
    })
    expect(pointInMarkupStroke(thin, { x: 200, y: 107 }, 6)).toBe(true) // endpoint within 7
    expect(pointInMarkupStroke(thin, { x: 200, y: 108 }, 6)).toBe(false)
    // strokeWidth 20 → DOM strokeWidth=max(14,30)=30 → radius 15.
    const thick = makeNode({ ...thin, id: 'lt2', markupStrokeWidth: 20 })
    expect(pointInMarkupStroke(thick, { x: 200, y: 115 }, 6)).toBe(true) // endpoint within 15
    expect(pointInMarkupStroke(thick, { x: 200, y: 116 }, 6)).toBe(false)
  })

  it('hits a brush polyline within tolerance (local points + geometry offset)', () => {
    // Node at (50,30); local polyline (0,0)→(100,100)→(200,0) → canvas (50,30)→(150,130)→(250,30).
    const node = makeNode({
      id: 'b1',
      type: 'markup',
      markupKind: 'brush',
      geometry: { x: 50, y: 30, width: 200, height: 100, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }],
    })
    // Seg 1 midpoint = canvas (100,80); seg 2 midpoint = canvas (200,80).
    expect(pointInMarkupStroke(node, { x: 100, y: 80 }, tol)).toBe(true) // on seg 1 (canvas)
    expect(pointInMarkupStroke(node, { x: 200, y: 80 }, tol)).toBe(true) // on seg 2 (canvas)
    // (100,90): nearest point on seg 1 is (105,85), dist ~7.07 > tol 6 → miss.
    expect(pointInMarkupStroke(node, { x: 100, y: 90 }, tol)).toBe(false)
    // Canvas-space start of seg 1 — proves the geometry offset is applied.
    expect(pointInMarkupStroke(node, { x: 50, y: 30 }, tol)).toBe(true)
    // Pre-offset local-space point (0,0) must NOT hit (it maps to canvas (50,30) only via offset;
    // here we pass (0,0) directly as a canvas point, which is far from the canvas polyline).
    expect(pointInMarkupStroke(node, { x: 0, y: 0 }, tol)).toBe(false)
  })

  it('hits a rect border (not interior) within tolerance', () => {
    const node = makeNode({
      id: 'r1',
      type: 'markup',
      markupKind: 'rect',
      geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
    })
    expect(pointInMarkupStroke(node, { x: 50, y: 0 }, tol)).toBe(true) // top edge
    expect(pointInMarkupStroke(node, { x: 100, y: 50 }, tol)).toBe(true) // right edge
    // Interior (not on border) — stroke hit is false; bounds hit covers interior.
    expect(pointInMarkupStroke(node, { x: 50, y: 50 }, tol)).toBe(false)
  })

  it('ellipse/note/stamp return false (bounds hit covers them)', () => {
    const ellipse = makeNode({ id: 'e1', type: 'markup', markupKind: 'ellipse', geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } })
    expect(pointInMarkupStroke(ellipse, { x: 50, y: 50 }, tol)).toBe(false)
  })
})

describe('pointInNode — line/arrow stroke-only parity', () => {
  const tol = 6
  it('line: click inside bbox but off the stroke does NOT hit (stroke-only)', () => {
    // Line at canvas (200,100)→(300,100); bbox is x[200,300] y[100,100] (zero height).
    // Give it a non-zero bbox by setting height so bounds would catch an interior point.
    const node = makeNode({
      id: 'l',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 200, y: 100, width: 100, height: 80, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    })
    // (250, 150) is inside the 100×80 bbox but far from the stroke at y=100.
    expect(pointInNodeBounds(node, { x: 250, y: 150 })).toBe(true) // bbox would catch
    expect(pointInNode(node, { x: 250, y: 150 }, tol)).toBe(false) // stroke-only: falls through
    expect(pointInNode(node, { x: 250, y: 100 }, tol)).toBe(true) // on the stroke
  })

  it('brush: bbox OR stroke (interior still hits via bounds)', () => {
    const node = makeNode({
      id: 'b',
      type: 'markup',
      markupKind: 'brush',
      geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    })
    expect(pointInNode(node, { x: 50, y: 50 }, tol)).toBe(true) // interior via bounds
    expect(pointInNode(node, { x: 50, y: 0 }, tol)).toBe(true) // on the stroke
  })

  it('rect: bbox covers interior; border also stroke-toleranced', () => {
    const node = makeNode({
      id: 'r',
      type: 'markup',
      markupKind: 'rect',
      geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
    })
    expect(pointInNode(node, { x: 50, y: 50 }, tol)).toBe(true) // interior via bounds
    expect(pointInNode(node, { x: 50, y: 0 }, tol)).toBe(true) // top border via stroke
  })
})

describe('topmostHit — line stroke-only falls through to node below', () => {
  const tol = 6
  it('click on line stroke hits the line; click on line bbox (off stroke) hits the node below', () => {
    // Image fills 0..200; line sits on top at canvas (50,50)→(150,50) inside the image.
    const image = makeNode({ id: 'img', geometry: { x: 0, y: 0, width: 200, height: 200, rotation: 0 } })
    const line = makeNode({
      id: 'line',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 50, y: 50, width: 100, height: 80, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    })
    // Back-to-front: image (back) then line (front). Both are content rank; stable
    // sort preserves input order, so pass image first.
    const ordered = sortForHitTest([image, line])
    expect(ordered[ordered.length - 1].id).toBe('line') // line on top
    // On the stroke → line (topmost stroke hit).
    expect(topmostHit(ordered, { x: 100, y: 50 }, { strokeHitTolerance: tol })).toEqual({ kind: 'node', nodeId: 'line' })
    // Inside line bbox but off stroke (y=120 is in 100×80 bbox, far from stroke at y=50) → falls through to image.
    expect(topmostHit(ordered, { x: 100, y: 120 }, { strokeHitTolerance: tol })).toEqual({ kind: 'node', nodeId: 'img' })
  })
})

describe('pointInAnchor', () => {
  it('point anchor hits within radius', () => {
    const a = makeAnchor({ id: 'a1', type: 'point', x: 50, y: 50 })
    expect(pointInAnchor(a, { x: 50, y: 50 }, 8)).toBe(true)
    expect(pointInAnchor(a, { x: 55, y: 55 }, 8)).toBe(true) // dist ~7.07 ≤ 8
    expect(pointInAnchor(a, { x: 60, y: 60 }, 8)).toBe(false) // dist ~14 > 8
  })
  it('box anchor hits inside the box rect', () => {
    const a = makeAnchor({ id: 'a2', type: 'box', x: 10, y: 10, width: 40, height: 50 })
    expect(pointInAnchor(a, { x: 30, y: 35 }, 8)).toBe(true)
    expect(pointInAnchor(a, { x: 10, y: 10 }, 8)).toBe(true) // corner inclusive
    expect(pointInAnchor(a, { x: 51, y: 35 }, 8)).toBe(false) // outside right
  })
})

describe('topmostHit — two-pass (anchors first, then nodes)', () => {
  const node = (id: string, anchors: RenderAnchor[] = []): RenderNode =>
    makeNode({ id, geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 }, ...(anchors.length ? { anchors } : {}) })

  it('returns the anchor when the point is on an anchor mark', () => {
    const n = node('n1', [makeAnchor({ id: 'a1', x: 50, y: 50 })])
    expect(topmostHit([n], { x: 50, y: 50 })).toEqual({ kind: 'anchor', nodeId: 'n1', anchorId: 'a1' })
  })

  it('returns the node body when the point is on the body but not on any anchor', () => {
    const n = node('n1', [makeAnchor({ id: 'a1', x: 50, y: 50 })])
    expect(topmostHit([n], { x: 10, y: 10 })).toEqual({ kind: 'node', nodeId: 'n1' })
  })

  it('anchor takes precedence over a node body at the same point (FloatingUI layer)', () => {
    const front = node('front', [makeAnchor({ id: 'a1', x: 50, y: 50 })])
    const back = node('back')
    // back is behind front; point (50,50) is on front's anchor AND front's body
    expect(topmostHit([back, front], { x: 50, y: 50 })).toEqual({ kind: 'anchor', nodeId: 'front', anchorId: 'a1' })
  })

  it('returns the front-most node among overlapping bodies', () => {
    const back = node('back', )
    const front = node('front')
    // back-to-front order: [back, front]
    expect(topmostHit([back, front], { x: 50, y: 50 })).toEqual({ kind: 'node', nodeId: 'front' })
  })

  it('frame background 穿透: child hit before frame bg', () => {
    const frame = makeNode({ id: 'frame', type: 'frame', geometry: { x: 0, y: 0, width: 200, height: 200, rotation: 0 } })
    const child = makeNode({ id: 'child', geometry: { x: 50, y: 50, width: 40, height: 40, rotation: 0 } })
    // back-to-front: frame (bottom) then child (content)
    const ordered = sortForHitTest([child, frame])
    expect(ordered[0].id).toBe('frame') // frame at back
    // click on child → child
    expect(topmostHit(ordered, { x: 60, y: 60 })).toEqual({ kind: 'node', nodeId: 'child' })
    // click on frame bg (not on child) → frame
    expect(topmostHit(ordered, { x: 10, y: 10 })).toEqual({ kind: 'node', nodeId: 'frame' })
  })

  it('skips hidden nodes', () => {
    const hidden = makeNode({ id: 'hidden', hidden: true, geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } })
    const visible = makeNode({ id: 'visible', geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } })
    expect(topmostHit([hidden, visible], { x: 50, y: 50 })).toEqual({ kind: 'node', nodeId: 'visible' })
  })

  it('locked nodes are hit by default (selectable to unlock)', () => {
    const locked = makeNode({ id: 'locked', locked: true, geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } })
    expect(topmostHit([locked], { x: 50, y: 50 })).toEqual({ kind: 'node', nodeId: 'locked' })
    expect(topmostHit([locked], { x: 50, y: 50 }, { skipLocked: true })).toBeNull()
  })

  it('returns null when nothing is hit', () => {
    const n = node('n1')
    expect(topmostHit([n], { x: 999, y: 999 })).toBeNull()
  })

  it('topmostNodeHit / topmostAnchorHit isolate one pass', () => {
    const n = node('n1', [makeAnchor({ id: 'a1', x: 50, y: 50 })])
    expect(topmostNodeHit([n], { x: 50, y: 50 })).toEqual({ kind: 'node', nodeId: 'n1' })
    expect(topmostAnchorHit([n], { x: 50, y: 50 })).toEqual({ kind: 'anchor', nodeId: 'n1', anchorId: 'a1' })
    expect(topmostAnchorHit([n], { x: 10, y: 10 })).toBeNull()
  })
})

describe('z-order comparator', () => {
  it('sorts frame < content < selected (back-to-front)', () => {
    const selected = makeNode({ id: 'sel', selected: true })
    const frame = makeNode({ id: 'f', type: 'frame' })
    const content = makeNode({ id: 'c' })
    const ordered = sortForHitTest([selected, frame, content])
    expect(ordered.map((n) => n.id)).toEqual(['f', 'c', 'sel'])
  })
  it('defaultZOrderCompare is stable for same-rank nodes', () => {
    const a = makeNode({ id: 'a' })
    const b = makeNode({ id: 'b' })
    expect(defaultZOrderCompare(a, b)).toBe(0)
  })
})
