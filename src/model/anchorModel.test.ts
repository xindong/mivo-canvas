import { describe, expect, it } from 'vitest'
import {
  addAnchorToNode,
  createAnchor,
  createAnchorId,
  normalizeAnchors,
  recordAnchorResultOnNode,
  removeAnchorFromNode,
  updateAnchorInstruction,
} from './anchorModel'
import { cloneNode, cloneEdge, cloneTask } from '../store/nodeFactory'
import { snapshotFromState } from '../store/historyManager'
import { normalizeCanvasSnapshotV2 } from './canvasSnapshotModel'
import { parseCanvasSnapshot } from '../lib/snapshotValidation'
import type { ExperimentalAnchor, MivoCanvasNode } from '../types/mivoCanvas'

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

const pointAnchor = (overrides: Partial<ExperimentalAnchor> = {}): ExperimentalAnchor => ({
  id: 'a1',
  type: 'point',
  targetNodeId: 'n1',
  x: 50,
  y: 60,
  instruction: 'add a hat',
  createdAt: 1000,
  ...overrides,
})

const boxAnchor = (overrides: Partial<ExperimentalAnchor> = {}): ExperimentalAnchor => ({
  id: 'a2',
  type: 'box',
  targetNodeId: 'n1',
  x: 10,
  y: 10,
  width: 40,
  height: 50,
  instruction: 'redraw this region',
  createdAt: 2000,
  ...overrides,
})

describe('createAnchor', () => {
  it('builds a point anchor with id + createdAt', () => {
    const a = createAnchor({ type: 'point', targetNodeId: 'n1', x: 1, y: 2, instruction: 'do' })
    expect(a).toBeDefined()
    expect(a!.id.startsWith('anchor-')).toBe(true)
    expect(a!.type).toBe('point')
    expect(a!.createdAt).toBeGreaterThan(0)
    expect(a!.width).toBeUndefined()
  })

  it('builds a box anchor with width/height', () => {
    const a = createAnchor({ type: 'box', targetNodeId: 'n1', x: 1, y: 2, instruction: 'do', width: 10, height: 20 })
    expect(a).toBeDefined()
    expect(a!.width).toBe(10)
    expect(a!.height).toBe(20)
  })

  it('rejects box missing width/height', () => {
    expect(createAnchor({ type: 'box', targetNodeId: 'n1', x: 1, y: 2, instruction: 'do' })).toBeUndefined()
    expect(createAnchor({ type: 'box', targetNodeId: 'n1', x: 1, y: 2, instruction: 'do', width: 0, height: 10 })).toBeUndefined()
  })

  it('rejects missing targetNodeId / non-finite coords', () => {
    expect(createAnchor({ type: 'point', targetNodeId: '', x: 1, y: 2, instruction: 'do' })).toBeUndefined()
    expect(createAnchor({ type: 'point', targetNodeId: 'n1', x: Number.NaN, y: 2, instruction: 'do' })).toBeUndefined()
  })
})

describe('normalizeAnchors (clone + validate + drop bad)', () => {
  it('drops a box anchor missing width/height and keeps valid ones', () => {
    const out = normalizeAnchors(
      [
        pointAnchor(),
        { id: 'bad', type: 'box', targetNodeId: 'n1', x: 0, y: 0, instruction: 'x', createdAt: 1 }, // box missing w/h
        boxAnchor(),
      ],
      true,
    )
    expect(out).toHaveLength(2)
    expect(out!.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('drops entries missing required fields', () => {
    const out = normalizeAnchors([
      pointAnchor(),
      { id: 'x', type: 'point', targetNodeId: '', x: 1, y: 2, instruction: 'i', createdAt: 1 }, // empty target
      { type: 'point', targetNodeId: 'n1', x: 1, y: 2, instruction: 'i', createdAt: 1 }, // no id
    ])
    expect(out).toHaveLength(1)
    expect(out![0].id).toBe('a1')
  })

  it('returns undefined for non-array / empty', () => {
    expect(normalizeAnchors(undefined)).toBeUndefined()
    expect(normalizeAnchors([])).toBeUndefined()
    expect(normalizeAnchors('nope')).toBeUndefined()
  })

  it('deep-copies resultNodeIds (no shared ref)', () => {
    const src: ExperimentalAnchor[] = [{ ...pointAnchor(), resultNodeIds: ['r1', 'r2'] }]
    const out = normalizeAnchors(src)!
    expect(out[0].resultNodeIds).toEqual(['r1', 'r2'])
    expect(out[0].resultNodeIds).not.toBe(src[0].resultNodeIds)
  })
})

describe('immutable node operations', () => {
  it('addAnchorToNode appends and creates the field on a bare node', () => {
    const node = imageNode()
    const next = addAnchorToNode(node, pointAnchor())
    expect(node.experimentalAnchors).toBeUndefined() // input untouched
    expect(next.experimentalAnchors).toEqual([pointAnchor()])
  })

  it('updateAnchorInstruction updates only the matched anchor', () => {
    const node = imageNode({ experimentalAnchors: [pointAnchor(), boxAnchor()] })
    const next = updateAnchorInstruction(node, 'a2', 'new instruction')
    expect(next.experimentalAnchors![0].instruction).toBe('add a hat') // unchanged
    expect(next.experimentalAnchors![1].instruction).toBe('new instruction')
    expect(node.experimentalAnchors![1].instruction).toBe('redraw this region') // input untouched
  })

  it('updateAnchorInstruction is a no-op for an absent id', () => {
    const node = imageNode({ experimentalAnchors: [pointAnchor()] })
    expect(updateAnchorInstruction(node, 'nope', 'x')).toBe(node)
  })

  it('removeAnchorFromNode removes and clears the field when the last anchor goes', () => {
    const node = imageNode({ experimentalAnchors: [pointAnchor(), boxAnchor()] })
    const one = removeAnchorFromNode(node, 'a1')
    expect(one.experimentalAnchors).toHaveLength(1)
    expect(one.experimentalAnchors![0].id).toBe('a2')
    const none = removeAnchorFromNode(one, 'a2')
    expect(none.experimentalAnchors).toBeUndefined()
  })

  it('recordAnchorResultOnNode records resultNodeIds on the matched anchor', () => {
    const node = imageNode({ experimentalAnchors: [pointAnchor()] })
    const next = recordAnchorResultOnNode(node, 'a1', ['res-1', 'res-2'])
    expect(next.experimentalAnchors![0].resultNodeIds).toEqual(['res-1', 'res-2'])
    expect(node.experimentalAnchors![0].resultNodeIds).toBeUndefined() // input untouched
  })

  it('createAnchorId yields unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createAnchorId()))
    expect(ids.size).toBe(20)
  })
})

describe('snapshot roundtrip preserves experimentalAnchors (getSnapshot → parse → replaceSnapshot)', () => {
  // Mirrors the store's getSnapshot (snapshotFromState) + parse (parseCanvasSnapshot)
  // + replaceSnapshot (normalizeCanvasSnapshotV2) path, asserting the experimental
  // field survives a serialize/parse cycle with deep equality.
  const anchors: ExperimentalAnchor[] = [
    pointAnchor(),
    boxAnchor(),
    { ...pointAnchor({ id: 'a3' }), resultNodeIds: ['r1', 'r2'] },
  ]
  const node = imageNode({ id: 'n1', experimentalAnchors: anchors })

  it('anchors are deep-copied by cloneNode (no shared refs into history/clipboard)', () => {
    const clone = cloneNode(node)
    expect(clone.experimentalAnchors).toEqual(anchors)
    expect(clone.experimentalAnchors).not.toBe(node.experimentalAnchors)
    expect(clone.experimentalAnchors![0]).not.toBe(node.experimentalAnchors![0])
    expect(clone.experimentalAnchors![2].resultNodeIds).not.toBe(node.experimentalAnchors![2].resultNodeIds)
  })

  it('full roundtrip: snapshot → JSON → parse → normalize keeps anchors deeply equal', () => {
    const state = {
      sceneId: 'c1',
      nodes: [node],
      edges: [],
      tasks: [],
      selectedNodeIds: [],
    }
    const snapshot = snapshotFromState(state, { cloneNode, cloneEdge, cloneTask })
    // serialize + parse (the archive import path)
    const parsed = parseCanvasSnapshot(JSON.stringify(snapshot))
    if (!parsed.ok) throw new Error(`parse failed: ${(parsed as { message: string }).message}`)
    // replaceSnapshot re-normalizes via normalizeCanvasSnapshotV2
    const applied = normalizeCanvasSnapshotV2(parsed.snapshot)
    const roundTripped = applied.nodes[0].experimentalAnchors
    expect(roundTripped).toEqual(anchors)
  })

  it('snapshotValidation rejects a grossly malformed anchor (box missing width/height)', () => {
    const badNode = imageNode({
      id: 'bad',
      experimentalAnchors: [{ id: 'a', type: 'box', targetNodeId: 'n1', x: 0, y: 0, instruction: 'i', createdAt: 1 }],
    })
    const snapshot = { version: 2, sceneId: 'c1', nodes: [badNode], edges: [], tasks: [] }
    const parsed = parseCanvasSnapshot(JSON.stringify(snapshot))
    expect(parsed.ok).toBe(false)
  })
})
