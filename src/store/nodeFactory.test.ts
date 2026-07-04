import { describe, expect, it, vi } from 'vitest'
import {
  cloneEdge,
  cloneNode,
  cloneTask,
  createCanvasId,
  createDerivationEdgeNode,
  createEdgeId,
  createGenerationResultNode,
  createGroupId,
  createNodeId,
  createNodeCopy,
  edgeTypeForOperation,
  isDerivationEdgeNode,
} from './nodeFactory'
import type { CanvasEdge, MivoCanvasNode } from '../types/mivoCanvas'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'

// Helpers ---------------------------------------------------------------------

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  ...overrides,
})

// Tests -----------------------------------------------------------------------

describe('cloneNode (geometry clone + deep isolation)', () => {
  it('preserves geometry and core fields', () => {
    const source = imageNode({ id: 'a', x: 5, y: 7, width: 120, height: 90, title: 'T' })
    const clone = cloneNode(source)

    expect(clone.id).toBe('a')
    expect(clone.x).toBe(5)
    expect(clone.y).toBe(7)
    expect(clone.width).toBe(120)
    expect(clone.height).toBe(90)
    expect(clone.title).toBe('T')
    expect(clone.type).toBe('image')
    expect(clone.status).toBe('ready')
  })

  it('deep-clones parentIds so later source mutation does not leak', () => {
    const source = imageNode({ id: 'a', parentIds: ['p1', 'p2'] })
    const clone = cloneNode(source)
    source.parentIds!.push('p3')

    expect(clone.parentIds).toEqual(['p1', 'p2'])
    expect(clone.parentIds).not.toBe(source.parentIds)
  })

  it('deep-clones generation.maskBounds', () => {
    const source = imageNode({
      id: 'a',
      generation: { prompt: 'p', model: 'm', maskBounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } },
    })
    const clone = cloneNode(source)
    source.generation!.maskBounds!.x = 0.99

    expect(clone.generation?.maskBounds?.x).toBe(0.1)
    expect(clone.generation?.maskBounds).not.toBe(source.generation?.maskBounds)
  })

  it('deep-clones aiWorkflow.sourceNodeIds', () => {
    const source = imageNode({
      id: 'a',
      aiWorkflow: { kind: 'result', sourceNodeIds: ['s1'] },
    })
    const clone = cloneNode(source)
    source.aiWorkflow!.sourceNodeIds!.push('s2')

    expect(clone.aiWorkflow?.sourceNodeIds).toEqual(['s1'])
    expect(clone.aiWorkflow?.sourceNodeIds).not.toBe(source.aiWorkflow?.sourceNodeIds)
  })

  it('deep-clones markupPoints entries', () => {
    const source: MivoCanvasNode = {
      id: 'm1',
      type: 'markup',
      title: 'M',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      status: 'ready',
      markupKind: 'brush',
      markupPoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    }
    const clone = cloneNode(source)
    source.markupPoints!.push({ x: 9, y: 9 })
    source.markupPoints![0].x = 99

    expect(clone.markupPoints).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }])
    expect(clone.markupPoints).not.toBe(source.markupPoints)
  })

  it('handles absent optional nested fields without throwing', () => {
    const clone = cloneNode(imageNode({ id: 'a' }))
    expect(clone.markupPoints).toBeUndefined()
    expect(clone.generation).toBeUndefined()
    expect(clone.aiWorkflow).toBeUndefined()
    expect(clone.parentIds).toBeUndefined()
  })

  // P2-D1 — experimentalAnchors deep-copy + light validation (the cloneNode fix).
  it('deep-clones experimentalAnchors so history/clipboard/persist copies are isolated', () => {
    const source = imageNode({
      id: 'a',
      experimentalAnchors: [
        { id: 'an1', type: 'point', targetNodeId: 'a', x: 1, y: 2, instruction: 'i', createdAt: 1 },
        {
          id: 'an2',
          type: 'box',
          targetNodeId: 'a',
          x: 1,
          y: 2,
          width: 10,
          height: 20,
          instruction: 'i',
          createdAt: 2,
          resultNodeIds: ['r1'],
        },
      ],
    })
    const clone = cloneNode(source)

    expect(clone.experimentalAnchors).not.toBe(source.experimentalAnchors)
    expect(clone.experimentalAnchors![0]).not.toBe(source.experimentalAnchors![0])
    expect(clone.experimentalAnchors![1]).not.toBe(source.experimentalAnchors![1])
    expect(clone.experimentalAnchors![1].resultNodeIds).not.toBe(source.experimentalAnchors![1].resultNodeIds)

    // mutate the source after clone; clone must be unaffected
    source.experimentalAnchors!.push({
      id: 'an3',
      type: 'point',
      targetNodeId: 'a',
      x: 0,
      y: 0,
      instruction: 'x',
      createdAt: 3,
    })
    source.experimentalAnchors![0].instruction = 'changed'

    expect(clone.experimentalAnchors).toHaveLength(2)
    expect(clone.experimentalAnchors![0].instruction).toBe('i')
  })

  it('drops a box anchor missing width/height during clone (light validation + warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = imageNode({
      id: 'a',
      experimentalAnchors: [
        { id: 'good', type: 'point', targetNodeId: 'a', x: 1, y: 2, instruction: 'i', createdAt: 1 },
        { id: 'bad', type: 'box', targetNodeId: 'a', x: 1, y: 2, instruction: 'i', createdAt: 2 }, // box missing w/h
      ],
    })
    const clone = cloneNode(source)

    expect(clone.experimentalAnchors).toHaveLength(1)
    expect(clone.experimentalAnchors![0].id).toBe('good')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('leaves experimentalAnchors undefined for a bare node', () => {
    const clone = cloneNode(imageNode({ id: 'a' }))
    expect(clone.experimentalAnchors).toBeUndefined()
  })
})

describe('cloneNode — deep-copy contract for the seven normalized sub-objects', () => {
  // Locks the commit #1 split: cloneNode must call cloneCanvasNodeV2 (always full
  // rebuild), NOT normalizeCanvasNodeV2 (which gains a return-same-reference fast
  // path in commit #2). history / clipboard / persist rely on every sub-object being
  // a fresh clone — if cloneNode ever shared a sub-object reference with the source, a
  // later source mutation would leak into the clone. The seven sub-objects: fills,
  // strokes, effects, layout, constraints, asset, relations (with nested parentIds /
  // connectorStart / aiWorkflow.sourceNodeIds).
  const buildOnce = (): MivoCanvasNode => {
    const source: MivoCanvasNode = {
      id: 'clone-src',
      type: 'frame',
      title: 'Clone source',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      status: 'ready',
      transform: { x: 10, y: 20, width: 300, height: 200, rotation: 0 },
      fills: [{ id: 'fill-1', kind: 'solid', color: '#123456', opacity: 0.5, visible: true }],
      strokes: [{ id: 'stroke-1', color: '#654321', width: 4, style: 'dashed', opacity: 0.75, visible: true }],
      effects: [{ id: 'effect-1', kind: 'shadow', color: '#000000', x: 2, y: 2, blur: 4, spread: 0, opacity: 0.5, visible: true }],
      layout: { mode: 'auto', direction: 'horizontal', gap: 8, padding: { top: 1, right: 2, bottom: 3, left: 4 } },
      constraints: { horizontal: 'left', vertical: 'top' },
      asset: { url: '/asset.png', mimeType: 'image/png', originalName: 'asset.png', sizeBytes: 128 },
      relations: {
        parentIds: ['parent-1'],
        sectionId: 'section-1',
        connectorStart: { nodeId: 'from-1', anchor: 'center' },
        aiWorkflow: { kind: 'result', sourceNodeIds: ['source-2'] },
      },
    }
    return normalizeCanvasNodeV2(source)
  }

  it('produces fresh references for all seven sub-objects (not shared with the source)', () => {
    const once = buildOnce()
    const clone = cloneNode(once)

    expect(clone.fills).not.toBe(once.fills)
    expect(clone.strokes).not.toBe(once.strokes)
    expect(clone.effects).not.toBe(once.effects)
    expect(clone.layout).not.toBe(once.layout)
    expect(clone.constraints).not.toBe(once.constraints)
    expect(clone.asset).not.toBe(once.asset)
    expect(clone.relations).not.toBe(once.relations)
  })

  it('produces fresh references for nested relations fields (parentIds / connectorStart / aiWorkflow.sourceNodeIds)', () => {
    const once = buildOnce()
    const clone = cloneNode(once)

    expect(clone.relations?.parentIds).not.toBe(once.relations?.parentIds)
    expect(clone.relations?.connectorStart).not.toBe(once.relations?.connectorStart)
    expect(clone.relations?.aiWorkflow?.sourceNodeIds).not.toBe(once.relations?.aiWorkflow?.sourceNodeIds)
  })

  it('isolates mutations: changing the source after clone does not leak into the clone', () => {
    const once = buildOnce()
    const clone = cloneNode(once)

    ;(once.fills![0] as { color: string }).color = '#ff0000'
    once.relations!.parentIds!.push('parent-2')
    once.layout!.padding!.top = 99

    expect((clone.fills![0] as { color: string }).color).toBe('#123456')
    expect(clone.relations?.parentIds).toEqual(['parent-1'])
    expect(clone.layout?.padding?.top).toBe(1)
  })

  it('is value-equal to the source (deep)', () => {
    const once = buildOnce()
    const clone = cloneNode(once)

    expect(clone).toEqual(once)
  })
})

describe('cloneEdge / cloneTask', () => {
  it('cloneEdge returns an independent copy', () => {
    const edge: CanvasEdge = { id: 'e1', from: 'a', to: 'b', type: 'generate', prompt: 'p', createdAt: 1 }
    const clone = cloneEdge(edge)
    expect(clone).toEqual(edge)
    expect(clone).not.toBe(edge)
  })

  it('cloneTask deep-clones nodeIds', () => {
    const task = { id: 't1', label: 'l', status: 'done' as const, progress: 100, nodeIds: ['a', 'b'] }
    const clone = cloneTask(task)
    task.nodeIds.push('c')
    expect(clone.nodeIds).toEqual(['a', 'b'])
    expect(clone.nodeIds).not.toBe(task.nodeIds)
  })
})

describe('id uniqueness', () => {
  it('createNodeId embeds the prefix and yields unique ids across calls', () => {
    const a = createNodeId('img')
    const b = createNodeId('img')
    expect(a.startsWith('img-')).toBe(true)
    expect(b.startsWith('img-')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('createEdgeId / createGroupId / createCanvasId return uniquely-prefixed unique ids', () => {
    const edgeIds = new Set(Array.from({ length: 20 }, () => createEdgeId()))
    const groupIds = new Set(Array.from({ length: 20 }, () => createGroupId()))
    const canvasIds = new Set(Array.from({ length: 20 }, () => createCanvasId()))

    expect(edgeIds.size).toBe(20)
    expect(groupIds.size).toBe(20)
    expect(canvasIds.size).toBe(20)
    expect([...edgeIds][0].startsWith('edge-')).toBe(true)
    expect([...groupIds][0].startsWith('group-')).toBe(true)
    expect([...canvasIds][0].startsWith('canvas-')).toBe(true)
  })

  it('createNodeCopy yields distinct ids for distinct indices (real paste-loop usage)', () => {
    const source = imageNode({ id: 'src' })
    // createNodeCopy ids are `${source.id}-copy-${Date.now()}-${index}` — uniqueness across
    // a paste loop comes from the varying index (the real call site), not from Math.random.
    const copy0 = createNodeCopy(source, 0)
    const copy1 = createNodeCopy(source, 1)
    const copy2 = createNodeCopy(source, 2)
    expect(copy0.id).not.toBe(copy1.id)
    expect(copy1.id).not.toBe(copy2.id)
    expect(copy0.id).not.toBe(source.id)
    expect(copy0.id.startsWith('src-copy-')).toBe(true)
    expect(copy0.id.endsWith('-0')).toBe(true)
    expect(copy1.id.endsWith('-1')).toBe(true)
  })
})

describe('createNodeCopy (geometry + linkage reset)', () => {
  it('offsets geometry by the default offset and clears linkage fields', () => {
    const source = imageNode({ id: 'src', x: 100, y: 200, groupId: 'g', sectionId: 's' })
    const copy = createNodeCopy(source, 0)

    expect(copy.x).toBe(128) // 100 + default 28
    expect(copy.y).toBe(228) // 200 + default 28
    expect(copy.title).toBe('Image Copy')
    expect(copy.groupId).toBeUndefined()
    expect(copy.sectionId).toBeUndefined()
    expect(copy.connectorStart).toBeUndefined()
    expect(copy.connectorEnd).toBeUndefined()
    expect(copy.hidden).toBeUndefined()
  })

  it('respects a custom offset', () => {
    const source = imageNode({ id: 'src', x: 0, y: 0 })
    const copy = createNodeCopy(source, 1, 100)
    expect(copy.x).toBe(100)
    expect(copy.y).toBe(100)
  })

  it('applies overrides last (wins over derived fields)', () => {
    const source = imageNode({ id: 'src', x: 0, y: 0 })
    const copy = createNodeCopy(source, 0, 28, { x: 500, title: 'Custom' })
    expect(copy.x).toBe(500)
    expect(copy.title).toBe('Custom')
  })
})

describe('createDerivationEdgeNode (衍生边节点构造)', () => {
  const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
  const target = imageNode({ id: 'tgt', x: 300, y: 0, width: 100, height: 100 })
  const edge: CanvasEdge = { id: 'e1', from: 'src', to: 'tgt', type: 'generate', prompt: 'p', createdAt: 1 }

  it('returns undefined when the source node is missing', () => {
    expect(createDerivationEdgeNode({ ...edge, from: 'missing' }, [source, target])).toBeUndefined()
  })

  it('returns undefined when the target node is missing', () => {
    expect(createDerivationEdgeNode({ ...edge, to: 'missing' }, [source, target])).toBeUndefined()
  })

  it('returns undefined when the source is hidden', () => {
    const hidden = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100, hidden: true })
    expect(createDerivationEdgeNode(edge, [hidden, target])).toBeUndefined()
  })

  it('builds a locked markup arrow node tagged with the derivation edge model', () => {
    const node = createDerivationEdgeNode(edge, [source, target])
    expect(node).toBeDefined()
    if (!node) return

    expect(node.id).toBe('derivation-e1')
    expect(node.type).toBe('markup')
    expect(node.markupKind).toBe('arrow')
    expect(node.status).toBe('ready')
    expect(node.locked).toBe(true)
    expect(node.generation?.model).toBe('Mivo Derivation Edge')
    expect(node.generation?.prompt).toBe('p')
    expect(node.generation?.createdAt).toBe(1)
    expect(node.markupEndArrow).toBe(true)
    expect(node.markupStartArrow).toBe(false)
  })

  it('uses the edit title for edit edges and the generation title otherwise', () => {
    const editNode = createDerivationEdgeNode({ ...edge, type: 'edit' }, [source, target])
    const genNode = createDerivationEdgeNode(edge, [source, target])
    expect(editNode?.title).toBe('Edit derivation')
    expect(genNode?.title).toBe('Generation derivation')
  })

  it('produces non-trivial geometry (width/height at least 24)', () => {
    const node = createDerivationEdgeNode(edge, [source, target])
    expect(node).toBeDefined()
    if (!node) return
    expect(node.width).toBeGreaterThanOrEqual(24)
    expect(node.height).toBeGreaterThanOrEqual(24)
  })
})

describe('createGenerationResultNode (结果节点构造)', () => {
  const asset = {
    assetUrl: '/r.png',
    type: 'image/png',
    name: 'r.png',
    sizeBytes: 1234,
    hasTransparency: true,
    size: '1024x1024',
  }
  const source = imageNode({ id: 'src' })

  const baseOptions = {
    id: 'res-1',
    title: 'Generated image 1',
    placement: { x: 10.4, y: 20.6 },
    displaySize: { width: 300.4, height: 200.6 },
    asset,
    prompt: 'a cat',
    model: 'gpt-image-2',
    taskId: 'task-1',
    createdAt: 1000,
    operation: 'beside-generation' as const,
    sourceNode: source,
    placementDirection: 'right' as const,
  }

  it('builds an image node with rounded placement and display size', () => {
    const node = createGenerationResultNode(baseOptions)
    expect(node.id).toBe('res-1')
    expect(node.type).toBe('image')
    expect(node.x).toBe(10)
    expect(node.y).toBe(21)
    expect(node.width).toBe(300)
    expect(node.height).toBe(201)
    expect(node.status).toBe('ready')
  })

  it('copies asset fields onto the node', () => {
    const node = createGenerationResultNode(baseOptions)
    expect(node.assetUrl).toBe('/r.png')
    expect(node.assetMimeType).toBe('image/png')
    expect(node.assetOriginalName).toBe('r.png')
    expect(node.assetSizeBytes).toBe(1234)
    expect(node.imageHasTransparency).toBe(true)
  })

  it('sets generation + aiWorkflow metadata from the source link', () => {
    const node = createGenerationResultNode(baseOptions)
    expect(node.generation?.prompt).toBe('a cat')
    expect(node.generation?.model).toBe('gpt-image-2')
    expect(node.generation?.size).toBe('1024x1024')
    expect(node.generation?.taskId).toBe('task-1')
    expect(node.generation?.createdAt).toBe(1000)
    expect(node.aiWorkflow?.kind).toBe('result')
    expect(node.aiWorkflow?.operation).toBe('beside-generation')
    expect(node.aiWorkflow?.sourceNodeIds).toEqual(['src'])
    expect(node.aiWorkflow?.anchorNodeId).toBe('src')
    expect(node.aiWorkflow?.placement).toBe('right')
    expect(node.parentIds).toEqual(['src'])
    expect(node.sourceNodeId).toBe('src')
  })

  it('deep-clones maskBounds so input mutation does not leak', () => {
    const maskBounds = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 }
    const node = createGenerationResultNode({ ...baseOptions, maskBounds })
    maskBounds.x = 0.99
    expect(node.generation?.maskBounds?.x).toBe(0.1)
    expect(node.generation?.maskBounds).not.toBe(maskBounds)
  })

  it('clears source linkage when sourceNode is undefined', () => {
    const node = createGenerationResultNode({ ...baseOptions, sourceNode: undefined })
    expect(node.parentIds).toBeUndefined()
    expect(node.sourceNodeId).toBeUndefined()
    expect(node.aiWorkflow?.sourceNodeIds).toBeUndefined()
    expect(node.aiWorkflow?.anchorNodeId).toBeUndefined()
    expect(node.aiWorkflow?.slotId).toBeUndefined()
  })

  it('sets slotId when the source is an ai-slot', () => {
    const slot: MivoCanvasNode = {
      id: 'slot-1',
      type: 'ai-slot',
      title: 'Slot',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      status: 'ready',
    }
    const node = createGenerationResultNode({ ...baseOptions, sourceNode: slot })
    expect(node.aiWorkflow?.slotId).toBe('slot-1')
  })
})

describe('edgeTypeForOperation', () => {
  it("maps generation ops to 'generate' and the rest to 'edit'", () => {
    expect(edgeTypeForOperation('slot-generation')).toBe('generate')
    expect(edgeTypeForOperation('beside-generation')).toBe('generate')
    expect(edgeTypeForOperation('variation')).toBe('generate')
    expect(edgeTypeForOperation('area-edit')).toBe('edit')
    expect(edgeTypeForOperation('annotation-edit')).toBe('edit')
    expect(edgeTypeForOperation('prompt-edit')).toBe('edit')
  })
})

describe('isDerivationEdgeNode', () => {
  it('identifies markup nodes whose generation model is the derivation edge model', () => {
    const edge: CanvasEdge = { id: 'e1', from: 's', to: 't', type: 'generate', prompt: 'p', createdAt: 1 }
    const source = imageNode({ id: 's', x: 0, y: 0, width: 100, height: 100 })
    const target = imageNode({ id: 't', x: 300, y: 0, width: 100, height: 100 })
    const derivationNode = createDerivationEdgeNode(edge, [source, target])

    expect(isDerivationEdgeNode(derivationNode!)).toBe(true)
    expect(isDerivationEdgeNode(source)).toBe(false)
  })
})
