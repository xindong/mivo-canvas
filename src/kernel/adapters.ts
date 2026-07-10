// src/kernel/adapters.ts
// T1.2 S3:legacy CanvasDocument ↔ DocKernel 文档级适配器(hydrate 读 + project 回写,纯函数)。
// 用 S1 mapping(toRecord/fromRecord/edge/anchor)+ S2 DocKernel/SessionStore。
// 不接线 canvasStore/渲染;legacy 零行为变化(kernel=legacy 默认不消费)。
//
// 注:hydrate 用 upsert(会 bump meta.revision/updatedAt);meta.updatedAt/revision 是 kernel-managed,
// bulk load 视作 content write(bump)。round-trip 保 DATA(nodes/edges/anchors/selection/title/
// sourceTemplateId/projectId/createdAt);meta.updatedAt/revision 不 round-trip(kernel 内部,S5/S6 调)。
// tasks:[](DP-8:tasks 不在 document record,迁服务端 registry;round-trip 对 tasks 有意丢弃)。

import type { CanvasDocument } from '../types/mivoCanvas'
import type { DocKernel } from './docKernel'
import type { SessionStore } from './sessionStore'
import { createDocKernel } from './docKernel'
import { anchorsToRecords, edgeFromRecord, edgeToRecord, fromRecord, toRecord } from './mapping'

type AdapterOpts = { sessionStore?: SessionStore; userId?: string; canvasId?: string }

/**
 * hydrateDocKernel:legacy CanvasDocument → DocKernel(读路径)。
 * ?kernel=new 从 legacy 真相源 hydrate:loop nodes(toRecord + upsertNode)、edges(edgeToRecord +
 * upsertEdge)、提取 experimentalAnchors → AnchorRecord(DP-2 收编);documentMeta;selection →
 * sessionStore(DP-1,per user+canvas,不双写 document)。
 */
export const hydrateDocKernel = (doc: CanvasDocument, opts?: AdapterOpts): DocKernel => {
  const dk = createDocKernel({
    title: doc.title,
    sourceTemplateId: doc.sourceTemplateId,
    projectId: doc.projectId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  })
  for (const node of doc.nodes) {
    dk.upsertNode(toRecord(node))
    // DP-2 收编:node.experimentalAnchors → 顶层 AnchorRecord(独立 id+revision)
    for (const ar of anchorsToRecords(node.experimentalAnchors, 0)) dk.upsertAnchor(ar)
  }
  for (const edge of doc.edges) dk.upsertEdge(edgeToRecord(edge))

  // DP-1 selection → sessionStore(per user+canvas,不双写 document)
  if (opts?.sessionStore && opts.userId && opts.canvasId) {
    const sel = doc.selectedNodeIds ?? (doc.selectedNodeId ? [doc.selectedNodeId] : [])
    if (sel.length) opts.sessionStore.setSelection(opts.canvasId, opts.userId, sel)
  }
  return dk
}

/**
 * projectToLegacyDocument:DocKernel → legacy CanvasDocument(回写路径)。
 * listNodes(fromRecord)+ listEdges(edgeFromRecord)+ documentMeta(title/sourceTemplateId/projectId/
 * createdAt)+ selection(sessionStore)。tasks:[](DP-8)。
 */
export const projectToLegacyDocument = (dk: DocKernel, opts?: AdapterOpts): CanvasDocument => {
  const meta = dk.documentMeta
  const nodes = dk.listNodes().map(fromRecord)
  const edges = dk.listEdges().map(edgeFromRecord)

  let selectedNodeId: string | undefined
  let selectedNodeIds: string[] | undefined
  if (opts?.sessionStore && opts.userId && opts.canvasId) {
    const sel = opts.sessionStore.getSelection(opts.canvasId, opts.userId)
    if (sel && sel.length) {
      selectedNodeIds = sel
      selectedNodeId = sel[0]
    }
  }

  return {
    title: meta.title,
    ...(meta.sourceTemplateId != null
      ? { sourceTemplateId: meta.sourceTemplateId as CanvasDocument['sourceTemplateId'] }
      : {}),
    ...(meta.projectId != null ? { projectId: meta.projectId } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    nodes,
    edges,
    tasks: [], // DP-8:tasks 不在 document record(迁服务端 registry)
    ...(selectedNodeIds ? { selectedNodeIds } : {}),
    ...(selectedNodeId ? { selectedNodeId } : {}),
  }
}
