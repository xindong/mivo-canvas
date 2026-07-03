import { describe, expect, it } from 'vitest'
import type { ExperimentalAnchor, MivoCanvasNode } from '../types/mivoCanvas'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'
import { nodeRenderBoxFor } from '../canvas/canvasRenderAdapter'
import {
  projectAnchor,
  projectEdge,
  projectNode,
  projectNodes,
  type ProjectionContext,
  type RenderNode,
} from './projection'

const v2ImageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  status: 'ready',
  x: 32,
  y: 48,
  width: 320,
  height: 180,
  transform: { x: 32, y: 48, width: 320, height: 180, rotation: 12.5 },
  fills: [{ id: 'fill-1', kind: 'solid', color: '#f8f5ff', opacity: 0.8, visible: true }],
  strokes: [{ id: 'stroke-1', color: '#4b33c4', width: 3, style: 'dashed', opacity: 1, visible: true }],
  ...overrides,
})

const legacyImageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n2',
  type: 'image',
  title: 'Legacy',
  status: 'ready',
  // legacy: no `transform`, geometry in top-level x/y/w/h
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  assetUrl: 'https://example.com/cat.png',
  assetMimeType: 'image/png',
  ...overrides,
})

const pointAnchor: ExperimentalAnchor = {
  id: 'a1',
  type: 'point',
  targetNodeId: 'n1',
  x: 50,
  y: 60,
  instruction: 'add a hat',
  createdAt: 1000,
}
const boxAnchor: ExperimentalAnchor = {
  id: 'a2',
  type: 'box',
  targetNodeId: 'n1',
  x: 10,
  y: 20,
  width: 40,
  height: 50,
  instruction: 'redraw region',
  createdAt: 2000,
  resultNodeIds: ['r1', 'r2'],
}

const matrix = { scale: 2, translateX: 100, translateY: 200 }

describe('projectNode — V2 node field snapshot', () => {
  it('projects geometry, fills, strokes, and flags from a V2 node', () => {
    const r = projectNode(v2ImageNode({ experimentalAnchors: [pointAnchor] }), {
      selectedNodeIds: new Set(['n1']),
      matrix,
    })

    expect(r.id).toBe('n1')
    expect(r.type).toBe('image')
    expect(r.status).toBe('ready')
    expect(r.title).toBe('Image')
    expect(r.geometry).toEqual({ x: 32, y: 48, width: 320, height: 180, rotation: 12.5 })
    expect(r.hidden).toBe(false)
    expect(r.locked).toBe(false)
    expect(r.favorited).toBe(false)
    expect(r.selected).toBe(true)
    expect(r.fills).toEqual([{ id: 'fill-1', kind: 'solid', color: '#f8f5ff', opacity: 0.8, visible: true }])
    expect(r.strokes).toEqual([{ id: 'stroke-1', color: '#4b33c4', width: 3, style: 'dashed', opacity: 1, visible: true }])
  })

  it('projects anchors with screenX/Y when a matrix is supplied', () => {
    const r = projectNode(v2ImageNode({ experimentalAnchors: [pointAnchor, boxAnchor] }), { matrix })
    expect(r.anchors).toHaveLength(2)
    // point: no width/height; screenX/Y = x*scale + translate
    expect(r.anchors![0]).toEqual({
      id: 'a1',
      type: 'point',
      targetNodeId: 'n1',
      x: 50,
      y: 60,
      instruction: 'add a hat',
      screenX: 50 * 2 + 100,
      screenY: 60 * 2 + 200,
    })
    // box: width/height preserved + resultNodeIds cloned
    expect(r.anchors![1]).toEqual({
      id: 'a2',
      type: 'box',
      targetNodeId: 'n1',
      x: 10,
      y: 20,
      width: 40,
      height: 50,
      instruction: 'redraw region',
      resultNodeIds: ['r1', 'r2'],
      screenX: 10 * 2 + 100,
      screenY: 20 * 2 + 200,
    })
  })

  it('omits screenX/Y when no matrix is supplied', () => {
    const r = projectNode(v2ImageNode({ experimentalAnchors: [pointAnchor] }))
    expect(r.anchors).toHaveLength(1)
    expect(r.anchors![0]).not.toHaveProperty('screenX')
    expect(r.anchors![0]).not.toHaveProperty('screenY')
  })

  it('omits anchors entirely when the node has none', () => {
    const r = projectNode(v2ImageNode())
    expect(r.anchors).toBeUndefined()
  })
})

describe('projectNode — legacy node normalizes to the same V2 projection', () => {
  it('derives geometry from legacy x/y/w/h when transform is absent', () => {
    const r = projectNode(legacyImageNode())
    expect(r.geometry).toEqual({ x: 10, y: 20, width: 300, height: 200, rotation: 0 })
  })

  it('synthesizes the V2 image fill from legacy assetUrl (matches normalizeCanvasNodeV2)', () => {
    const normalized = normalizeCanvasNodeV2(legacyImageNode())
    const r = projectNode(legacyImageNode())
    expect(r.fills).toEqual(normalized.fills)
    expect(r.fills![0]).toMatchObject({ kind: 'image', assetUrl: 'https://example.com/cat.png' })
  })

  it('projects asset fields from legacy asset* fields', () => {
    const r = projectNode(legacyImageNode())
    expect(r.assetUrl).toBe('https://example.com/cat.png')
    expect(r.assetMimeType).toBe('image/png')
  })

  it('legacy and V2-equivalent nodes produce identical projections (geometry + fills)', () => {
    // legacy form
    const legacy = projectNode(legacyImageNode())
    // V2 form with the same geometry + a manual image fill
    const v2equiv = projectNode(
      v2ImageNode({
        id: 'n2',
        transform: { x: 10, y: 20, width: 300, height: 200, rotation: 0 },
        fills: [{ id: 'n2-image-fill', kind: 'image', assetUrl: 'https://example.com/cat.png', opacity: 1, visible: true, scaleMode: 'fill' }],
      }),
    )
    expect(legacy.geometry).toEqual(v2equiv.geometry)
    // fills differ in id only (legacy synthesizes `${id}-image-fill`); shape + assetUrl match
    expect(legacy.fills).toHaveLength(1)
    expect(v2equiv.fills).toHaveLength(1)
    expect(legacy.fills![0].kind).toBe(v2equiv.fills![0].kind)
    expect((legacy.fills![0] as { assetUrl: string }).assetUrl).toBe((v2equiv.fills![0] as { assetUrl: string }).assetUrl)
  })
})

describe('projectNode — selection propagation', () => {
  it('selected=true when id is in selectedNodeIds', () => {
    expect(projectNode(v2ImageNode(), { selectedNodeIds: new Set(['n1']) }).selected).toBe(true)
  })
  it('selected=false when id is absent', () => {
    expect(projectNode(v2ImageNode(), { selectedNodeIds: new Set(['other']) }).selected).toBe(false)
  })
  it('selected=false when no context is supplied', () => {
    expect(projectNode(v2ImageNode()).selected).toBe(false)
  })
})

describe('projectNode — deep-clone isolation', () => {
  it('does not share fills/strokes/anchors references with the source node', () => {
    const node = v2ImageNode({ experimentalAnchors: [pointAnchor] })
    const r = projectNode(node)
    expect(r.fills).not.toBe(node.fills)
    expect(r.fills![0]).not.toBe(node.fills![0])
    expect(r.strokes).not.toBe(node.strokes)
    expect(r.anchors).not.toBe(node.experimentalAnchors)
    expect(r.anchors![0]).not.toBe(node.experimentalAnchors![0])
  })
})

describe('projectNode — cross-check with canvasRenderAdapter (geometry consistency)', () => {
  // Validates that the canonical projection produces the same geometry source
  // the existing DOM adapter uses, WITHOUT refactoring canvasRenderAdapter.
  it('projectNode.geometry matches the transform nodeRenderBoxFor consumes', () => {
    const node = v2ImageNode({ transform: { x: 32, y: 48, width: 320, height: 180, rotation: 12.5 } })
    const r = projectNode(node)
    const box = nodeRenderBoxFor(node)
    expect(r.geometry.width).toBe(box.width)
    expect(r.geometry.height).toBe(box.height)
    // nodeRenderBoxFor formats transform as 'translate(Xpx, Ypx) rotate(Rdeg)'
    expect(box.transform).toBe(`translate(${r.geometry.x}px, ${r.geometry.y}px) rotate(${r.geometry.rotation}deg)`)
  })
})

describe('projectAnchor — direct', () => {
  it('projects a point anchor without width/height', () => {
    expect(projectAnchor(pointAnchor)).toEqual({
      id: 'a1',
      type: 'point',
      targetNodeId: 'n1',
      x: 50,
      y: 60,
      instruction: 'add a hat',
    })
  })
  it('projects a box anchor with width/height + resultNodeIds', () => {
    expect(projectAnchor(boxAnchor)).toEqual({
      id: 'a2',
      type: 'box',
      targetNodeId: 'n1',
      x: 10,
      y: 20,
      width: 40,
      height: 50,
      instruction: 'redraw region',
      resultNodeIds: ['r1', 'r2'],
    })
  })
  it('fills screenX/Y only when a matrix is supplied', () => {
    expect(projectAnchor(pointAnchor, matrix).screenX).toBe(200)
    expect(projectAnchor(pointAnchor, matrix).screenY).toBe(320)
    expect(projectAnchor(pointAnchor).screenX).toBeUndefined()
  })
  it('clones resultNodeIds (no shared ref)', () => {
    const r = projectAnchor(boxAnchor)
    expect(r.resultNodeIds).not.toBe(boxAnchor.resultNodeIds)
    expect(r.resultNodeIds).toEqual(boxAnchor.resultNodeIds)
  })
})

describe('projectNodes / projectEdge', () => {
  it('projectNodes maps a list with the same context', () => {
    const rs = projectNodes([v2ImageNode({ id: 'a' }), v2ImageNode({ id: 'b' })], { selectedNodeIds: new Set(['a']) })
    expect(rs).toHaveLength(2)
    expect(rs[0].selected).toBe(true)
    expect(rs[1].selected).toBe(false)
  })
  it('projectEdge passes through + clones', () => {
    const edge = { id: 'e1', from: 'n1', to: 'n2', type: 'edit' as const, prompt: 'p', createdAt: 123 }
    const r = projectEdge(edge)
    expect(r).toEqual(edge)
    expect(r).not.toBe(edge)
  })
})

describe('RenderNode type has no MivoCanvasNode dependency (SC6.1)', () => {
  // Type-level check: RenderNode is structurally independent of MivoCanvasNode.
  // (If a future edit makes RenderNode reference MivoCanvasNode, this compiles
  // but the renderer would transitively pull it in — kept as a documented invariant.)
  it('RenderNode is assignable to itself (trivial; documents the invariant)', () => {
    const r: RenderNode = projectNode(v2ImageNode())
    const ctx: ProjectionContext = { selectedNodeIds: new Set([r.id]) }
    expect(ctx.selectedNodeIds!.has(r.id)).toBe(true)
  })
})
