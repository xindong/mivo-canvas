// src/kernel/docKernel.test.ts
// T1.2 S2:MemoryDocKernel CRUD + per-record revision bump + defensive clone 单测。

import { describe, expect, it } from 'vitest'
import type { AnchorRecord, EdgeRecord, NodeRecord } from './records'
import { createDocKernel } from './docKernel'

const makeNode = (id: string, rev = 0): NodeRecord => ({
  id, type: 'image', title: id, revision: rev,
  transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
  fills: [], strokes: [], effects: [], relations: {},
})
const makeEdge = (id: string, rev = 0): EdgeRecord => ({
  id, from: 'a', to: 'b', type: 'generate', prompt: 'p', createdAt: 0, revision: rev,
})
const makeAnchor = (id: string, rev = 0): AnchorRecord => ({
  id, type: 'point', targetNodeId: 'n', x: 0, y: 0, instruction: 'i', createdAt: 0, revision: rev,
})

describe('T1.2 S2 MemoryDocKernel — CRUD + revision bump', () => {
  it('upsert new node returns base revision; getNode + listNodes reflect', () => {
    const dk = createDocKernel({ title: 't' })
    expect(dk.upsertNode(makeNode('n1', 0))).toBe(0)
    expect(dk.getNode('n1')?.id).toBe('n1')
    expect(dk.listNodes()).toHaveLength(1)
  })

  it('upsert existing node bumps revision (0 → 1 → 2); base ignored on update', () => {
    const dk = createDocKernel()
    expect(dk.upsertNode(makeNode('n1', 0))).toBe(0)
    expect(dk.upsertNode(makeNode('n1', 0))).toBe(1)
    expect(dk.upsertNode(makeNode('n1', 5))).toBe(2) // 更新时 base 被忽略,bump 胜出
    expect(dk.getNode('n1')?.revision).toBe(2)
  })

  it('delete returns true/false; getNode reflects', () => {
    const dk = createDocKernel()
    dk.upsertNode(makeNode('n1'))
    expect(dk.deleteNode('n1')).toBe(true)
    expect(dk.getNode('n1')).toBeUndefined()
    expect(dk.deleteNode('n1')).toBe(false) // 不存在的删返回 false
  })

  it('documentMeta.revision bumps on each content write (upsert/delete)', () => {
    const dk = createDocKernel({ title: 't', revision: 0 })
    expect(dk.documentMeta.revision).toBe(0)
    dk.upsertNode(makeNode('n1'))
    expect(dk.documentMeta.revision).toBe(1)
    dk.upsertNode(makeNode('n2'))
    expect(dk.documentMeta.revision).toBe(2)
    dk.deleteNode('n1')
    expect(dk.documentMeta.revision).toBe(3)
  })

  it('edges CRUD + revision bump', () => {
    const dk = createDocKernel()
    expect(dk.upsertEdge(makeEdge('e1', 0))).toBe(0)
    expect(dk.upsertEdge(makeEdge('e1', 0))).toBe(1)
    expect(dk.getEdge('e1')?.from).toBe('a')
    expect(dk.listEdges()).toHaveLength(1)
    expect(dk.deleteEdge('e1')).toBe(true)
    expect(dk.getEdge('e1')).toBeUndefined()
  })

  it('anchors CRUD + revision bump (DP-2 顶层独立 record)', () => {
    const dk = createDocKernel()
    expect(dk.upsertAnchor(makeAnchor('a1', 0))).toBe(0)
    expect(dk.upsertAnchor(makeAnchor('a1', 0))).toBe(1)
    expect(dk.getAnchor('a1')?.type).toBe('point')
    expect(dk.listAnchors()).toHaveLength(1)
    expect(dk.deleteAnchor('a1')).toBe(true)
    expect(dk.getAnchor('a1')).toBeUndefined()
  })

  it('defensive clone: external mutation of returned values does not affect store', () => {
    const dk = createDocKernel()
    dk.upsertNode(makeNode('n1'))
    const got = dk.getNode('n1')!
    got.title = 'mutated'
    expect(dk.getNode('n1')?.title).toBe('n1') // store 未变

    const listed = dk.listNodes()[0]
    listed.id = 'mutated-id'
    expect(dk.listNodes()[0].id).toBe('n1') // listNodes 返回 clone

    const meta = dk.documentMeta
    meta.revision = 999
    expect(dk.documentMeta.revision).not.toBe(999) // documentMeta 返回 clone
  })
})
