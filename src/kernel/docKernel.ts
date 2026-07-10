// src/kernel/docKernel.ts
// T1.2 S1 纯脚手架:DocKernel 域骨架(interface,不实现)。S2 落内存实现 + CRUD。
// 权威:docs/decisions/record-schema.md + docs/decisions/kernel-dualtrack-contract.md(§4 shadow 读/单写)。
// 本文件只钉接口形状 + scope 标注;不接线 canvasStore/渲染,legacy 零行为变化(kernel=legacy 默认无感)。

import type { AnchorRecord, EdgeRecord, NodeRecord, Revision } from './records'

/**
 * DocKernel:document 域唯一文档真相源(platform §13.2)。
 * records 扁平化:独立 id + 字段级属性,可无损映射 Y.Map/Y.Array(record-schema §1)。
 *
 * scope:document(nodes/edges/anchors + 画布结构;chat per-canvas 独立 collection,见 §5/SessionStore
 * 不在此)。同步:服务端真相 + 节点级合并(每 record 带 revision,同节点才冲突)。
 *
 * S1 只钉接口;S2 实现内存 store(经 ?kernel=new 才被消费,legacy 不读)。
 */
export interface DocKernel {
  // ── Node records ──
  getNode(id: string): NodeRecord | undefined
  upsertNode(record: NodeRecord): void
  deleteNode(id: string): void
  listNodes(): readonly NodeRecord[]

  // ── Edge records ──
  getEdge(id: string): EdgeRecord | undefined
  upsertEdge(record: EdgeRecord): void
  deleteEdge(id: string): void
  listEdges(): readonly EdgeRecord[]

  // ── Anchor records(DP-2 收编:顶层独立 record,非 node-embedded)──
  getAnchor(id: string): AnchorRecord | undefined
  upsertAnchor(record: AnchorRecord): void
  deleteAnchor(id: string): void
  listAnchors(): readonly AnchorRecord[]

  // ── 画布元(record-schema §4:CanvasDocument 顶层:title/createdAt/updatedAt 等;S2/S3 细化)──
  // tasks 不在此(DP-8:迁服务端 registry);selection 不在此(DP-1:迁 SessionStore)。
  readonly documentMeta: { title: string; createdAt: string; updatedAt: string; revision: Revision }
}

/**
 * 工厂:S2 提供内存实现。S1 只导出类型 + 工厂签名占位(throw,确保不被 legacy 误用)。
 * 真实实现由 S2 的 createDocKernel() 提供;legacy 路径不调用本工厂(kernel=legacy 默认无感)。
 */
export const createDocKernel = (): DocKernel => {
  throw new Error('createDocKernel: T1.2 S2 未实现(S1 仅脚手架)。kernel=legacy 默认不消费本路径。')
}
