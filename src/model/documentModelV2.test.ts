import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  cloneCanvasNodeV2,
  normalizeCanvasNodeV2,
  normalizeCanvasNodesV2,
  setNodeAsset,
  setNodeFills,
  setNodeRelations,
  setNodeStrokes,
  setNodeTransform,
} from './documentModelV2'

const baseNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'node-1',
  type: 'image',
  title: 'Source image',
  x: 12,
  y: 24,
  width: 320,
  height: 240,
  status: 'ready',
  ...overrides,
})

describe('documentModelV2 normalization', () => {
  it('derives semantic transform and image asset fields from a legacy image node', () => {
    const node = normalizeCanvasNodeV2(
      baseNode({
        assetUrl: 'mivo-imported-asset://asset-1',
        assetMimeType: 'image/png',
        assetOriginalName: 'source.png',
        assetSizeBytes: 2048,
      }),
    )

    expect(node.transform).toEqual({
      x: 12,
      y: 24,
      width: 320,
      height: 240,
      rotation: 0,
    })
    expect(node.asset).toEqual({
      url: 'mivo-imported-asset://asset-1',
      mimeType: 'image/png',
      originalName: 'source.png',
      sizeBytes: 2048,
    })
    expect(node.fills).toEqual([
      {
        id: 'node-1-image-fill',
        kind: 'image',
        assetUrl: 'mivo-imported-asset://asset-1',
        opacity: 1,
        visible: true,
        scaleMode: 'fill',
      },
    ])
  })

  it('derives frame and markup paint semantics from legacy style fields', () => {
    const frame = normalizeCanvasNodeV2(
      baseNode({
        type: 'frame',
        sectionFillColor: '#ffffff',
        sectionBorderColor: '#ff8a00',
        sectionBorderWidth: 2,
        sectionBorderStyle: 'dashed',
      }),
    )
    const markup = normalizeCanvasNodeV2(
      baseNode({
        type: 'markup',
        markupFillColor: 'rgba(105, 87, 232, 0.08)',
        markupStrokeColor: '#6957e8',
        markupStrokeWidth: 3,
        markupStrokeStyle: 'solid',
        markupOpacity: 0.6,
      }),
    )

    expect(frame.fills?.[0]).toMatchObject({ kind: 'solid', color: '#ffffff' })
    expect(frame.strokes?.[0]).toMatchObject({ color: '#ff8a00', width: 2, style: 'dashed' })
    expect(markup.fills?.[0]).toMatchObject({ kind: 'solid', color: 'rgba(105, 87, 232, 0.08)' })
    expect(markup.strokes?.[0]).toMatchObject({ color: '#6957e8', width: 3, style: 'solid', opacity: 0.6 })
  })

  it('derives relations from legacy parent, section, target, connector, and AI workflow fields', () => {
    const node = normalizeCanvasNodeV2(
      baseNode({
        parentIds: ['parent-1'],
        sectionId: 'section-1',
        targetNodeId: 'target-1',
        connectorStart: { nodeId: 'source-1', anchor: 'right' },
        connectorEnd: { nodeId: 'target-2', anchor: 'left' },
        aiWorkflow: {
          kind: 'result',
          operation: 'annotation-edit',
          sourceNodeIds: ['source-2'],
          annotationNodeId: 'annotation-1',
        },
      }),
    )

    expect(node.relations).toEqual({
      parentIds: ['parent-1'],
      sectionId: 'section-1',
      targetNodeId: 'target-1',
      connectorStart: { nodeId: 'source-1', anchor: 'right' },
      connectorEnd: { nodeId: 'target-2', anchor: 'left' },
      aiWorkflow: {
        kind: 'result',
        operation: 'annotation-edit',
        sourceNodeIds: ['source-2'],
        annotationNodeId: 'annotation-1',
      },
    })
    expect(node.relations?.parentIds).not.toBe(node.parentIds)
    expect(node.relations?.aiWorkflow?.sourceNodeIds).not.toBe(node.aiWorkflow?.sourceNodeIds)
  })

  it('normalizes node arrays without mutating the original nodes', () => {
    const nodes = [baseNode()]
    const normalized = normalizeCanvasNodesV2(nodes)

    expect(normalized).not.toBe(nodes)
    expect(normalized[0]).not.toBe(nodes[0])
    expect(nodes[0].transform).toBeUndefined()
    expect(normalized[0].transform?.width).toBe(320)
  })
})

describe('documentModelV2 commands', () => {
  it('sets transform while keeping legacy geometry synchronized', () => {
    const node = setNodeTransform(baseNode(), { x: 40, y: 52, width: 400, height: 260, rotation: 15 })

    expect(node.transform).toEqual({ x: 40, y: 52, width: 400, height: 260, rotation: 15 })
    expect(node).toMatchObject({ x: 40, y: 52, width: 400, height: 260 })
  })

  it('sets fills, strokes, asset, and relations immutably with legacy bridge fields', () => {
    const source = baseNode({ type: 'markup', parentIds: ['old-parent'] })
    const withFills = setNodeFills(source, [{ id: 'fill-1', kind: 'solid', color: '#123456', opacity: 0.5, visible: true }])
    const withStrokes = setNodeStrokes(withFills, [{ id: 'stroke-1', color: '#654321', width: 4, style: 'dashed', opacity: 0.75, visible: true }])
    const withAsset = setNodeAsset(withStrokes, { url: '/asset.png', mimeType: 'image/png', originalName: 'asset.png', sizeBytes: 128 })
    const withRelations = setNodeRelations(withAsset, {
      parentIds: ['parent-1'],
      sectionId: 'section-1',
      connectorStart: { nodeId: 'from-1', anchor: 'center' },
    })

    expect(source.fills).toBeUndefined()
    expect(withRelations.fills?.[0]).toMatchObject({ color: '#123456' })
    expect(withRelations.markupFillColor).toBe('#123456')
    expect(withRelations.strokes?.[0]).toMatchObject({ color: '#654321', width: 4, style: 'dashed' })
    expect(withRelations.markupStrokeColor).toBe('#654321')
    expect(withRelations.markupStrokeWidth).toBe(4)
    expect(withRelations.markupStrokeStyle).toBe('dashed')
    expect(withRelations.assetUrl).toBe('/asset.png')
    expect(withRelations.assetOriginalName).toBe('asset.png')
    expect(withRelations.parentIds).toEqual(['parent-1'])
    expect(withRelations.sectionId).toBe('section-1')
    expect(withRelations.connectorStart).toEqual({ nodeId: 'from-1', anchor: 'center' })
  })
})

describe('documentModelV2 fast-path predicate (R01 commit #2)', () => {
  // Locks isNormalizedCanvasNodeV2: when the node is already normalized, normalize
  // returns the SAME reference (toBe) — zero allocation, no sub-object rebuild. Any
  // half-normalized / legacy-shaped / malformed node must fall through to the full
  // rebuild (new reference, value corrected). cloneCanvasNodeV2 always rebuilds.

  // --- ① idempotency: normalize(once) === once (same reference) ---
  const normalizedImage = (): MivoCanvasNode =>
    normalizeCanvasNodeV2(
      baseNode({
        assetUrl: 'mivo-imported-asset://asset-1',
        assetMimeType: 'image/png',
        assetOriginalName: 'source.png',
        assetSizeBytes: 2048,
      }),
    )
  const normalizedFrame = (): MivoCanvasNode =>
    normalizeCanvasNodeV2(
      baseNode({
        type: 'frame',
        sectionFillColor: '#ffffff',
        sectionBorderColor: '#ff8a00',
        sectionBorderWidth: 2,
        sectionBorderStyle: 'dashed',
      }),
    )
  const normalizedMarkup = (): MivoCanvasNode =>
    normalizeCanvasNodeV2(
      baseNode({
        type: 'markup',
        markupFillColor: 'rgba(105, 87, 232, 0.08)',
        markupStrokeColor: '#6957e8',
        markupStrokeWidth: 3,
        markupStrokeStyle: 'solid',
        markupOpacity: 0.6,
        markupKind: 'rect',
      }),
    )
  const normalizedText = (): MivoCanvasNode =>
    normalizeCanvasNodeV2(baseNode({ type: 'text', text: 'hello' }))

  it('① returns the same reference for an already-normalized image node', () => {
    const once = normalizedImage()
    expect(normalizeCanvasNodeV2(once)).toBe(once)
  })
  it('① returns the same reference for an already-normalized frame node', () => {
    const once = normalizedFrame()
    expect(normalizeCanvasNodeV2(once)).toBe(once)
  })
  it('① returns the same reference for an already-normalized markup node', () => {
    const once = normalizedMarkup()
    expect(normalizeCanvasNodeV2(once)).toBe(once)
  })
  it('① returns the same reference for an already-normalized text node', () => {
    const once = normalizedText()
    expect(normalizeCanvasNodeV2(once)).toBe(once)
  })

  // --- ② empty-array idempotency: fills:[]/strokes:[] do NOT trigger synthesis ---
  it('② frame fills:[] + sectionFillColor stays [] and is idempotent (not synthesized)', () => {
    const source = baseNode({
      type: 'frame',
      fills: [],
      strokes: [{ id: 's1', color: '#000', width: 1, style: 'solid', opacity: 1, visible: true }],
      sectionFillColor: '#ffffff',
    })
    const once = normalizeCanvasNodeV2(source)
    expect(once.fills).toEqual([])
    expect(normalizeCanvasNodeV2(once)).toBe(once)
    expect(once.fills).toEqual([])
  })
  it('② frame strokes:[] + sectionBorderColor stays [] and is idempotent', () => {
    const source = baseNode({
      type: 'frame',
      strokes: [],
      fills: [{ id: 'f1', kind: 'solid', color: '#fff', opacity: 1, visible: true }],
      sectionBorderColor: '#ff8a00',
      sectionBorderWidth: 2,
    })
    const once = normalizeCanvasNodeV2(source)
    expect(once.strokes).toEqual([])
    expect(normalizeCanvasNodeV2(once)).toBe(once)
    expect(once.strokes).toEqual([])
  })
  it('② markup fills:[] + markupFillColor stays [] and is idempotent', () => {
    const source = baseNode({
      type: 'markup',
      markupKind: 'rect',
      fills: [],
      strokes: [{ id: 's1', color: '#000', width: 1, style: 'solid', opacity: 1, visible: true }],
      markupFillColor: 'rgba(105, 87, 232, 0.08)',
    })
    const once = normalizeCanvasNodeV2(source)
    expect(once.fills).toEqual([])
    expect(normalizeCanvasNodeV2(once)).toBe(once)
  })
  it('② markup strokes:[] + markupStrokeColor stays [] and is idempotent', () => {
    const source = baseNode({
      type: 'markup',
      markupKind: 'rect',
      strokes: [],
      fills: [{ id: 'f1', kind: 'solid', color: '#fff', opacity: 1, visible: true }],
      markupStrokeColor: '#6957e8',
      markupStrokeWidth: 3,
    })
    const once = normalizeCanvasNodeV2(source)
    expect(once.strokes).toEqual([])
    expect(normalizeCanvasNodeV2(once)).toBe(once)
  })

  // --- ③ semi-normalized guards: new reference + value corrected ---
  it('③ transform present but legacy x stale → new object, x rewritten from transform', () => {
    const stale = baseNode({ x: 999, transform: { x: 10, y: 24, width: 320, height: 240, rotation: 0 } })
    const result = normalizeCanvasNodeV2(stale)
    expect(result).not.toBe(stale)
    expect(result.x).toBe(10)
    expect(result.transform?.x).toBe(10)
  })
  it('③ transform missing rotation → new object, rotation filled as 0', () => {
    const noRotation = baseNode({ transform: { x: 12, y: 24, width: 320, height: 240 } } as MivoCanvasNode)
    const result = normalizeCanvasNodeV2(noRotation)
    expect(result).not.toBe(noRotation)
    expect(result.transform?.rotation).toBe(0)
  })
  it('③ frame without fills but with sectionFillColor → synthesizes a solid fill', () => {
    const source = baseNode({ type: 'frame', sectionFillColor: '#abc' })
    const result = normalizeCanvasNodeV2(source)
    expect(result).not.toBe(source)
    expect(result.fills?.[0]).toMatchObject({ kind: 'solid', color: '#abc' })
  })
  it('③ image without asset but with assetUrl → synthesizes asset', () => {
    const source = baseNode({ assetUrl: 'mivo-imported-asset://x' })
    const result = normalizeCanvasNodeV2(source)
    expect(result).not.toBe(source)
    expect(result.asset).toMatchObject({ url: 'mivo-imported-asset://x' })
  })
  it('③ node without relations but with sectionId → synthesizes relations', () => {
    const source = baseNode({ sectionId: 'sec-1' })
    const result = normalizeCanvasNodeV2(source)
    expect(result).not.toBe(source)
    expect(result.relations?.sectionId).toBe('sec-1')
  })

  // --- ④ malformed fields fall through to full path (old behavior preserved) ---
  it('④ fills:null → normalized to undefined (or synthetic) and not the same reference', () => {
    const source = baseNode({ fills: null as unknown as undefined })
    const result = normalizeCanvasNodeV2(source)
    expect(result).not.toBe(source)
    // image with no assetUrl, no sectionFillColor → fills normalized to undefined
    expect(result.fills).toBeUndefined()
  })
  it('④ fills:{} (non-array) → throws, matching the old path (not silently swallowed)', () => {
    const source = baseNode({ fills: {} as unknown as undefined })
    expect(() => normalizeCanvasNodeV2(source)).toThrow()
  })

  // --- ⑤ setNodeTransform output is already normalized (idempotent) ---
  it('⑤ setNodeTransform output satisfies the fast-path predicate (idempotent)', () => {
    const moved = setNodeTransform(baseNode(), { x: 40, y: 52, width: 400, height: 260, rotation: 15 })
    expect(normalizeCanvasNodeV2(moved)).toBe(moved)
  })

  // --- ⑥ clone vs normalize bifurcation: clone ALWAYS rebuilds, even on normalized input ---
  it('⑥ cloneCanvasNodeV2 on an already-normalized node still produces fresh sub-objects', () => {
    // Use a node whose normalization yields fills + asset + relations (all non-undefined)
    // so clone's rebuild of each is directly observable. (Image with assetUrl + parentIds
    // synthesizes all three sub-objects during normalization.)
    const once = normalizeCanvasNodeV2(
      baseNode({
        assetUrl: 'mivo-imported-asset://asset-1',
        assetMimeType: 'image/png',
        assetOriginalName: 'source.png',
        assetSizeBytes: 2048,
        parentIds: ['parent-1'],
      }),
    )
    // sanity: once is normalized (fast-path returns same ref) and has the sub-objects
    expect(normalizeCanvasNodeV2(once)).toBe(once)
    expect(once.fills).toBeDefined()
    expect(once.asset).toBeDefined()
    expect(once.relations).toBeDefined()

    const clone = cloneCanvasNodeV2(once)
    expect(clone).not.toBe(once)
    expect(clone.fills).not.toBe(once.fills)
    expect(clone.asset).not.toBe(once.asset)
    expect(clone.relations).not.toBe(once.relations)
  })
})
