import { describe, expect, it } from 'vitest'
import type { CanvasNodeSolidFill, ExperimentalAnchor, MivoCanvasNode } from '../types/mivoCanvas'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'
import { Layer } from './layers'
import {
  frameRenderStyleFor,
  markupRenderStyleFor,
  nodeRenderBoxFor,
} from '../canvas/canvasRenderAdapter'
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

// --- Phase 3a: assetSourceDimensions projection (metrics track) ---------------

describe('projectNode — assetSourceDimensions passthrough (Phase 3a)', () => {
  it('projects assetSourceDimensions from the node', () => {
    const node = v2ImageNode({ assetSourceDimensions: { width: 1920, height: 1080 } })
    const r = projectNode(node)
    expect(r.assetSourceDimensions).toEqual({ width: 1920, height: 1080 })
  })

  it('deep-clones assetSourceDimensions (no shared reference with the source node)', () => {
    const dims = { width: 800, height: 600 }
    const node = v2ImageNode({ assetSourceDimensions: dims })
    const r = projectNode(node)
    expect(r.assetSourceDimensions).not.toBe(dims)
    expect(r.assetSourceDimensions).toEqual(dims)
    // mutating the source must not leak into the projection
    dims.width = 9999
    expect(r.assetSourceDimensions!.width).toBe(800)
  })

  it('omits assetSourceDimensions when the node has none (not synthesized)', () => {
    const r = projectNode(v2ImageNode())
    expect(r.assetSourceDimensions).toBeUndefined()
  })
})

// --- Phase 1a: visual defaults sunk from canvasRenderAdapter -------------------
//
// Locks projection's synthetic fills/strokes to be field-by-field equivalent to the
// CSS fallback in canvasRenderAdapter.frameRenderStyleFor / markupRenderStyleFor.
// The renderer (DOM today, Leafer tomorrow) can read projectNode output directly
// without re-implementing the fallback chain. If the two implementations drift, the
// assertions below fail — the DOM adapter is NOT modified by Phase 1a, so this test
// is the contract that locks them.

const frameNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'frame-1',
  type: 'frame',
  title: 'Frame',
  status: 'ready',
  x: 0, y: 0, width: 400, height: 300,
  ...overrides,
})

const markupNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'markup-1',
  type: 'markup',
  title: 'Markup',
  status: 'ready',
  x: 0, y: 0, width: 100, height: 100,
  markupKind: 'rect',
  ...overrides,
})

describe('projectNode — frame visual defaults match canvasRenderAdapter', () => {
  it('frame with no fills/strokes gets synthetic defaults equivalent to frameRenderStyleFor', () => {
    const node = frameNode()
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)

    // fill: sectionFillColor || '#ffffff'
    expect(r.fills).toHaveLength(1)
    const fill = r.fills[0] as CanvasNodeSolidFill
    expect(fill.kind).toBe('solid')
    expect(fill.visible).toBe(true)
    expect(fill.color).toBe(adapter['--section-fill-color'])
    expect(fill.color).toBe('#ffffff')

    // stroke: sectionBorderColor || frameColor || '#ff8a00', width 2, style dashed
    expect(r.strokes).toHaveLength(1)
    const stroke = r.strokes[0]
    expect(stroke.visible).toBe(true)
    expect(stroke.color).toBe(adapter['--section-border-color'])
    expect(stroke.color).toBe('#ff8a00')
    expect(stroke.width).toBe(Number(adapter['--section-border-width'].replace('px', '')))
    expect(stroke.width).toBe(2)
    expect(stroke.style).toBe(adapter['--section-border-style'])
    expect(stroke.style).toBe('dashed')
  })

  it('frame honors the section* fallback chain (field-by-field vs adapter)', () => {
    const node = frameNode({
      fills: [],
      strokes: [],
      sectionFillColor: '#f0f0f0',
      sectionBorderColor: '#123456',
      sectionBorderWidth: 5,
      sectionBorderStyle: 'solid',
    })
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)

    expect((r.fills[0] as CanvasNodeSolidFill).color).toBe('#f0f0f0')
    expect((r.fills[0] as CanvasNodeSolidFill).color).toBe(adapter['--section-fill-color'])
    expect(r.strokes[0].color).toBe('#123456')
    expect(r.strokes[0].color).toBe(adapter['--section-border-color'])
    expect(r.strokes[0].width).toBe(5)
    expect(r.strokes[0].width).toBe(Number(adapter['--section-border-width'].replace('px', '')))
    expect(r.strokes[0].style).toBe('solid')
    expect(r.strokes[0].style).toBe(adapter['--section-border-style'])
  })

  it('frame falls back to frameColor when sectionBorderColor is absent (matches adapter)', () => {
    const node = frameNode({
      fills: [], strokes: [],
      frameColor: '#ffaa00',
    })
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)
    expect(r.strokes[0].color).toBe('#ffaa00')
    expect(r.strokes[0].color).toBe(adapter['--section-border-color'])
  })

  it('frame with explicit visible solid fill/stroke is NOT overridden', () => {
    const node = frameNode({
      fills: [{ id: 'real-fill', kind: 'solid', color: '#aabbcc', opacity: 1, visible: true }],
      strokes: [{ id: 'real-stroke', color: '#ddeeff', width: 7, style: 'solid', opacity: 1, visible: true }],
    })
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)

    expect(r.fills).toHaveLength(1)
    expect((r.fills[0] as CanvasNodeSolidFill).color).toBe('#aabbcc')
    expect(adapter['--section-fill-color']).toBe('#aabbcc')
    expect(r.strokes).toHaveLength(1)
    expect(r.strokes[0].color).toBe('#ddeeff')
    expect(r.strokes[0].width).toBe(7)
    expect(adapter['--section-border-color']).toBe('#ddeeff')
  })

  it('frame with only an invisible solid fill still gets the synthetic default (matches adapter firstSolidFillFor)', () => {
    const node = frameNode({
      fills: [{ id: 'hidden', kind: 'solid', color: '#aabbcc', opacity: 1, visible: false }],
    })
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)
    // adapter's firstSolidFillFor skips invisible solids → falls back to '#ffffff'
    expect(adapter['--section-fill-color']).toBe('#ffffff')
    expect(r.fills).toHaveLength(2)
    const synthetic = r.fills[1] as CanvasNodeSolidFill
    expect(synthetic.color).toBe('#ffffff')
    expect(synthetic.visible).toBe(true)
  })
})

describe('projectNode — markup visual defaults match canvasRenderAdapter', () => {
  it('markup with no fills/strokes gets synthetic defaults equivalent to markupRenderStyleFor', () => {
    const node = markupNode()
    const r = projectNode(node)
    const adapter = markupRenderStyleFor(node)

    // fill: markupFillColor || 'rgba(105, 87, 232, 0.08)'
    expect(r.fills).toHaveLength(1)
    const fill = r.fills[0] as CanvasNodeSolidFill
    expect(fill.kind).toBe('solid')
    expect(fill.visible).toBe(true)
    expect(fill.color).toBe(adapter.fill)
    expect(fill.color).toBe('rgba(105, 87, 232, 0.08)')

    // stroke: markupStrokeColor || '#6957e8', width 3, style solid, opacity markupOpacity??1
    expect(r.strokes).toHaveLength(1)
    const stroke = r.strokes[0]
    expect(stroke.visible).toBe(true)
    expect(stroke.color).toBe(adapter.stroke)
    expect(stroke.color).toBe('#6957e8')
    expect(stroke.width).toBe(adapter.strokeWidth)
    expect(stroke.width).toBe(3)
    expect(stroke.style).toBe(adapter.strokeStyle)
    expect(stroke.style).toBe('solid')
    expect(stroke.opacity).toBe(adapter.strokeOpacity)
    expect(stroke.opacity).toBe(1)
  })

  it('markup honors the markup* fallback chain incl. markupOpacity on stroke (field-by-field vs adapter)', () => {
    const node = markupNode({
      fills: [], strokes: [],
      markupFillColor: '#aaaaaa',
      markupStrokeColor: '#bbbbbb',
      markupStrokeWidth: 9,
      markupStrokeStyle: 'dashed',
      markupOpacity: 0.5,
    })
    const r = projectNode(node)
    const adapter = markupRenderStyleFor(node)

    expect((r.fills[0] as CanvasNodeSolidFill).color).toBe('#aaaaaa')
    expect((r.fills[0] as CanvasNodeSolidFill).color).toBe(adapter.fill)
    expect(r.strokes[0].color).toBe('#bbbbbb')
    expect(r.strokes[0].color).toBe(adapter.stroke)
    expect(r.strokes[0].width).toBe(9)
    expect(r.strokes[0].width).toBe(adapter.strokeWidth)
    expect(r.strokes[0].style).toBe('dashed')
    expect(r.strokes[0].style).toBe(adapter.strokeStyle)
    expect(r.strokes[0].opacity).toBe(0.5)
    expect(r.strokes[0].opacity).toBe(adapter.strokeOpacity)
  })

  it('markup with explicit visible solid fill/stroke is NOT overridden', () => {
    const node = markupNode({
      fills: [{ id: 'real', kind: 'solid', color: '#aabbcc', opacity: 1, visible: true }],
      strokes: [{ id: 'rs', color: '#ddeeff', width: 4, style: 'dashed', opacity: 1, visible: true }],
    })
    const r = projectNode(node)
    const adapter = markupRenderStyleFor(node)

    expect(r.fills).toHaveLength(1)
    expect((r.fills[0] as CanvasNodeSolidFill).color).toBe('#aabbcc')
    expect(adapter.fill).toBe('#aabbcc')
    expect(r.strokes).toHaveLength(1)
    expect(r.strokes[0].color).toBe('#ddeeff')
    expect(adapter.stroke).toBe('#ddeeff')
  })
})

// --- FU-1: fallback parity vs canvasRenderAdapter firstSolidFillFor/firstStrokeFor ---
//
// #72 事后批审 P2 指出：当时只测了 frame 的 invisible solid fill 这一条 fallback
// 路径。补全矩阵——markup/frame 的 fills/strokes 非空但不满足 "visible solid" /
// "visible stroke" 判据时，projection 必须与 canvasRenderAdapter 的
// firstSolidFillFor / firstStrokeFor 同判据地补缺省。每组都是 projection vs
// adapter 的对照断言，锁两实现、防迁移漂移。

describe('projectNode — fallback parity vs canvasRenderAdapter (FU-1)', () => {
  it('markup: fills all hidden → sinks synthetic default fill (matches adapter firstSolidFillFor)', () => {
    const node = markupNode({
      fills: [{ id: 'hidden-solid', kind: 'solid', color: '#aabbcc', opacity: 1, visible: false }],
    })
    const r = projectNode(node)
    const adapter = markupRenderStyleFor(node)
    // adapter firstSolidFillFor skips invisible solids → markupFillColor || default
    expect(adapter.fill).toBe('rgba(105, 87, 232, 0.08)')
    expect(r.fills).toHaveLength(2)
    const synthetic = r.fills[1] as CanvasNodeSolidFill
    expect(synthetic.kind).toBe('solid')
    expect(synthetic.visible).toBe(true)
    expect(synthetic.color).toBe('rgba(105, 87, 232, 0.08)')
    expect(synthetic.color).toBe(adapter.fill)
  })

  it('markup: fills only image (no solid) → sinks synthetic default fill (adapter firstSolidFillFor skips image)', () => {
    const node = markupNode({
      fills: [{ id: 'img-fill', kind: 'image', assetUrl: 'https://example.com/x.png', opacity: 1, visible: true, scaleMode: 'fill' }],
    })
    const r = projectNode(node)
    const adapter = markupRenderStyleFor(node)
    // adapter firstSolidFillFor only matches kind:'solid' → visible image fill is skipped → fallback
    expect(adapter.fill).toBe('rgba(105, 87, 232, 0.08)')
    expect(r.fills).toHaveLength(2)
    expect((r.fills[1] as CanvasNodeSolidFill).color).toBe('rgba(105, 87, 232, 0.08)')
    expect((r.fills[1] as CanvasNodeSolidFill).color).toBe(adapter.fill)
    // The original image fill is preserved (not dropped) — projection clones it through.
    expect(r.fills[0]).toEqual(expect.objectContaining({ id: 'img-fill', kind: 'image' }))
  })

  it('markup: strokes all hidden → sinks synthetic default stroke (matches adapter firstStrokeFor)', () => {
    const node = markupNode({
      strokes: [{ id: 'hidden-stroke', color: '#abcdef', width: 5, style: 'solid', opacity: 1, visible: false }],
    })
    const r = projectNode(node)
    const adapter = markupRenderStyleFor(node)
    // adapter firstStrokeFor skips invisible strokes → markupStrokeColor || default
    expect(adapter.stroke).toBe('#6957e8')
    expect(r.strokes).toHaveLength(2)
    const synthetic = r.strokes[1]
    expect(synthetic.visible).toBe(true)
    expect(synthetic.color).toBe('#6957e8')
    expect(synthetic.color).toBe(adapter.stroke)
    expect(synthetic.width).toBe(adapter.strokeWidth)
    expect(synthetic.style).toBe(adapter.strokeStyle)
  })

  it('frame: strokes all hidden → sinks synthetic default stroke (matches adapter firstStrokeFor)', () => {
    const node = frameNode({
      fills: [],
      strokes: [{ id: 'hidden-stroke', color: '#abcdef', width: 9, style: 'solid', opacity: 1, visible: false }],
    })
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)
    // adapter firstStrokeFor skips invisible → sectionBorderColor || frameColor || '#ff8a00'
    expect(adapter['--section-border-color']).toBe('#ff8a00')
    expect(r.strokes).toHaveLength(2)
    const synthetic = r.strokes[1]
    expect(synthetic.visible).toBe(true)
    expect(synthetic.color).toBe('#ff8a00')
    expect(synthetic.color).toBe(adapter['--section-border-color'])
    expect(synthetic.width).toBe(Number(adapter['--section-border-width'].replace('px', '')))
    expect(synthetic.style).toBe(adapter['--section-border-style'])
  })

  it('frame: fills only a visible image fill (no solid) → both sides skip image and use fallback (parity)', () => {
    const node = frameNode({
      fills: [{ id: 'img-fill', kind: 'image', assetUrl: 'https://example.com/y.png', opacity: 1, visible: true, scaleMode: 'fill' }],
      strokes: [],
    })
    const r = projectNode(node)
    const adapter = frameRenderStyleFor(node)
    // adapter firstSolidFillFor only matches kind:'solid' → visible image fill skipped → '#ffffff'
    expect(adapter['--section-fill-color']).toBe('#ffffff')
    expect(r.fills).toHaveLength(2)
    // Original image fill preserved; synthetic solid appended.
    expect(r.fills[0]).toEqual(expect.objectContaining({ id: 'img-fill', kind: 'image' }))
    const synthetic = r.fills[1] as CanvasNodeSolidFill
    expect(synthetic.kind).toBe('solid')
    expect(synthetic.visible).toBe(true)
    expect(synthetic.color).toBe('#ffffff')
    expect(synthetic.color).toBe(adapter['--section-fill-color'])
  })
})

describe('projectNode — non-frame/non-markup nodes get NO synthetic defaults', () => {
  it('image node with no fills/strokes stays empty (no product-default pollution)', () => {
    const node: MivoCanvasNode = {
      id: 'img-1', type: 'image', title: 'I', status: 'ready',
      x: 0, y: 0, width: 10, height: 10,
    }
    const r = projectNode(node)
    expect(r.fills).toHaveLength(0)
    expect(r.strokes).toHaveLength(0)
  })

  it('text node with no fills/strokes stays empty', () => {
    const node: MivoCanvasNode = {
      id: 'text-1', type: 'text', title: 'T', status: 'ready',
      x: 0, y: 0, width: 10, height: 10,
      text: 'hi',
    }
    const r = projectNode(node)
    expect(r.fills).toHaveLength(0)
    expect(r.strokes).toHaveLength(0)
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

describe('projectNode — z-order defaults (2b-2: layer / renderOrder / surface)', () => {
  it('frame → Layer.Frame; non-frame → Layer.Content (stamp 留在 Content，靠 renderOrder 胜出)', () => {
    expect(projectNode(v2ImageNode({ type: 'frame' })).layer).toBe(Layer.Frame)
    expect(projectNode(v2ImageNode()).layer).toBe(Layer.Content)
    expect(projectNode(v2ImageNode({ type: 'text' })).layer).toBe(Layer.Content)
    expect(projectNode(v2ImageNode({ type: 'markup' })).layer).toBe(Layer.Content)
    expect(projectNode(v2ImageNode({ type: 'markup', markupKind: 'stamp' })).layer).toBe(Layer.Content)
  })

  it('renderOrder: stamp → 1 (paints + hit-tests above every other Content node incl. a selected image); 其余 → 0', () => {
    // 非 stamp 全部 0（image / text / markup-rect / markup-brush / frame）
    expect(projectNode(v2ImageNode()).renderOrder).toBe(0)
    expect(projectNode(v2ImageNode({ type: 'text' })).renderOrder).toBe(0)
    expect(projectNode(v2ImageNode({ type: 'markup', markupKind: 'rect' })).renderOrder).toBe(0)
    expect(projectNode(v2ImageNode({ type: 'markup', markupKind: 'brush' })).renderOrder).toBe(0)
    expect(projectNode(v2ImageNode({ type: 'frame' })).renderOrder).toBe(0)
    // stamp 留在 Layer.Content（不抬档），靠 renderOrder=1 胜出
    const stamp = projectNode(v2ImageNode({ type: 'markup', markupKind: 'stamp' }))
    expect(stamp.layer).toBe(Layer.Content)
    expect(stamp.renderOrder).toBe(1)
    // 关键语义：renderOrder 先于 selected 比较（defaultZOrderCompare），故 stamp
    // (renderOrder 1, 未选) 仍高于 selected image (renderOrder 0, 已选) —— 三轨一致
    const selectedImage = projectNode(v2ImageNode({ id: 'img' }), { selectedNodeIds: new Set(['img']) })
    expect(selectedImage.selected).toBe(true)
    expect(selectedImage.renderOrder).toBe(0)
    expect(stamp.renderOrder).toBeGreaterThan(selectedImage.renderOrder)
  })

  it('surface defaults to "canvas"', () => {
    expect(projectNode(v2ImageNode()).surface).toBe('canvas')
  })

  it('model does NOT carry layer/renderOrder/surface (persistence boundary)', () => {
    // projectNode adds these on the render side; normalizeCanvasNodeV2 (the model)
    // must not — they are render-only, NOT in documentModelV2. Keeps persistence
    // free of render-layer policy (red line, review P2-1).
    const n = normalizeCanvasNodeV2(v2ImageNode()) as Record<string, unknown>
    expect(n.layer).toBeUndefined()
    expect(n.renderOrder).toBeUndefined()
    expect(n.surface).toBeUndefined()
  })

  it('RenderNode exposes layer/renderOrder/surface as typed fields', () => {
    const r = projectNode(v2ImageNode())
    expect(typeof r.layer).toBe('number')
    expect(typeof r.renderOrder).toBe('number')
    expect(r.surface).toMatch(/^(canvas|overlay)$/)
  })
})
