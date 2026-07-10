// src/kernel/adapters.test.ts
// T1.2 S3:legacy CanvasDocument ↔ DocKernel 文档级往返单测。
// 保 DATA(nodes/edges/anchors/selection/title/sourceTemplateId/projectId/createdAt);
// tasks 有意丢弃(DP-8);meta.updatedAt/revision kernel-managed(bump on hydrate,不 round-trip)。

import { describe, expect, it } from 'vitest'
import type { CanvasDocument, MivoCanvasNode } from '../types/mivoCanvas'
import { hydrateDocKernel, projectToLegacyDocument } from './adapters'
import { createSessionStore } from './sessionStore'

// 一致 image 节点(flats == canonical 派生,确保 round-trip 无损)
const imageNode: MivoCanvasNode = {
  id: 'n1', type: 'image', title: 'img1',
  transform: { x: 1, y: 2, width: 3, height: 4, rotation: 0 },
  x: 1, y: 2, width: 3, height: 4,
  fills: [{ id: 'f1', kind: 'image', assetUrl: 'u', opacity: 1, visible: true, scaleMode: 'fill' }],
  strokes: [],
  asset: { url: 'u', mimeType: 'image/png', originalName: 'i.png', sizeBytes: 10 },
  assetUrl: 'u', assetMimeType: 'image/png', assetOriginalName: 'i.png', assetSizeBytes: 10,
  relations: {},
  status: 'ready',
}

const anchorNode: MivoCanvasNode = {
  ...imageNode, id: 'n2',
  experimentalAnchors: [
    { id: 'a1', type: 'point', targetNodeId: 'n1', x: 5, y: 5, instruction: 'here', createdAt: 1 },
  ],
}

const doc: CanvasDocument = {
  title: 'd1',
  sourceTemplateId: 'empty',
  projectId: 'p1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  nodes: [imageNode, anchorNode],
  edges: [{ id: 'e1', from: 'n1', to: 'n2', type: 'generate', prompt: 'p', createdAt: 0 }],
  tasks: [{ id: 't1', label: 't', status: 'done', progress: 100, nodeIds: [] }], // DP-8: round-trip 丢
  selectedNodeId: 'n1',
  selectedNodeIds: ['n1'],
}

describe('T1.2 S3 adapters — CanvasDocument ↔ DocKernel 文档级往返', () => {
  it('round-trip: project(hydrate(doc)) 保 DATA;tasks 丢(DP-8);selection 保(DP-1)', () => {
    const ss = createSessionStore()
    const opts = { sessionStore: ss, userId: 'u1', canvasId: 'c1' }
    const dk = hydrateDocKernel(doc, opts)
    const projected = projectToLegacyDocument(dk, opts)

    // title / sourceTemplateId / projectId / createdAt 保(documentMeta)
    expect(projected).toMatchObject({
      title: 'd1', sourceTemplateId: 'empty', projectId: 'p1',
      createdAt: '2026-01-01T00:00:00.000Z',
      selectedNodeId: 'n1', selectedNodeIds: ['n1'],
    })
    // nodes round-trip(per-node toMatchObject: set fields 保)
    expect(projected.nodes).toHaveLength(2)
    expect(projected.nodes[0]).toMatchObject(imageNode)
    expect(projected.nodes[1]).toMatchObject(anchorNode)
    // edges round-trip
    expect(projected.edges).toEqual(doc.edges)
    // tasks 有意丢(DP-8:tasks 不在 document record)
    expect(projected.tasks).toEqual([])
  })

  it('anchor 收编:hydrate 把 node.experimentalAnchors 提为顶层 AnchorRecord(DP-2)', () => {
    const dk = hydrateDocKernel(doc)
    const anchors = dk.listAnchors()
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ id: 'a1', type: 'point', targetNodeId: 'n1', revision: 0 })
  })

  it('selection per-user 隔离(DP-1): 不同 user 不共享', () => {
    const ss = createSessionStore()
    const dk = hydrateDocKernel(doc, { sessionStore: ss, userId: 'u1', canvasId: 'c1' })
    // u1 的 selection 保
    const p1 = projectToLegacyDocument(dk, { sessionStore: ss, userId: 'u1', canvasId: 'c1' })
    expect(p1.selectedNodeIds).toEqual(['n1'])
    // u2 没有该 canvas 的 selection → projected 无 selectedNodeId/Ids
    const p2 = projectToLegacyDocument(dk, { sessionStore: ss, userId: 'u2', canvasId: 'c1' })
    expect(p2.selectedNodeId).toBeUndefined()
    expect(p2.selectedNodeIds).toBeUndefined()
  })

  it('无 sessionStore 时:projected 无 selection(不双写 document,DP-1)', () => {
    const dk = hydrateDocKernel(doc) // 无 sessionStore
    const projected = projectToLegacyDocument(dk) // 无 sessionStore
    expect(projected.selectedNodeId).toBeUndefined()
    expect(projected.selectedNodeIds).toBeUndefined()
    // 但 nodes/edges 仍保
    expect(projected.nodes).toHaveLength(2)
    expect(projected.edges).toEqual(doc.edges)
  })
})
