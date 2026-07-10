// src/kernel/docKernel.ts
// T1.2 S2:DocKernel document 域内存实现(CRUD + per-record revision bump)。
// S1 钉 interface + throw 占位;S2 落 MemoryDocKernel(默认内存实现,?kernel=new 才消费,legacy 不读)。
// 权威:docs/decisions/record-schema.md + docs/decisions/kernel-dualtrack-contract.md(§4 单写)。
// 不接线 canvasStore/渲染;legacy 零行为变化(kernel=legacy 默认无感)。
//
// revision 语义(platform §13.5):per-record,服务端按节点粒度 merge 的 LWW tie-break。
// S2 内存单写,upsert 内部 bump(更新 existing.revision+1,新建用 record.revision)。
// S5/S6 多写/服务端接通时加乐观并发校验(record.revision >= existing.revision,否则 stale 拒写)。

import type { AnchorRecord, EdgeRecord, NodeRecord, Revision } from './records'

/**
 * DocKernel:document 域唯一文档真相源(platform §13.2)。
 * records 扁平化:独立 id + 字段级属性,可无损映射 Y.Map/Y.Array(record-schema §1)。
 * scope:document(nodes/edges/anchors + 画布结构;chat per-canvas 独立 collection 见 §5/SessionStore)。
 *
 * S2:upsert 返回存储后的 revision(调用方读 post-bump revision,免二次 getNode)。
 */
export interface DocKernel {
  // ── Node records ──
  getNode(id: string): NodeRecord | undefined
  upsertNode(record: NodeRecord): Revision
  deleteNode(id: string): boolean
  listNodes(): readonly NodeRecord[]

  // ── Edge records ──
  getEdge(id: string): EdgeRecord | undefined
  upsertEdge(record: EdgeRecord): Revision
  deleteEdge(id: string): boolean
  listEdges(): readonly EdgeRecord[]

  // ── Anchor records(DP-2 收编:顶层独立 record,非 node-embedded)──
  getAnchor(id: string): AnchorRecord | undefined
  upsertAnchor(record: AnchorRecord): Revision
  deleteAnchor(id: string): boolean
  listAnchors(): readonly AnchorRecord[]

  // ── 画布元(tasks 不在此 DP-8;selection 不在此 DP-1;S3 扩 sourceTemplateId/projectId)──
  readonly documentMeta: { title: string; sourceTemplateId?: string; projectId?: string; createdAt: string; updatedAt: string; revision: Revision }
}

/** 深拷贝(防外部 mutate 内部状态;records 是纯 JSON 值,structuredClone 适用)。 */
const clone = <T>(value: T): T => structuredClone(value)

/** bump 规则:更新 → existing.revision + 1;新建 → max(0, record.revision)。 */
const nextRevision = (existing: { revision: Revision } | undefined, base: Revision): Revision =>
  existing ? existing.revision + 1 : Math.max(0, base)

/**
 * MemoryDocKernel:默认内存实现(S2)。三 Map(nodes/edges/anchors)+ documentMeta。
 * 非真 Yjs/Y.Map——形状对齐(独立 id + 字段扁平),spike 验收=可无损映射 Y.Map/Y.Array(record-schema §1)。
 * 真正 Yjs 接入是 N1(协作 spike),不在 T1.2 范围。
 */
export class MemoryDocKernel implements DocKernel {
  private readonly nodes = new Map<string, NodeRecord>()
  private readonly edges = new Map<string, EdgeRecord>()
  private readonly anchors = new Map<string, AnchorRecord>()
  private _meta: { title: string; sourceTemplateId?: string; projectId?: string; createdAt: string; updatedAt: string; revision: Revision }

  constructor(meta?: Partial<DocKernel['documentMeta']>) {
    const now = new Date().toISOString()
    this._meta = {
      title: meta?.title ?? 'untitled',
      ...(meta?.sourceTemplateId != null ? { sourceTemplateId: meta.sourceTemplateId } : {}),
      ...(meta?.projectId != null ? { projectId: meta.projectId } : {}),
      createdAt: meta?.createdAt ?? now,
      updatedAt: meta?.updatedAt ?? now,
      revision: meta?.revision ?? 0,
    }
  }

  // ── documentMeta(任何 content 写都 bump doc-level revision + updatedAt)──
  get documentMeta() {
    return clone(this._meta)
  }
  private bumpMeta() {
    this._meta = { ...this._meta, updatedAt: new Date().toISOString(), revision: this._meta.revision + 1 }
  }

  // ── Node ──
  getNode(id: string): NodeRecord | undefined {
    const r = this.nodes.get(id)
    return r ? clone(r) : undefined
  }
  upsertNode(record: NodeRecord): Revision {
    const existing = this.nodes.get(record.id)
    const rev = nextRevision(existing, record.revision)
    this.nodes.set(record.id, clone({ ...record, revision: rev }))
    this.bumpMeta()
    return rev
  }
  deleteNode(id: string): boolean {
    const had = this.nodes.delete(id)
    if (had) this.bumpMeta()
    return had
  }
  listNodes(): readonly NodeRecord[] {
    return [...this.nodes.values()].map(clone)
  }

  // ── Edge ──
  getEdge(id: string): EdgeRecord | undefined {
    const r = this.edges.get(id)
    return r ? clone(r) : undefined
  }
  upsertEdge(record: EdgeRecord): Revision {
    const existing = this.edges.get(record.id)
    const rev = nextRevision(existing, record.revision)
    this.edges.set(record.id, clone({ ...record, revision: rev }))
    this.bumpMeta()
    return rev
  }
  deleteEdge(id: string): boolean {
    const had = this.edges.delete(id)
    if (had) this.bumpMeta()
    return had
  }
  listEdges(): readonly EdgeRecord[] {
    return [...this.edges.values()].map(clone)
  }

  // ── Anchor(DP-2 顶层独立 record)──
  getAnchor(id: string): AnchorRecord | undefined {
    const r = this.anchors.get(id)
    return r ? clone(r) : undefined
  }
  upsertAnchor(record: AnchorRecord): Revision {
    const existing = this.anchors.get(record.id)
    const rev = nextRevision(existing, record.revision)
    this.anchors.set(record.id, clone({ ...record, revision: rev }))
    this.bumpMeta()
    return rev
  }
  deleteAnchor(id: string): boolean {
    const had = this.anchors.delete(id)
    if (had) this.bumpMeta()
    return had
  }
  listAnchors(): readonly AnchorRecord[] {
    return [...this.anchors.values()].map(clone)
  }
}

/**
 * 工厂:默认 MemoryDocKernel。?kernel=new 路径消费(S5 接线);legacy 不调用。
 */
export const createDocKernel = (meta?: Partial<DocKernel['documentMeta']>): DocKernel =>
  new MemoryDocKernel(meta)
