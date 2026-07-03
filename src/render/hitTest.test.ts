import { describe, expect, it } from 'vitest'
import type { RenderAnchor, RenderNode } from './projection'
import {
  defaultZOrderCompare,
  distToPolyline,
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

describe('pointInMarkupStroke', () => {
  const tol = 6
  it('hits a line segment within tolerance', () => {
    const node = makeNode({
      id: 'l1',
      type: 'markup',
      markupKind: 'line',
      geometry: { x: 0, y: 0, width: 100, height: 0, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    })
    expect(pointInMarkupStroke(node, { x: 50, y: 0 }, tol)).toBe(true) // on the line
    expect(pointInMarkupStroke(node, { x: 50, y: 5 }, tol)).toBe(true) // within tol
    expect(pointInMarkupStroke(node, { x: 50, y: 7 }, tol)).toBe(false)
    expect(pointInMarkupStroke(node, { x: 200, y: 0 }, tol)).toBe(false) // past the end
  })

  it('hits a brush polyline within tolerance', () => {
    const node = makeNode({
      id: 'b1',
      type: 'markup',
      markupKind: 'brush',
      geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      markupPoints: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }],
    })
    expect(pointInMarkupStroke(node, { x: 50, y: 50 }, tol)).toBe(true) // on seg 1
    expect(pointInMarkupStroke(node, { x: 150, y: 50 }, tol)).toBe(true) // on seg 2
    expect(pointInMarkupStroke(node, { x: 50, y: 60 }, tol)).toBe(false) // too far from both
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
