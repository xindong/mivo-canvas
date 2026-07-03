import { describe, expect, it, vi } from 'vitest'
import {
  HISTORY_LIMIT,
  pushHistory,
  redoHistory,
  snapshotFromState,
  undoHistory,
  type HistoryCloneFns,
  type HistorySnapshotSource,
  type HistoryStacks,
} from './historyManager'
import type { CanvasEdge, CanvasTask, MivoCanvasNode } from '../types/mivoCanvas'

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

const task = (overrides: Partial<CanvasTask> = {}): CanvasTask => ({
  id: 't1',
  label: 'task',
  status: 'done',
  progress: 100,
  nodeIds: ['n1'],
  ...overrides,
})

const edge = (overrides: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id: 'e1',
  from: 'n1',
  to: 'n2',
  type: 'generate',
  prompt: 'p',
  createdAt: 1,
  ...overrides,
})

// Real deep-clone stubs (the production cloneNode/edge/task live in canvasStore; historyManager
// is pure and takes them as parameters, so the tests inject equivalent deep cloners).
const cloneFns: HistoryCloneFns = {
  cloneNode: (n) => structuredClone(n),
  cloneEdge: (e) => ({ ...e }),
  cloneTask: (t) => ({ ...t, nodeIds: [...t.nodeIds] }),
}

type HistoryState = HistorySnapshotSource & HistoryStacks

const state = (overrides: Partial<HistoryState> = {}): HistoryState => ({
  sceneId: 'scene-1',
  nodes: [imageNode()],
  edges: [],
  tasks: [],
  selectedNodeId: 'n1',
  selectedNodeIds: ['n1'],
  historyPast: [],
  historyFuture: [],
  ...overrides,
})

const snapshotOf = (s: HistoryState) => snapshotFromState(s, cloneFns)

// Tests -----------------------------------------------------------------------

describe('snapshotFromState', () => {
  it('builds a v2 snapshot preserving sceneId, node/task/edge ids and selection', () => {
    const s = state({
      nodes: [imageNode({ id: 'a' }), imageNode({ id: 'b', x: 400 })],
      edges: [edge()],
      tasks: [task()],
      selectedNodeId: 'a',
      selectedNodeIds: ['a', 'b'],
    })

    const snapshot = snapshotOf(s)

    expect(snapshot.version).toBe(2)
    expect(snapshot.sceneId).toBe('scene-1')
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(snapshot.edges.map((e) => e.id)).toEqual(['e1'])
    expect(snapshot.tasks.map((t) => t.id)).toEqual(['t1'])
    expect(snapshot.selectedNodeId).toBe('a')
    expect(snapshot.selectedNodeIds).toEqual(['a', 'b'])
  })

  it('deep-clones nodes: mutating the source after snapshotting does not leak in', () => {
    const sourceNode = imageNode({
      id: 'a',
      generation: {
        prompt: 'p',
        model: 'm',
        maskBounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
      },
    })
    const s = state({ nodes: [sourceNode] })

    const snapshot = snapshotOf(s)
    // mutate the original live node's nested object after the snapshot was taken
    sourceNode.generation!.maskBounds!.x = 0.99

    expect(snapshot.nodes[0].generation?.maskBounds?.x).toBe(0.1)
  })

  it('invokes cloneNode/cloneEdge/cloneTask once per item', () => {
    const cloneNode = vi.fn((n: MivoCanvasNode) => ({ ...n }))
    const cloneEdge = vi.fn((e: CanvasEdge) => ({ ...e }))
    const cloneTask = vi.fn((t: CanvasTask) => ({ ...t, nodeIds: [...t.nodeIds] }))
    const s = state({
      nodes: [imageNode({ id: 'a' }), imageNode({ id: 'b' })],
      edges: [edge({ id: 'e1' }), edge({ id: 'e2' })],
      tasks: [task({ id: 't1' }), task({ id: 't2' })],
    })

    snapshotFromState(s, { cloneNode, cloneEdge, cloneTask })

    expect(cloneNode).toHaveBeenCalledTimes(2)
    expect(cloneEdge).toHaveBeenCalledTimes(2)
    expect(cloneTask).toHaveBeenCalledTimes(2)
  })

  it('treats missing edges as an empty array', () => {
    const s = state({ edges: [] })
    const snapshot = snapshotOf(s)
    expect(snapshot.edges).toEqual([])
  })
})

describe('pushHistory', () => {
  it('appends the current snapshot to the past and clears the future', () => {
    const s = state({
      historyPast: [snapshotOf(state({ sceneId: 'past-1' }))],
      historyFuture: [snapshotOf(state({ sceneId: 'future-1' }))],
    })

    const result = pushHistory(s, cloneFns)

    expect(result.historyPast).toHaveLength(2)
    expect(result.historyPast.at(-1)?.sceneId).toBe('scene-1')
    expect(result.historyFuture).toEqual([])
  })

  it(`trims the past to ${HISTORY_LIMIT} entries after many pushes`, () => {
    let s = state()
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      s = { ...s, ...pushHistory({ ...s, sceneId: `scene-${i}` }, cloneFns) }
    }

    expect(s.historyPast).toHaveLength(HISTORY_LIMIT)
    // the oldest entries were dropped
    expect(s.historyPast[0].sceneId).not.toBe('scene-0')
    // the most recent entry is the last pushed scene
    expect(s.historyPast.at(-1)?.sceneId).toBe(`scene-${HISTORY_LIMIT + 4}`)
  })

  it('stores deep-cloned snapshots: later live mutations do not corrupt earlier history', () => {
    const liveNode = imageNode({ id: 'a', x: 10 })
    let s = state({ nodes: [liveNode] })
    s = { ...s, ...pushHistory(s, cloneFns) }

    // mutate the live node after it was captured into history
    liveNode.x = 999

    expect(s.historyPast[0].nodes[0].x).toBe(10)
  })
})

describe('undoHistory', () => {
  it('returns null when there is nothing to undo (boundary)', () => {
    const s = state({ historyPast: [] })
    expect(undoHistory(s, cloneFns)).toBeNull()
  })

  it('pops the last past snapshot to apply, shrinks past, and prepends current to future', () => {
    const previousSnapshot = snapshotOf(state({ sceneId: 'past-1' }))
    const s = state({
      sceneId: 'current',
      historyPast: [previousSnapshot],
      historyFuture: [],
    })

    const result = undoHistory(s, cloneFns)

    expect(result).not.toBeNull()
    if (!result) return
    expect(result.snapshotToApply).toBe(previousSnapshot)
    expect(result.historyPast).toEqual([])
    expect(result.historyFuture).toHaveLength(1)
    expect(result.historyFuture[0].sceneId).toBe('current')
  })

  it(`trims the future to ${HISTORY_LIMIT} after undo`, () => {
    const fullFuture = Array.from({ length: HISTORY_LIMIT + 3 }, (_, i) =>
      snapshotOf(state({ sceneId: `f-${i}` })),
    )
    const s = state({
      sceneId: 'current',
      historyPast: [snapshotOf(state({ sceneId: 'past-1' }))],
      historyFuture: fullFuture,
    })

    const result = undoHistory(s, cloneFns)

    expect(result?.historyFuture).toHaveLength(HISTORY_LIMIT)
  })
})

describe('redoHistory', () => {
  it('returns null when there is nothing to redo (boundary)', () => {
    const s = state({ historyFuture: [] })
    expect(redoHistory(s, cloneFns)).toBeNull()
  })

  it('shifts the first future snapshot to apply, shrinks future, and appends current to past', () => {
    const nextSnapshot = snapshotOf(state({ sceneId: 'future-1' }))
    const s = state({
      sceneId: 'current',
      historyPast: [],
      historyFuture: [nextSnapshot],
    })

    const result = redoHistory(s, cloneFns)

    expect(result).not.toBeNull()
    if (!result) return
    expect(result.snapshotToApply).toBe(nextSnapshot)
    expect(result.historyFuture).toEqual([])
    expect(result.historyPast).toHaveLength(1)
    expect(result.historyPast[0].sceneId).toBe('current')
  })

  it(`trims the past to ${HISTORY_LIMIT} after redo`, () => {
    const fullPast = Array.from({ length: HISTORY_LIMIT + 3 }, (_, i) =>
      snapshotOf(state({ sceneId: `p-${i}` })),
    )
    const s = state({
      sceneId: 'current',
      historyPast: fullPast,
      historyFuture: [snapshotOf(state({ sceneId: 'future-1' }))],
    })

    const result = redoHistory(s, cloneFns)

    expect(result?.historyPast).toHaveLength(HISTORY_LIMIT)
  })
})

describe('undo / redo round-trip', () => {
  it('push → undo restores the previous snapshot and leaves a single redo entry', () => {
    // Real app flow: pushHistory captures the CURRENT state, then a mutation happens.
    let s = state({ sceneId: 'before' })
    s = { ...s, ...pushHistory(s, cloneFns), sceneId: 'after' }
    // now state is 'after'; historyPast holds a snapshot of 'before'

    const undoResult = undoHistory(s, cloneFns)
    expect(undoResult?.snapshotToApply.sceneId).toBe('before')
    expect(undoResult?.historyPast).toEqual([])
    expect(undoResult?.historyFuture).toHaveLength(1)
    expect(undoResult?.historyFuture[0].sceneId).toBe('after')

    const redoResult = redoHistory(
      { ...s, historyPast: undoResult!.historyPast, historyFuture: undoResult!.historyFuture },
      cloneFns,
    )
    expect(redoResult?.snapshotToApply.sceneId).toBe('after')
  })
})
