import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
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
