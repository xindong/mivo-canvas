import { describe, expect, it } from 'vitest'
import {
  diffReconcilePlan,
  type RendererAdapter,
  type RendererReconcileCounts,
  type RendererSyncContext,
} from './rendererAdapter'

// A minimal fake adapter that records create/update/delete so the contract
// (收支平衡 — no leak, no resurrect, no double-count) can be asserted.
const createFakeAdapter = () => {
  const painted = new Map<string, { generation: number }>()
  let generation = 0
  const counts: RendererReconcileCounts = { created: 0, updated: 0, deleted: 0 }
  const planHistory: Array<ReturnType<typeof diffReconcilePlan>> = []
  const dummyCtx: RendererSyncContext = {
    viewport: { x: 0, y: 0, scale: 1 },
    selectedNodeIds: new Set<string>(),
    isPanning: false,
  }

  const adapter: RendererAdapter = {
    mode: 'leafer',
    mount: () => {},
    unmount: () => painted.clear(),
    sync: (nodes, _ctx) => {
      void _ctx // ctx is part of the contract; the fake only exercises the id diff
      const plan = diffReconcilePlan([...painted.keys()], nodes.map((n) => n.id))
      planHistory.push(plan)
      for (const id of plan.created) {
        painted.set(id, { generation: generation + 1 })
        counts.created += 1
      }
      for (const id of plan.updated) {
        painted.set(id, { generation: generation + 1 })
        counts.updated += 1
      }
      for (const id of plan.deleted) {
        painted.delete(id)
        counts.deleted += 1
      }
      generation += 1
    },
    setViewport: () => {},
  }
  return { adapter, painted, counts, planHistory, dummyCtx }
}

const node = (id: string) => ({ id }) as never // RenderNode shape — only id used by sync

describe('diffReconcilePlan — 收支平衡 contract', () => {
  it('all-new list → only created, no updated/deleted', () => {
    const plan = diffReconcilePlan([], ['a', 'b', 'c'])
    expect([...plan.created]).toEqual(['a', 'b', 'c'])
    expect(plan.updated.size).toBe(0)
    expect(plan.deleted.size).toBe(0)
    // invariant: created ∩ deleted = ∅
    expect([...plan.created].filter((id) => plan.deleted.has(id))).toEqual([])
  })

  it('identical list → only updated, no created/deleted', () => {
    const plan = diffReconcilePlan(['a', 'b'], ['a', 'b'])
    expect(plan.created.size).toBe(0)
    expect([...plan.updated]).toEqual(['a', 'b'])
    expect(plan.deleted.size).toBe(0)
  })

  it('empty list after full set → only deleted', () => {
    const plan = diffReconcilePlan(['a', 'b'], [])
    expect(plan.created.size).toBe(0)
    expect(plan.updated.size).toBe(0)
    expect([...plan.deleted]).toEqual(['a', 'b'])
  })

  it('mixed: keep some, drop some, add some — sets are disjoint', () => {
    const plan = diffReconcilePlan(['a', 'b', 'c'], ['b', 'c', 'd'])
    expect([...plan.created]).toEqual(['d'])
    expect([...plan.updated].sort()).toEqual(['b', 'c'])
    expect([...plan.deleted]).toEqual(['a'])
    // invariant: an id never appears in two buckets
    const allIds = [...plan.created, ...plan.updated, ...plan.deleted]
    expect(new Set(allIds).size).toBe(allIds.length)
  })
})

describe('RendererAdapter fake — sync 收支平衡 (no leak, no resurrect)', () => {
  it('created count = net new painted; deleted count = net removed', () => {
    const { adapter, painted, counts, dummyCtx } = createFakeAdapter()
    adapter.sync([node('a'), node('b'), node('c')], dummyCtx)
    expect(painted.size).toBe(3)
    expect(counts.created).toBe(3)
    expect(counts.updated).toBe(0)
    expect(counts.deleted).toBe(0)

    adapter.sync([node('b'), node('c'), node('d')], dummyCtx)
    expect(painted.size).toBe(3) // no leak
    expect(counts.created).toBe(4) // a,b,c + d
    expect(counts.updated).toBe(2) // b,c
    expect(counts.deleted).toBe(1) // a

    adapter.sync([], dummyCtx) // clear all
    expect(painted.size).toBe(0) // no leak
    // cumulative: 1 (a, from sync 2) + 3 (b,c,d, from sync 3) = 4
    expect(counts.deleted).toBe(4)
  })

  it('a deleted id is never resurrected by the same sync (created ∩ deleted = ∅)', () => {
    const { adapter, planHistory, dummyCtx } = createFakeAdapter()
    adapter.sync([node('a'), node('b')], dummyCtx)
    adapter.sync([node('b'), node('c')], dummyCtx)
    for (const plan of planHistory) {
      const overlap = [...plan.created].filter((id) => plan.deleted.has(id))
      expect(overlap).toEqual([])
    }
  })

  it('mount/unmount are idempotent (double-mount/double-unmount are no-ops)', () => {
    const { adapter, painted, dummyCtx } = createFakeAdapter()
    adapter.mount(undefined as never)
    adapter.sync([node('a')], dummyCtx)
    expect(painted.size).toBe(1)
    adapter.unmount()
    adapter.unmount() // double-unmount no-op
    expect(painted.size).toBe(0)
    adapter.mount(undefined as never)
    adapter.mount(undefined as never) // double-mount no-op
    expect(painted.size).toBe(0)
  })
})
