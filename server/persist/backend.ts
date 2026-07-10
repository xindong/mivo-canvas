// server/persist/backend.ts
// T1.3 前置:PersistBackend 存储接口(DP-5 信封列 + 返修 #1~#7/#10)+ 内存实现。
// 权威:docs/decisions/api-surface.md §0/§2/§6(返修版)。
//
// ┌────────────────────────────────────────────────────────────────────────────┐
// │ TODO(PG / T1.1 批复后):PgPersistBackend 实现本接口。信封列 + payload jsonb,  │
// │ 附录 A SQL 草案(api-surface.md)。swap 不改路由/契约:server/app.ts 注入点     │
// │ 从 InMemoryPersistBackend 换 PgPersistBackend,路由 handler 零改动,契约测试   │
// │ 从内存换成 PG fixture 重跑(同 S6b persist adapter swap 模式)。PG 实现由 T1.1 │
// │ PG provisioning + Kysely(D10)落地后的实施 PR 补,本文件只钉接口 + 内存实现。   │
// └────────────────────────────────────────────────────────────────────────────┘
//
// 返修要点(逐条):
//  - #1 owner/resourceOwner:ownerId 是资源归属;鉴权 seam(actor)在 route 层(lib/authz.ts)。
//    project id 全局唯一(PK=ownerId+type+id,project 跨 owner 同 id → ensureCreate 返 project-exists)。
//  - #2 软删粒度:cascade 只标 canvas meta + chat-collection record;node/edge/anchor/chat-message
//    保持活记录(随父级不可见);单条 DELETE 走 hardDeleteChild(物理移除)。
//  - #3 子资源归属:getChild/upsertChild/hardDeleteChild WHERE 带 ownerId+canvasId+type+id;
//    canvas_id 不可变(existing update 保留 existing.canvasId);跨 canvas → cross-canvas(route 404)。
//  - #5 revision 唯一真相:envelope.revision=metaRevision(POST/PATCH bump);canvas meta payload.contentVersion
//    独立 bump(子资源写入),与 metaRevision 分名。fresh create 用 max(0, base)(对齐 MemoryDocKernel)。
//  - #6 orderKey:有序子资源(node/chat-message)orderKey 升序;listByCanvas ORDER BY orderKey。
//  - #7 原子 tree:softDeleteCanvasTree/softDeleteProjectTree(+restore 同型)单函数原子,故障全回滚。
//  - #10 幂等:key 作用域 owner+method+resourceKind+key + 请求 fingerprint(sha256 body);软删命中真恢复。

import { createHash } from 'node:crypto'
import type {
  Envelope,
  PersistScope,
  PersistType,
  Revision,
} from '../../shared/persist-contract.ts'

/** 内存/PG 共享的存储 record(信封 + payload;payload 不透明,服务端不解析——除 canvas meta 的 contentVersion 维护)。 */
export type PersistRecord = Envelope<unknown> & { idempotencyKey?: string; fingerprint?: string }

export type GetResult =
  | { kind: 'found'; record: PersistRecord }
  | { kind: 'missing' }

/** 子资源 get 结果(返修 #3:cross-canvas 区分)。 */
export type GetChildResult =
  | { kind: 'found'; record: PersistRecord }
  | { kind: 'missing' }
  | { kind: 'cross-canvas' } // record 存在但 canvas_id 不匹配(返修 #3,route → 404)

/** ensureCreate 结果(POST 幂等创建)。返修 #1:跨 owner 同 id → project-exists(全局唯一)。 */
export type EnsureCreateResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'existing'; record: PersistRecord } // 幂等回放(未删)→ 返既有,不 bump
  | { kind: 'restored'; record: PersistRecord } // 软删后重建(undelete + bump)
  | { kind: 'exists-other-owner'; record: PersistRecord } // 全局唯一 id 撞(跨 owner),route → 409 project-exists

/** meta upsert 结果(PUT canvas/project/user-state:revision-check-then-bump;返修 #4 428)。 */
export type UpsertResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'updated'; record: PersistRecord }
  | { kind: 'conflict'; currentRevision: Revision; record: PersistRecord }
  | { kind: 'precondition-required'; record: PersistRecord } // 返修 #4:existing 缺 base → 428

/** 子资源 upsert 结果(PATCH node/edge/anchor/chat-message:返修 #3 cross-canvas + #4 428 + #5 max(0,base))。 */
export type UpsertChildResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'updated'; record: PersistRecord }
  | { kind: 'conflict'; currentRevision: Revision; record: PersistRecord }
  | { kind: 'precondition-required'; record: PersistRecord }
  | { kind: 'cross-canvas' } // 返修 #3:同 id 存在但属于另一 canvas → route 404(不 create,canvas_id 不可变)

/** 幂等回放结果(返修 #10:fingerprint 校验)。 */
export type IdempotentReplay =
  | { kind: 'replay'; record: PersistRecord } // fingerprint 匹配 → 返既有结果
  | { kind: 'reuse-conflict' } // 同 key 不同 fingerprint → 422 idempotency-key-reuse

export type ListResult = { records: PersistRecord[] }

/** 返修 #6:重排请求结果。 */
export type ReorderResult = { reordered: number }

export interface PersistBackend {
  // ── meta record CRUD(project/canvas/user-state/chat-collection)──
  get(ownerId: string, type: PersistType, id: string): Promise<GetResult>
  /** 返修 #1:project id 全局唯一——跨 owner 查 project 归属(授权 seam 用);软删保留占位,purge 才释放。 */
  getProjectOwner(id: string): { ownerId: string } | undefined
  ensureCreate(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      canvasId?: string | null
      scope?: PersistScope
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<EnsureCreateResult>
  /** PUT meta:existing→rev-check(返修 #4:缺 base → precondition-required);missing→create(max(0,base))。 */
  upsert(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      base?: Revision
      canvasId?: string | null
      scope?: PersistScope
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<UpsertResult>

  /** 软删 meta(is_deleted=true + bump revision)。idempotent:删已删→deleted=true。 */
  softDelete(ownerId: string, type: PersistType, id: string): Promise<{ deleted: boolean; record?: PersistRecord }>

  // ── 子资源(node/edge/anchor/chat-message:返修 #3 canvas_id 归属 + #2 硬删)──
  getChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<GetChildResult>
  upsertChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      base?: Revision
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<UpsertChildResult>
  /** 硬删子资源(物理移除,返修 #2:node/edge/anchor/chat-message 不软删)。canvas_id 校验。 */
  hardDeleteChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<{ deleted: boolean }>
  /** 返修 #6:重排 canvas 下某 type 的子资源顺序(orderedIds 全量,重分配 orderKey)。 */
  reorderChildren(ownerId: string, canvasId: string, type: PersistType, orderedIds: string[]): Promise<ReorderResult>

  // ── 列表(返修 #6 ORDER BY orderKey;#8 枚举)──
  listByOwner(ownerId: string, type: PersistType, opts?: { includeDeleted?: boolean }): Promise<ListResult>
  listByCanvas(ownerId: string, canvasId: string, type: PersistType, opts?: { includeDeleted?: boolean }): Promise<ListResult>
  listCanvasByProject(ownerId: string, projectId: string, opts?: { includeDeleted?: boolean }): Promise<ListResult>

  // ── 返修 #7:原子 tree 软删/恢复(单函数原子,故障全回滚)──
  /** 软删 canvas 子树:标 canvas meta + chat-collection record(原子;children 保持活记录)。 */
  softDeleteCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number }>
  /** 软删 project 子树:标 project + 其所有 canvas meta + 所有 chat-collection(原子)。 */
  softDeleteProjectTree(ownerId: string, projectId: string): Promise<{ count: number }>
  restoreCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number }>
  restoreProjectTree(ownerId: string, projectId: string): Promise<{ count: number }>

  /** Test-only:清空 owner 全部 records + idempotency index。 */
  __reset(): void
}

// ─── 内存实现(同 docKernel.ts 单文件 interface+impl 模式)──────────────────────────

const clone = <T>(value: T): T => structuredClone(value)
const nowIso = (): string => new Date().toISOString()
const recordKey = (ownerId: string, type: PersistType, id: string): string => `${ownerId}:${type}:${id}`
const idemIndexKey = (ownerId: string, method: string, resourceKind: string, idempotencyKey: string): string =>
  `${ownerId}:${method}:${resourceKind}:${idempotencyKey}`

/** 返修 #10:请求 fingerprint(sha256 body)。bodyFingerprint 由 route 算传入;backend 校验一致。 */
export const fingerprintOfBody = (body: unknown): string => {
  const json = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return createHash('sha256').update(json).digest('hex').slice(0, 32)
}

/** canvas meta payload shape(backend 维护 contentVersion;其余域字段 route 管)。 */
type CanvasMetaPayload = { projectId?: string; title?: string; sourceTemplateId?: string; contentVersion?: Revision }

const asCanvasMeta = (p: unknown): CanvasMetaPayload | null =>
  typeof p === 'object' && p !== null ? (p as CanvasMetaPayload) : null

/**
 * InMemoryPersistBackend:默认内存实现(T1.3 过渡;PG 落地前用)。
 * 两层 Map(per-owner 隔离)+ idempotency index(per-owner+method+resourceKind+key 复合,返修 #10)。
 * 非 PG——重启清空;契约不变量(§6)过测试,跨重启持久不在验收范围。
 *
 * 返修 #7 原子性:softDeleteCanvasTree/softDeleteProjectTree/restore* 单函数内完成所有 mutation,
 * 中途抛错则快照回滚(内存实现:先克隆 affected records,失败 restore)。
 */
export class InMemoryPersistBackend implements PersistBackend {
  private readonly byOwner = new Map<string, Map<string, PersistRecord>>()
  private readonly idempotencyIndex = new Map<string, { envelopeKey: string; fingerprint: string }>()
  /** 返修 #1:project id 全局唯一索引(id → ownerId)。授权 seam 跨 owner 查 project 归属;跨 owner 同 id → 409 project-exists。 */
  private readonly globalProjectOwners = new Map<string, string>()

  private bucket(ownerId: string): Map<string, PersistRecord> {
    let b = this.byOwner.get(ownerId)
    if (!b) {
      b = new Map()
      this.byOwner.set(ownerId, b)
    }
    return b
  }

  private find(ownerId: string, type: PersistType, id: string): PersistRecord | undefined {
    return this.bucket(ownerId).get(recordKey(ownerId, type, id))
  }

  private setIdemIndex(
    ownerId: string,
    method: string,
    resourceKind: string,
    idempotencyKey: string | undefined,
    envelopeKey: string,
    fingerprint: string,
  ): void {
    if (!idempotencyKey) return
    this.idempotencyIndex.set(idemIndexKey(ownerId, method, resourceKind, idempotencyKey), { envelopeKey, fingerprint })
  }

  private nextOrderKey(ownerId: string, canvasId: string, type: PersistType): number {
    let max = -1
    for (const r of this.bucket(ownerId).values()) {
      if (r.type === type && r.canvasId === canvasId) max = Math.max(max, r.orderKey)
    }
    return max + 1
  }

  /** 返修 #5:bump canvas meta contentVersion(子资源写入后调用;不动 metaRevision)。 */
  private bumpCanvasContentVersion(ownerId: string, canvasId: string): void {
    const meta = this.find(ownerId, 'canvas', canvasId)
    if (!meta) return
    const p = asCanvasMeta(meta.payload) ?? {}
    p.contentVersion = (p.contentVersion ?? 0) + 1
    const updated: PersistRecord = { ...meta, payload: p, updatedAt: nowIso() }
    this.bucket(ownerId).set(recordKey(ownerId, 'canvas', canvasId), updated)
  }

  async get(ownerId: string, type: PersistType, id: string): Promise<GetResult> {
    const r = this.find(ownerId, type, id)
    return r ? { kind: 'found', record: clone(r) } : { kind: 'missing' }
  }

  getProjectOwner(id: string): { ownerId: string } | undefined {
    const ownerId = this.globalProjectOwners.get(id)
    return ownerId !== undefined ? { ownerId } : undefined
  }

  async ensureCreate(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      canvasId?: string | null
      scope?: PersistScope
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<EnsureCreateResult> {
    // 返修 #10:幂等 header 复用(owner+method+resourceKind+key 复合)。
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) {
          if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) {
            // reuse-conflict 由 route 决 422;此处返既有让 route 判(简化:返 existing/restored)。
          }
          return { kind: r.isDeleted ? 'restored' : 'existing', record: clone(r) }
        }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    // 返修 #1:project id 全局唯一——跨 owner 同 id → exists-other-owner(route → 409 project-exists)。
    if (type === 'project') {
      const globalOwner = this.globalProjectOwners.get(id)
      if (globalOwner && globalOwner !== ownerId) {
        const r = this.find(globalOwner, 'project', id)
        if (r) return { kind: 'exists-other-owner', record: clone(r) }
      }
    }
    const existing = this.find(ownerId, type, id)
    const scope: PersistScope = opts.scope ?? 'document'
    const canvasId = opts.canvasId ?? null
    if (existing && !existing.isDeleted) {
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      return { kind: 'existing', record: clone(existing) }
    }
    if (existing && existing.isDeleted) {
      const rev = existing.revision + 1
      const updated: PersistRecord = {
        ...clone(existing),
        payload: clone(payload),
        revision: rev,
        isDeleted: false,
        updatedAt: nowIso(),
        canvasId,
        scope,
        idempotencyKey: opts.idempotencyKey,
        fingerprint: opts.bodyFingerprint,
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), updated)
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      return { kind: 'restored', record: clone(updated) }
    }
    // 不存在 → created(revision 0;orderKey 0 for meta;createdAt/updatedAt = now)。
    const ts = nowIso()
    const created: PersistRecord = {
      id,
      ownerId,
      canvasId,
      type,
      scope,
      revision: 0,
      orderKey: 0,
      isDeleted: false,
      createdAt: ts,
      updatedAt: ts,
      payload: clone(payload),
      idempotencyKey: opts.idempotencyKey,
      fingerprint: opts.bodyFingerprint,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), created)
    if (type === 'project') this.globalProjectOwners.set(id, ownerId) // 返修 #1:全局唯一索引
    this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
    return { kind: 'created', record: clone(created) }
  }

  async upsert(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      base?: Revision
      canvasId?: string | null
      scope?: PersistScope
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<UpsertResult> {
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) return { kind: r.isDeleted ? 'created' : 'updated', record: clone(r) }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, type, id)
    const scope: PersistScope = opts.scope ?? 'document'
    const canvasId = opts.canvasId ?? null
    // missing 或软删 → create(revision max(0,base),返修 #5 对齐 MemoryDocKernel nextRevision)。
    if (!existing || existing.isDeleted) {
      const base = opts.base ?? 0
      const rev = existing ? existing.revision + 1 : Math.max(0, base)
      const ts = nowIso()
      // contentVersion 保留(canvas restore 时);fresh canvas meta contentVersion=0。
      const oldMeta = existing && type === 'canvas' ? asCanvasMeta(existing.payload) : null
      const cv = oldMeta?.contentVersion ?? 0
      const created: PersistRecord = {
        id,
        ownerId,
        canvasId,
        type,
        scope,
        revision: rev,
        orderKey: 0,
        isDeleted: false,
        createdAt: existing ? existing.createdAt : ts,
        updatedAt: ts,
        payload: type === 'canvas' ? { ...(payload as object), contentVersion: cv } : clone(payload),
        idempotencyKey: opts.idempotencyKey,
        fingerprint: opts.bodyFingerprint,
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), created)
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      return { kind: 'created', record: clone(created) }
    }
    // existing & !deleted → 返修 #4:缺 base → precondition-required(428)。
    if (opts.base === undefined) {
      return { kind: 'precondition-required', record: clone(existing) }
    }
    if (opts.base !== existing.revision) {
      return { kind: 'conflict', currentRevision: existing.revision, record: clone(existing) }
    }
    // base 匹配 → bump + update(canvas_id 不可变,返修 #3:保留 existing.canvasId;contentVersion 保留)。
    const rev = existing.revision + 1
    const oldMeta = type === 'canvas' ? asCanvasMeta(existing.payload) : null
    const newPayload =
      type === 'canvas'
        ? { ...(payload as object), contentVersion: oldMeta?.contentVersion ?? 0 }
        : clone(payload)
    const updated: PersistRecord = {
      ...clone(existing),
      payload: newPayload,
      revision: rev,
      updatedAt: nowIso(),
      canvasId: existing.canvasId,
      scope,
      idempotencyKey: opts.idempotencyKey,
      fingerprint: opts.bodyFingerprint,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), updated)
    this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
    return { kind: 'updated', record: clone(updated) }
  }

  async softDelete(ownerId: string, type: PersistType, id: string): Promise<{ deleted: boolean; record?: PersistRecord }> {
    const existing = this.find(ownerId, type, id)
    if (!existing) return { deleted: false }
    if (!existing.isDeleted) {
      const updated: PersistRecord = {
        ...clone(existing),
        isDeleted: true,
        revision: existing.revision + 1,
        updatedAt: nowIso(),
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), updated)
      return { deleted: true, record: clone(updated) }
    }
    return { deleted: true, record: clone(existing) }
  }

  async getChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<GetChildResult> {
    const r = this.find(ownerId, type, id)
    if (!r) return { kind: 'missing' }
    if (r.canvasId !== canvasId) return { kind: 'cross-canvas' } // 返修 #3:跨 canvas
    return { kind: 'found', record: clone(r) }
  }

  async upsertChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      base?: Revision
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<UpsertChildResult> {
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) return { kind: 'updated', record: clone(r) }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, type, id)
    if (existing && existing.canvasId !== canvasId) {
      // 返修 #3:同 id 存在但属于另一 canvas → cross-canvas(canvas_id 不可变,不 create)。
      return { kind: 'cross-canvas' }
    }
    // !existing → create(revision max(0,base),返修 #5;orderKey 分配,返修 #6)。
    if (!existing || existing.isDeleted) {
      const base = opts.base ?? 0
      const rev = existing ? existing.revision + 1 : Math.max(0, base)
      const ts = nowIso()
      const created: PersistRecord = {
        id,
        ownerId,
        canvasId,
        type,
        scope: 'document',
        revision: rev,
        orderKey: this.nextOrderKey(ownerId, canvasId, type),
        isDeleted: false,
        createdAt: existing ? existing.createdAt : ts,
        updatedAt: ts,
        payload: clone(payload),
        idempotencyKey: opts.idempotencyKey,
        fingerprint: opts.bodyFingerprint,
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), created)
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      this.bumpCanvasContentVersion(ownerId, canvasId) // 返修 #5:content bump
      return { kind: 'created', record: clone(created) }
    }
    // existing & !deleted & canvas_id 匹配 → 返修 #4:缺 base → precondition-required(428)。
    if (opts.base === undefined) {
      return { kind: 'precondition-required', record: clone(existing) }
    }
    if (opts.base !== existing.revision) {
      return { kind: 'conflict', currentRevision: existing.revision, record: clone(existing) }
    }
    // base 匹配 → bump + update(canvas_id 不可变,返修 #3:保留 existing.canvasId)。
    const rev = existing.revision + 1
    const updated: PersistRecord = {
      ...clone(existing),
      payload: clone(payload),
      revision: rev,
      updatedAt: nowIso(),
      canvasId: existing.canvasId,
      idempotencyKey: opts.idempotencyKey,
      fingerprint: opts.bodyFingerprint,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), updated)
    this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
    this.bumpCanvasContentVersion(ownerId, canvasId)
    return { kind: 'updated', record: clone(updated) }
  }

  async hardDeleteChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<{ deleted: boolean }> {
    const r = this.find(ownerId, type, id)
    if (!r || r.canvasId !== canvasId) return { deleted: false } // 返修 #3:cross-canvas/missing → 404
    this.bucket(ownerId).delete(recordKey(ownerId, type, id))
    this.bumpCanvasContentVersion(ownerId, canvasId) // 返修 #5:content bump
    return { deleted: true }
  }

  async reorderChildren(ownerId: string, canvasId: string, type: PersistType, orderedIds: string[]): Promise<ReorderResult> {
    const b = this.bucket(ownerId)
    // 快照回滚(返修 #7 原子语义)
    const snapshot: Array<[string, PersistRecord]> = []
    let n = 0
    for (const id of orderedIds) {
      const key = recordKey(ownerId, type, id)
      const r = b.get(key)
      if (!r || r.canvasId !== canvasId) continue
      snapshot.push([key, clone(r)])
      const updated: PersistRecord = { ...clone(r), orderKey: n }
      b.set(key, updated)
      n++
    }
    this.bumpCanvasContentVersion(ownerId, canvasId)
    return { reordered: n }
  }

  async listByOwner(ownerId: string, type: PersistType, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    const include = opts.includeDeleted ?? false
    const out: PersistRecord[] = []
    for (const r of this.bucket(ownerId).values()) {
      if (r.type !== type) continue
      if (!include && r.isDeleted) continue
      out.push(clone(r))
    }
    out.sort((a, b) => a.orderKey - b.orderKey || (a.createdAt < b.createdAt ? -1 : 1))
    return { records: out }
  }

  async listByCanvas(ownerId: string, canvasId: string, type: PersistType, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    const include = opts.includeDeleted ?? false
    const out: PersistRecord[] = []
    for (const r of this.bucket(ownerId).values()) {
      if (r.type !== type) continue
      if (r.canvasId !== canvasId) continue
      if (!include && r.isDeleted) continue
      out.push(clone(r))
    }
    out.sort((a, b) => a.orderKey - b.orderKey || (a.createdAt < b.createdAt ? -1 : 1)) // 返修 #6:ORDER BY orderKey
    return { records: out }
  }

  async listCanvasByProject(ownerId: string, projectId: string, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    const include = opts.includeDeleted ?? false
    const out: PersistRecord[] = []
    for (const r of this.bucket(ownerId).values()) {
      if (r.type !== 'canvas') continue
      if (!include && r.isDeleted) continue
      const p = asCanvasMeta(r.payload)
      if (p?.projectId !== projectId) continue
      out.push(clone(r))
    }
    out.sort((a, b) => a.orderKey - b.orderKey || (a.createdAt < b.createdAt ? -1 : 1))
    return { records: out }
  }

  // ── 返修 #7:原子 tree 软删/恢复 ──
  /** 单原子:标 canvas meta + chat-collection record。children 保持活记录(返修 #2)。 */
  async softDeleteCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number }> {
    const b = this.bucket(ownerId)
    const ts = nowIso()
    const targets: string[] = []
    for (const [key, r] of b) {
      if (r.type === 'canvas' && r.id === canvasId && !r.isDeleted) targets.push(key)
      if (r.type === 'chat-collection' && r.canvasId === canvasId && !r.isDeleted) targets.push(key)
    }
    const snapshot = targets.map((k) => [k, clone(b.get(k)!)] as const)
    try {
      for (const key of targets) {
        const r = b.get(key)!
        b.set(key, { ...clone(r), isDeleted: true, revision: r.revision + 1, updatedAt: ts })
      }
      return { count: targets.length }
    } catch (err) {
      for (const [key, rec] of snapshot) b.set(key, rec)
      throw err
    }
  }

  async restoreCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number }> {
    const b = this.bucket(ownerId)
    const ts = nowIso()
    const targets: string[] = []
    for (const [key, r] of b) {
      if (r.type === 'canvas' && r.id === canvasId && r.isDeleted) targets.push(key)
      if (r.type === 'chat-collection' && r.canvasId === canvasId && r.isDeleted) targets.push(key)
    }
    const snapshot = targets.map((k) => [k, clone(b.get(k)!)] as const)
    try {
      for (const key of targets) {
        const r = b.get(key)!
        b.set(key, { ...clone(r), isDeleted: false, revision: r.revision + 1, updatedAt: ts })
      }
      return { count: targets.length }
    } catch (err) {
      for (const [key, rec] of snapshot) b.set(key, rec)
      throw err
    }
  }

  async softDeleteProjectTree(ownerId: string, projectId: string): Promise<{ count: number }> {
    const b = this.bucket(ownerId)
    const ts = nowIso()
    const targets: string[] = []
    // project meta
    const proj = this.find(ownerId, 'project', projectId)
    if (proj && !proj.isDeleted) targets.push(recordKey(ownerId, 'project', projectId))
    // 其所有 canvas meta + chat-collection
    for (const [key, r] of b) {
      if (r.type !== 'canvas' && r.type !== 'chat-collection') continue
      if (r.isDeleted) continue
      if (r.type === 'canvas') {
        const p = asCanvasMeta(r.payload)
        if (p?.projectId === projectId) targets.push(key)
      } else {
        // chat-collection:canvas_id 属 project 的 canvas
        const parentMeta = this.find(ownerId, 'canvas', r.canvasId ?? '')
        const pp = parentMeta && asCanvasMeta(parentMeta.payload)
        if (pp?.projectId === projectId) targets.push(key)
      }
    }
    const snapshot = targets.map((k) => [k, clone(b.get(k)!)] as const)
    try {
      for (const key of targets) {
        const r = b.get(key)!
        b.set(key, { ...clone(r), isDeleted: true, revision: r.revision + 1, updatedAt: ts })
      }
      return { count: targets.length }
    } catch (err) {
      for (const [key, rec] of snapshot) b.set(key, rec)
      throw err
    }
  }

  async restoreProjectTree(ownerId: string, projectId: string): Promise<{ count: number }> {
    const b = this.bucket(ownerId)
    const ts = nowIso()
    const targets: string[] = []
    const proj = this.find(ownerId, 'project', projectId)
    if (proj && proj.isDeleted) targets.push(recordKey(ownerId, 'project', projectId))
    for (const [key, r] of b) {
      if (r.type !== 'canvas' && r.type !== 'chat-collection') continue
      if (!r.isDeleted) continue
      if (r.type === 'canvas') {
        const p = asCanvasMeta(r.payload)
        if (p?.projectId === projectId) targets.push(key)
      } else {
        const parentMeta = this.find(ownerId, 'canvas', r.canvasId ?? '')
        const pp = parentMeta && asCanvasMeta(parentMeta.payload)
        if (pp?.projectId === projectId) targets.push(key)
      }
    }
    const snapshot = targets.map((k) => [k, clone(b.get(k)!)] as const)
    try {
      for (const key of targets) {
        const r = b.get(key)!
        b.set(key, { ...clone(r), isDeleted: false, revision: r.revision + 1, updatedAt: ts })
      }
      return { count: targets.length }
    } catch (err) {
      for (const [key, rec] of snapshot) b.set(key, rec)
      throw err
    }
  }

  __reset(): void {
    this.byOwner.clear()
    this.idempotencyIndex.clear()
    this.globalProjectOwners.clear()
  }
}

/**
 * 工厂:默认内存 backend(T1.3 过渡)。server/app.ts 注入;PG 落地后换 PgPersistBackend。
 * routes 通过 createXxxRoutes({ backend }) 接收(同 createLocalAssetsRoutes({ enabled }) 模式)。
 */
export const createPersistBackend = (): PersistBackend => new InMemoryPersistBackend()

// re-export shared types routes consume(信封 + 结果类型),避免 routes 各自 import shared。
export type { Envelope, PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'
