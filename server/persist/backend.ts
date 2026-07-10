// server/persist/backend.ts
// T1.3 前置:PersistBackend 存储接口(DP-5 信封列)+ 内存实现。
// 权威:docs/decisions/api-surface.md §0/§2/§6。
//
// ┌────────────────────────────────────────────────────────────────────────────┐
// │ TODO(PG / T1.1 批复后):PgPersistBackend 实现本接口。信封列 + payload jsonb,  │
// │ 附录 A SQL 草案(api-surface.md)。swap 不改路由/契约:server/app.ts 注入点     │
// │ 从 InMemoryPersistBackend 换 PgPersistBackend,路由 handler 零改动,契约测试   │
// │ 从内存换成 PG fixture 重跑(同 S6b persist adapter swap 模式)。PG 实现由 T1.1 │
// │ PG provisioning + Kysely(D10)落地后的实施 PR 补,本文件只钉接口 + 内存实现。   │
// └────────────────────────────────────────────────────────────────────────────┘
//
// 内存语义(§6):Map<ownerFp, Map<envelopeKey, Record>>;重启清空(同 tasks registry
// V02)。"换电脑原样在"验收在 PG + 服务器部署后兑现;本内存实现只测契约不变量
// (owner 隔离/revision 409/cascade 软删/413/幂等),不测跨重启持久。

import type {
  Envelope,
  PersistScope,
  PersistType,
  Revision,
} from '../../shared/persist-contract.ts'

/** 内存/PG 共享的存储 record(信封 + payload;payload 不透明,服务端不解析)。 */
export type PersistRecord = Envelope<unknown> & { idempotencyKey?: string }

export type GetResult =
  | { kind: 'found'; record: PersistRecord }
  | { kind: 'missing' }

/** ensureCreate 结果(POST 幂等创建:同 id+owner 已存在→existing,不重建)。 */
export type EnsureCreateResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'existing'; record: PersistRecord } // 幂等回放(未删)→ 返既有,不 bump
  | { kind: 'restored'; record: PersistRecord } // 软删后重建(undelete + bump)

/** upsert 结果(PATCH/PUT:revision-check-then-bump;missing→create)。 */
export type UpsertResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'updated'; record: PersistRecord }
  | { kind: 'conflict'; currentRevision: Revision; record: PersistRecord }

export type ListResult = { records: PersistRecord[] }

export interface PersistBackend {
  // ── 单 record CRUD ──
  get(ownerId: string, type: PersistType, id: string): Promise<GetResult>

  /** POST 幂等创建(projects/canvas/chat):同 id+owner 未删→existing(不 bump);
   *  软删→restored(undelete + bump);不存在→created。无 revision check(create 无 base)。 */
  ensureCreate(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts?: { canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string },
  ): Promise<EnsureCreateResult>

  /** PATCH/PUT(node/edge/anchor/user-state):missing→created;existing→revision-check
   *  (stale→conflict,匹配→bump);软删→restored。revision 缺失→LWW overwrite+ bump。 */
  upsert(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { revision?: Revision; canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string },
  ): Promise<UpsertResult>

  /** 软删(is_deleted=true + bump revision)。idempotent:删已删→deleted=true(不报错)。 */
  softDelete(ownerId: string, type: PersistType, id: string): Promise<{ deleted: boolean; record?: PersistRecord }>

  // ── 列表 ──
  listByOwner(ownerId: string, type: PersistType, opts?: { includeDeleted?: boolean }): Promise<ListResult>
  listByCanvas(ownerId: string, canvasId: string, type: PersistType, opts?: { includeDeleted?: boolean }): Promise<ListResult>

  /** 级联软删一棵 canvas 子树(WHERE canvas_id === canvasId,全 type;DP-3/§4.2)。
   *  meta record(type='canvas', canvas_id=null)不在内,由调用方显式 softDelete。 */
  cascadeSoftDeleteByCanvas(ownerId: string, canvasId: string): Promise<{ count: number }>

  /** Test-only:清空 owner 全部 records + idempotency index(同 __resetTaskRegistry)。 */
  __reset(): void
}

// ─── 内存实现(同 docKernel.ts 单文件 interface+impl 模式)──────────────────────────

const clone = <T>(value: T): T => structuredClone(value)
const nowIso = (): string => new Date().toISOString()
const recordKey = (ownerId: string, type: PersistType, id: string): string => `${ownerId}:${type}:${id}`
const idemIndexKey = (ownerId: string, idempotencyKey: string): string => `${ownerId}:${idempotencyKey}`

/**
 * InMemoryPersistBackend:默认内存实现(T1.3 过渡;PG 落地前用)。
 * 两层 Map(per-owner 隔离)+ idempotency index(per-owner 复合,同 FX-2 idemIndexKey)。
 * 非 PG——重启清空;契约不变量(§6)过测试,跨重启持久不在验收范围。
 */
export class InMemoryPersistBackend implements PersistBackend {
  private readonly byOwner = new Map<string, Map<string, PersistRecord>>()
  private readonly idempotencyIndex = new Map<string, string>()

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

  async get(ownerId: string, type: PersistType, id: string): Promise<GetResult> {
    const r = this.find(ownerId, type, id)
    return r ? { kind: 'found', record: clone(r) } : { kind: 'missing' }
  }

  async ensureCreate(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string } = {},
  ): Promise<EnsureCreateResult> {
    // 1. 幂等 header 复用(同 FX-2):同 key+owner 命中既有 record → 返既有(不 bump)。
    if (opts.idempotencyKey) {
      const existingKey = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.idempotencyKey))
      if (existingKey) {
        const r = this.bucket(ownerId).get(existingKey)
        if (r) return { kind: r.isDeleted ? 'restored' : 'existing', record: clone(r) }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, type, id)
    const scope: PersistScope = opts.scope ?? 'document'
    const canvasId = opts.canvasId ?? null
    if (existing && !existing.isDeleted) {
      // 2. 同 id+owner 未删 → 幂等回放(返既有,不 bump;POST 同 id 再来)。
      this.setIdemIndex(ownerId, opts.idempotencyKey, recordKey(ownerId, type, id))
      return { kind: 'existing', record: clone(existing) }
    }
    if (existing && existing.isDeleted) {
      // 3. 软删后重建(undelete + bump;payload 用新值)。
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
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), updated)
      this.setIdemIndex(ownerId, opts.idempotencyKey, recordKey(ownerId, type, id))
      return { kind: 'restored', record: clone(updated) }
    }
    // 4. 不存在 → created(revision 0;createdAt/updatedAt = now)。
    const ts = nowIso()
    const created: PersistRecord = {
      id,
      ownerId,
      canvasId,
      type,
      scope,
      revision: 0,
      isDeleted: false,
      createdAt: ts,
      updatedAt: ts,
      payload: clone(payload),
      idempotencyKey: opts.idempotencyKey,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), created)
    this.setIdemIndex(ownerId, opts.idempotencyKey, recordKey(ownerId, type, id))
    return { kind: 'created', record: clone(created) }
  }

  async upsert(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { revision?: Revision; canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string },
  ): Promise<UpsertResult> {
    if (opts.idempotencyKey) {
      const existingKey = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.idempotencyKey))
      if (existingKey) {
        const r = this.bucket(ownerId).get(existingKey)
        // 幂等回放:返既有 record(已 bump 过,不重复 bump)。race 中若被删,仍返既有
        // 快照(过渡语义;routes 拿 id+revision,deleted 状态由后续操作决定,非本契约重点)。
        if (r) return { kind: 'updated', record: clone(r) }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, type, id)
    const scope: PersistScope = opts.scope ?? 'document'
    const canvasId = opts.canvasId ?? null
    // missing 或软删 → create。revision 服务端权威:fresh create=0(同 ensureCreate),
    // undelete=existing.revision+1。opts.revision(base)只用于下文 existing-not-deleted 的冲突校验,
    // 不让客户端设初始 revision(防客户端控制 revision 破坏 LWW tie-break)。
    if (!existing || existing.isDeleted) {
      const rev = existing ? existing.revision + 1 : 0
      const ts = nowIso()
      const created: PersistRecord = {
        id,
        ownerId,
        canvasId,
        type,
        scope,
        revision: rev,
        isDeleted: false,
        createdAt: existing ? existing.createdAt : ts,
        updatedAt: ts,
        payload: clone(payload),
        idempotencyKey: opts.idempotencyKey,
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), created)
      this.setIdemIndex(ownerId, opts.idempotencyKey, recordKey(ownerId, type, id))
      return { kind: 'created', record: clone(created) }
    }
    // existing & !deleted → revision check (stale → conflict)
    if (opts.revision !== undefined && opts.revision !== existing.revision) {
      return { kind: 'conflict', currentRevision: existing.revision, record: clone(existing) }
    }
    // revision 匹配(或缺失=LWW overwrite)→ bump + update
    const rev = existing.revision + 1
    const updated: PersistRecord = {
      ...clone(existing),
      payload: clone(payload),
      revision: rev,
      updatedAt: nowIso(),
      canvasId,
      scope,
      idempotencyKey: opts.idempotencyKey,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), updated)
    this.setIdemIndex(ownerId, opts.idempotencyKey, recordKey(ownerId, type, id))
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
    return { deleted: true, record: clone(existing) } // idempotent:已删→still deleted=true
  }

  async listByOwner(ownerId: string, type: PersistType, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    const include = opts.includeDeleted ?? false
    const out: PersistRecord[] = []
    for (const r of this.bucket(ownerId).values()) {
      if (r.type !== type) continue
      if (!include && r.isDeleted) continue
      out.push(clone(r))
    }
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
    return { records: out }
  }

  async cascadeSoftDeleteByCanvas(ownerId: string, canvasId: string): Promise<{ count: number }> {
    const b = this.bucket(ownerId)
    let count = 0
    for (const [key, r] of b) {
      if (r.canvasId !== canvasId) continue
      if (r.isDeleted) continue
      b.set(key, { ...clone(r), isDeleted: true, revision: r.revision + 1, updatedAt: nowIso() })
      count++
    }
    return { count }
  }

  __reset(): void {
    this.byOwner.clear()
    this.idempotencyIndex.clear()
  }

  private setIdemIndex(ownerId: string, idempotencyKey: string | undefined, key: string): void {
    if (!idempotencyKey) return
    this.idempotencyIndex.set(idemIndexKey(ownerId, idempotencyKey), key)
  }
}

/**
 * 工厂:默认内存 backend(T1.3 过渡)。server/app.ts 注入;PG 落地后换 PgPersistBackend。
 * routes 通过 createXxxRoutes({ backend }) 接收(同 createLocalAssetsRoutes({ enabled }) 模式)。
 */
export const createPersistBackend = (): PersistBackend => new InMemoryPersistBackend()

// re-export shared types routes consume(信封 + 结果类型),避免 routes 各自 import shared。
export type { Envelope, PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'
