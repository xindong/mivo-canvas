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

/** ensureCreate 结果(POST 幂等创建)。返修 #1:跨 owner 同 id → project-exists(全局唯一)。N4:同 key 不同 body → reuse-conflict。F4:canvas 跨 owner 同 id → exists-other-owner(409 canvas-exists)。F1:父 project 软删 → parent-not-live(route → 404,禁独立 child restore)。 */
export type EnsureCreateResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'existing'; record: PersistRecord } // 幂等回放(未删)→ 返既有,不 bump
  | { kind: 'restored'; record: PersistRecord } // 软删后重建(undelete + bump + restore tree,N2)
  | { kind: 'exists-other-owner'; record: PersistRecord } // 全局唯一 id 撞(跨 owner),route → 409 project-exists/canvas-exists
  | { kind: 'reuse-conflict' } // N4:同 idem key 不同 fingerprint(不同 body)→ route 422
  | { kind: 'parent-not-live' } // F1:canvas 父 project 软删/不存在 → route 404 unknown-project(禁独立 child restore)

/**
 * 子资源 ensureCreate 结果(chat-message POST)。N3:canvas_id 校验(cross-canvas);
 * N4:同 key 不同 body → reuse-conflict;N2:软删命中真恢复。
 */
export type EnsureChildResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'existing'; record: PersistRecord }
  | { kind: 'restored'; record: PersistRecord }
  | { kind: 'cross-canvas' } // N3:同 id 存在但属于另一 canvas → route 404(canvas_id 不可变)
  | { kind: 'reuse-conflict' } // N4:同 idem key 不同 fingerprint → route 422

/** meta upsert 结果(PUT canvas/project/user-state:revision-check-then-bump;返修 #4 428)。N4:reuse-conflict。F1:canvas PUT move 目标 project 软删 → parent-not-live(route → 404)。F3:upsert missing 路径跨 owner 同 id → exists-other-owner(route → 409 project-exists/canvas-exists,与 ensureCreate 同语义;route 层 authz+预检已阻,backend 防御性拒绝,不跨 owner insert/不覆盖缓存)。 */
export type UpsertResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'updated'; record: PersistRecord }
  | { kind: 'conflict'; currentRevision: Revision; record: PersistRecord }
  | { kind: 'precondition-required'; record: PersistRecord } // 返修 #4:existing 缺 base → 428
  | { kind: 'reuse-conflict' } // N4:同 idem key 不同 fingerprint → route 422
  | { kind: 'parent-not-live' } // F1:canvas PUT move 目标 project 软删/不存在 → route 404 unknown-project
  | { kind: 'exists-other-owner'; record: PersistRecord } // F3:upsert missing 跨 owner 同 id(全局唯一),route → 409 project-exists/canvas-exists(与 ensureCreate 同语义)

/** 子资源 upsert 结果(PATCH node/edge/anchor/chat-message:返修 #3 cross-canvas + #4 428 + #5 max(0,base)+N4 reuse-conflict)。 */
export type UpsertChildResult =
  | { kind: 'created'; record: PersistRecord }
  | { kind: 'updated'; record: PersistRecord }
  | { kind: 'conflict'; currentRevision: Revision; record: PersistRecord }
  | { kind: 'precondition-required'; record: PersistRecord }
  | { kind: 'cross-canvas' } // 返修 #3:同 id 存在但属于另一 canvas → route 404(不 create,canvas_id 不可变)
  | { kind: 'reuse-conflict' } // N4:同 idem key 不同 fingerprint → route 422
  | { kind: 'not-found' } // DP-6R P2-1:strict-update(chat PATCH)——actor bucket 无此 msgId/已删 → route 404 unknown-message(不许借 PATCH create)

/** 幂等回放结果(返修 #10:fingerprint 校验)。 */
export type IdempotentReplay =
  | { kind: 'replay'; record: PersistRecord } // fingerprint 匹配 → 返既有结果
  | { kind: 'reuse-conflict' } // 同 key 不同 fingerprint → 422 idempotency-key-reuse

export type ListResult = { records: PersistRecord[] }

/**
 * 返修 N8/F5:重排结果。
 * - `ok`:orderedIds 与 live set 全等且唯一,重分配 orderKey,bump contentVersion+updatedAt。
 *   **DP-6R P1-2**:type=chat-message 时,`contentVersion` 携带 per-actor×canvas **orderRevision**
 *   (bump 后值),与共享 canvas contentVersion 解耦。
 * - `conflict`:If-Match base stale → 409(两并发一成一 409)。chat-message 时 `currentContentVersion`
 *   = chat orderRevision(非共享 cv);其余 type = canvas contentVersion。
 * - `precondition-required`:reserved(F5 base 必填,route 已对 missing If-Match 返 428;backend 不再触发此 variant,保留为防御型)。
 * - `bad`:orderedIds 与 live set 不全等(mismatch)或含重复(duplicate)→ 400。
 */
export type ReorderResult =
  | { kind: 'ok'; reordered: number; contentVersion: Revision }
  | { kind: 'conflict'; currentContentVersion: Revision }
  | { kind: 'precondition-required' }
  | { kind: 'bad'; reason: 'mismatch' | 'duplicate' }

export interface PersistBackend {
  // ── meta record CRUD(project/canvas/user-state/chat-collection)──
  get(ownerId: string, type: PersistType, id: string): Promise<GetResult>
  /** 返修 #1:project id 全局唯一——跨 owner 查 project 归属(授权 seam 用);软删保留占位,purge 才释放。 */
  getProjectOwner(id: string): { ownerId: string } | undefined
  /** 返修 N7:canvas id 全局归属(授权 seam canAccessCanvas 用;跨 owner → 404)。 */
  getCanvasOwner(id: string): { ownerId: string } | undefined
  /**
   * F1:project 存在且 !isDeleted(live)。canvas POST/PUT(move)前验 parent project live;
   * 软删 parent 下禁独立 child create/restore(只许 POST project 走 restoreProjectTree 整树恢复)。
   */
  projectLive(ownerId: string, projectId: string): boolean
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
  /**
   * F1:canvas + chat-collection 单一原子创建原语(route POST /api/canvas 只调这一个,防 ensureCreate(canvas)→
   * 独立 ensureCreate(chat-collection) 两段间的 TOCTOU——中间插入 DELETE project 会产生软删树下的 live orphan
   * collection)。内含 F4(canvas id 全局唯一)+ F1(parent project live)+ 幂等 replay(reuse-conflict/restored/existing)
   * + fresh create 时 canvas meta + chat-collection 同一原子操作(快照回滚);restored 走 restoreCanvasTree(原子恢复
   * canvas meta + chat-collection)+ ensureCollectionLive(防旧数据遗漏)。返 EnsureCreateResult(与 ensureCreate 同形)。
   */
  createCanvasWithCollection(
    ownerId: string,
    canvasId: string,
    canvasPayload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<EnsureCreateResult>
  /**
   * 返修 N3:子资源(chat-message)幂等创建——canvas_id 校验(existing/idem-replay/cross-canvas 全验)。
   * N4:同 idem key 不同 fingerprint → reuse-conflict;N2:软删命中真恢复。
   */
  ensureCreateChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: {
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
    },
  ): Promise<EnsureChildResult>
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
      /** DP-6R P2-1:true → strict-update 原语:actor bucket 无此 id/已删 → not-found(不许借 PATCH create)。单原子实现,不许先 get 再 upsert(TOCTOU)。chat PATCH 路由置 true。 */
      strictUpdate?: boolean
    },
  ): Promise<UpsertChildResult>
  /** 硬删子资源(物理移除,返修 #2:node/edge/anchor/chat-message 不软删)。canvas_id 校验。 */
  hardDeleteChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<{ deleted: boolean }>
  /**
   * 返修 N8/F5:重排 canvas 下某 type 子资源顺序。
   * orderedIds 须与 live set 全等且唯一;**If-Match(contentVersion base)必填**(F5 seam 必填——
   * 不传 base 编译失败,见 contract test @ts-expect-error 互锁);stale → conflict;成功重分配 orderKey + bump contentVersion+updatedAt。
   *
   * **DP-6R P1-2**:type=chat-message 时,base = per-actor×canvas **orderRevision**(非共享 cv);
   * 同事务 compare+bump——同 base 两并发一成一败;A/B(不同 actor)各自独立 cursor 互不冲突;
   * node 写 bump 共享 cv 但不触 chat orderRevision → node 写不使 chat reorder 误 409。
   */
  reorderChildren(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    orderedIds: string[],
    opts: { base: Revision },
  ): Promise<ReorderResult>
  /**
   * DP-6R P1-2:读 per-actor×canvas chat collection 的 orderRevision(GET /api/canvas/:id/chat 用,
   * 返 ListChatMessagesResponse.orderRevision;client 据此作 chat reorder 的 If-Match base)。缺省 0。
   * 仅对 chat-message collection 有意义(ownerId=actor);其余 type 不调用。
   */
  getChatOrderRevision(ownerId: string, canvasId: string): Promise<Revision>

  /**
   * DP-6R P1-2(返修 R2-P1-2):原子读 per-actor×canvas chat collection 的 (messages, orderRevision) **对**。
   * GET /api/canvas/:id/chat 用——messages 与 orderRevision 同一快照(memory 同步临界区无 await;PG 单事务
   * REPEATABLE READ 一致 snapshot),消除 listByCanvas + getChatOrderRevision 两 await 间隙的 torn pair
   * (旧 messages + 新 rev → client 下次 reorder 用新 base 配旧顺序被误接受,绕过乐观锁)。仅 chat-message 用。
   */
  listChatWithOrderRevision(
    ownerId: string,
    canvasId: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<{ records: PersistRecord[]; orderRevision: Revision }>

  // ── 列表(返修 #6 ORDER BY orderKey;#8 枚举)──
  listByOwner(ownerId: string, type: PersistType, opts?: { includeDeleted?: boolean }): Promise<ListResult>
  listByCanvas(ownerId: string, canvasId: string, type: PersistType, opts?: { includeDeleted?: boolean }): Promise<ListResult>
  listCanvasByProject(ownerId: string, projectId: string, opts?: { includeDeleted?: boolean }): Promise<ListResult>

  // ── 返修 #7/N2:原子 tree 软删/恢复(单函数原子,故障全回滚)──
  /** 软删 canvas 子树:标 canvas meta + chat-collection record(原子;children 保持活记录)。 */
  softDeleteCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number }>
  /** 软删 project 子树:标 project + 其所有 canvas meta + 所有 chat-collection(原子)。 */
  softDeleteProjectTree(ownerId: string, projectId: string): Promise<{ count: number }>
  /**
   * 恢复 canvas 子树:canvas meta + chat-collection(原子,N2)。
   * opts.payload(若有)更新 canvas meta 域字段(restore-via-POST 带 new payload);opts.idempotencyKey/fingerprint 落 meta record。
   */
  restoreCanvasTree(
    ownerId: string,
    canvasId: string,
    opts?: { payload?: unknown; idempotencyKey?: string; fingerprint?: string },
  ): Promise<{ count: number }>
  /** 恢复 project 子树:project + 其 canvas meta + chat-collection(原子,N2)。opts 同上(project meta payload)。 */
  restoreProjectTree(
    ownerId: string,
    projectId: string,
    opts?: { payload?: unknown; idempotencyKey?: string; fingerprint?: string },
  ): Promise<{ count: number }>

  /**
   * Test-only:清空 owner 全部 records + idempotency index。
   * memory:同步 void;PG:TRUNCATE(async)→ Promise<void>。返回类型放宽,两类 backend 共用接口。
   */
  __reset(): void | Promise<void>

  /**
   * backend 就绪 promise(memory 立即 resolve;PG 从 DB 预热全局唯一索引缓存)。
   * app 启动(server/index.ts serve 前)await 之,确保同步 seam(getProjectOwner/getCanvasOwner)缓存已 warm。
   * additive 字段——内存实现 Promise.resolve(),PG 落地后新增,路由/契约零改动。
   */
  readonly ready: Promise<void>

  /**
   * P0.3 readiness probe(可选,live 健康检查;区别于 ready 的"启动预热"语义)。
   * /readyz 用:/healthz 只探"进程活"(恒 ok),/readyz 探"依赖此刻可用"。
   * memory:恒 ok(无外部依赖);PG:`SELECT 1` 探活连接池(捕连接耗尽/PG 挂)。
   * 返 ok=false 时携带 reason 供 /readyz 503 响应体诊断。additive——与 ready/__reset 同模式。
   */
  ping(): Promise<{ ok: true } | { ok: false; reason: string }>
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
  /** 返修 N7:canvas id 全局归属索引(id → ownerId)。授权 seam canAccessCanvas 跨 owner 查归属;跨 owner → 404。 */
  private readonly globalCanvasOwners = new Map<string, string>()
  /**
   * DP-6R P1-2:per-actor×canvas chat collection 独立乐观锁 cursor(orderRevision)。
   * key = `${actor}::${canvasId}`;reorder 同事务 compare+bump;与共享 canvas contentVersion 解耦。
   * 内存实现易失(与 InMemoryPersistBackend 整体一致);PG 实现持久化(chat_order_revisions 表)。
   */
  private readonly chatOrderRevisions = new Map<string, Revision>()
  /** additive(PG 落地后接口新增):内存 backend 立即就绪。 */
  readonly ready: Promise<void> = Promise.resolve()

  /** P0.3 readiness probe:内存 backend 无外部依赖,恒 ok。 */
  async ping(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: true }
  }

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

  /** 返修 #5:bump canvas meta contentVersion(子资源写入后调用;不动 metaRevision)。返新 contentVersion。 */
  private bumpCanvasContentVersion(ownerId: string, canvasId: string): number {
    const meta = this.find(ownerId, 'canvas', canvasId)
    if (!meta) return 0
    const p = asCanvasMeta(meta.payload) ?? {}
    const next = (p.contentVersion ?? 0) + 1
    p.contentVersion = next
    const updated: PersistRecord = { ...meta, payload: p, updatedAt: nowIso() }
    this.bucket(ownerId).set(recordKey(ownerId, 'canvas', canvasId), updated)
    return next
  }

  /** 读 canvas meta contentVersion(contentVersion 缺省 0)。 */
  private canvasContentVersion(ownerId: string, canvasId: string): Revision {
    const meta = this.find(ownerId, 'canvas', canvasId)
    if (!meta) return 0
    return asCanvasMeta(meta.payload)?.contentVersion ?? 0
  }

  /**
   * DP-6R P1-2:读 per-actor×canvas chat collection orderRevision(缺省 0)。
   * chat reorder 的 If-Match base = 此值(非共享 cv);GET /chat 返此值供 client 下次 reorder。
   *
   * R2-P1-1 契约:orderRevision 独立于 persist_records 软删状态——softDeleteCanvasTree/restoreCanvasTree
   * 只标 canvas meta + chat-collection,**不动 chatOrderRevisions**(memory) / chat_order_revisions(PG)。
   * 故软删/恢复 orderRevision 保留不复位(防 ABA:不回 0,使软删前的 stale base=0 在 restore 后仍 conflict,
   * 不复活)。仅 __reset(测试清理)清零。双后端契约测试钉死此行为(见 backend.contract.dual.test.ts)。
   */
  private chatOrderRevision(ownerId: string, canvasId: string): Revision {
    return this.chatOrderRevisions.get(`${ownerId}::${canvasId}`) ?? 0
  }

  /** DP-6R P1-2:bump per-actor×canvas chat orderRevision(+1);返新值。reorder 成功后调用。 */
  private bumpChatOrderRevision(ownerId: string, canvasId: string): Revision {
    const key = `${ownerId}::${canvasId}`
    const next = (this.chatOrderRevisions.get(key) ?? 0) + 1
    this.chatOrderRevisions.set(key, next)
    return next
  }

  /** DP-6R P1-2:GET /chat 用——读 actor×canvas chat collection orderRevision。 */
  async getChatOrderRevision(ownerId: string, canvasId: string): Promise<Revision> {
    return this.chatOrderRevision(ownerId, canvasId)
  }

  /**
   * DP-6R P1-2(返修 R2-P1-2):原子读 (messages, orderRevision) 对。
   * 同步临界区——collect chat-message records 与读 orderRevision 之间无 await:JS 单线程下 microtask
   * (并发 reorder)无法在两读之间插入,torn pair(旧 messages + 新 rev)不可能。与 PG 单事务 REPEATABLE READ 等价。
   */
  async listChatWithOrderRevision(
    ownerId: string,
    canvasId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<{ records: PersistRecord[]; orderRevision: Revision }> {
    const include = opts.includeDeleted ?? false
    const out: PersistRecord[] = []
    for (const r of this.bucket(ownerId).values()) {
      if (r.type !== 'chat-message') continue
      if (r.canvasId !== canvasId) continue
      if (!include && r.isDeleted) continue
      out.push(clone(r))
    }
    out.sort((a, b) => a.orderKey - b.orderKey || (a.createdAt < b.createdAt ? -1 : 1))
    // 同 snapshot:无 await 让出点,rev 与 messages 必自洽。
    const orderRevision = this.chatOrderRevision(ownerId, canvasId)
    return { records: out, orderRevision }
  }

  async get(ownerId: string, type: PersistType, id: string): Promise<GetResult> {
    const r = this.find(ownerId, type, id)
    return r ? { kind: 'found', record: clone(r) } : { kind: 'missing' }
  }

  getProjectOwner(id: string): { ownerId: string } | undefined {
    const ownerId = this.globalProjectOwners.get(id)
    return ownerId !== undefined ? { ownerId } : undefined
  }

  getCanvasOwner(id: string): { ownerId: string } | undefined {
    const ownerId = this.globalCanvasOwners.get(id)
    return ownerId !== undefined ? { ownerId } : undefined
  }

  /** F1:project 存在且 !isDeleted。canvas POST/PUT(move)验 parent live;软删 parent 禁独立 child restore。 */
  projectLive(ownerId: string, projectId: string): boolean {
    const r = this.find(ownerId, 'project', projectId)
    return !!r && !r.isDeleted
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
    // F4:canvas id 全局唯一(与 project 同模式)——跨 owner 同 canvas id → exists-other-owner(route → 409 canvas-exists)。
    // 在 idem-replay 之前:任何 owner 拿他人 canvas id 创建/回放 → 409,不覆盖 globalCanvasOwners,不独立 restore。
    if (type === 'canvas') {
      const globalOwner = this.globalCanvasOwners.get(id)
      if (globalOwner && globalOwner !== ownerId) {
        const r = this.find(globalOwner, 'canvas', id)
        if (r) return { kind: 'exists-other-owner', record: clone(r) }
      }
    }
    // F1:canvas 父 project 须 live——软删 parent 下禁独立 child create/restore(只许 POST project 走 restoreProjectTree 整树恢复)。
    // 在 idem-replay 之前:parent 不 live → parent-not-live(route → 404),阻断 idem-replay-deleted→restoreCanvasTree 独立复活。
    if (type === 'canvas') {
      const pid = asCanvasMeta(payload)?.projectId
      if (pid && !this.projectLive(ownerId, pid)) return { kind: 'parent-not-live' }
    }
    // 返修 #10/N4:幂等 header 复用(owner+method+resourceKind+key 复合 + fingerprint)。
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) {
          // N4:同 key 不同 fingerprint(不同 body)→ reuse-conflict(route 422)。
          if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) {
            return { kind: 'reuse-conflict' }
          }
          // N2:幂等命中 deleted → 真恢复(undelete + bump + restore tree);非 deleted → 返既有不 bump。
          if (r.isDeleted) {
            await this.restoreMeta(ownerId, type, id, payload, opts)
            const restored = this.find(ownerId, type, id)!
            this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
            return { kind: 'restored', record: clone(restored) }
          }
          return { kind: 'existing', record: clone(r) }
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
      // N2:backend 原子 create-or-restore-tree(project→restoreProjectTree;canvas→restoreCanvasTree)。
      await this.restoreMeta(ownerId, type, id, payload, opts)
      const restored = this.find(ownerId, type, id)!
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      return { kind: 'restored', record: clone(restored) }
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
    if (type === 'canvas') this.globalCanvasOwners.set(id, ownerId) // 返修 N7:canvas 全局归属
    this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
    return { kind: 'created', record: clone(created) }
  }

  /**
   * F1:canvas live 时确保 chat-collection 也 live(create-or-restore idempotent;防旧数据/恢复遗漏产生 orphan)。
   * 不存在 → create;soft-deleted → undelete+bump+清 payload;live → no-op。不 bump canvas contentVersion(meta 配对创建)。
   */
  private ensureCollectionLive(ownerId: string, canvasId: string): void {
    const existing = this.find(ownerId, 'chat-collection', canvasId)
    if (existing && !existing.isDeleted) return // 已 live
    const ts = nowIso()
    const key = recordKey(ownerId, 'chat-collection', canvasId)
    if (existing && existing.isDeleted) {
      const restored: PersistRecord = {
        ...clone(existing), payload: {}, revision: existing.revision + 1, isDeleted: false, updatedAt: ts,
      }
      this.bucket(ownerId).set(key, restored)
      return
    }
    const created: PersistRecord = {
      id: canvasId, ownerId, canvasId, type: 'chat-collection', scope: 'document', revision: 0, orderKey: 0,
      isDeleted: false, createdAt: ts, updatedAt: ts, payload: {},
    }
    this.bucket(ownerId).set(key, created)
  }

  /**
   * F1 返修五:restored 同步临界区(无 await 缝)——createCanvasWithCollection 的 restored/replay-deleted 路径
   * 把 parent-live 复验 + restoreCanvasTreeInPlace + ensureCollectionLive + globalCanvasOwners + idempotencyIndex
   * 全部纳入同一不可让渡临界区。JS 单线程下同步块不可被 microtask 打断(queueMicrotask(softDeleteProjectTree)
   * 无法在临界区中间插入),根除 TOCTOU live orphan。内存实现=同步临界区 + 快照覆盖全部索引(canvas meta +
   * chat-collection + globalCanvasOwners + idempotencyIndex);fault 注入 throw 时全索引回滚到 pre-state。
   */
  private restoreCanvasWithCollectionCritical(
    ownerId: string,
    canvasId: string,
    canvasPayload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): EnsureCreateResult {
    // 复验 parent live(临界区入口;同步块不可中断,进入即定 live,整块执行不可让渡)。
    const pid = asCanvasMeta(canvasPayload)?.projectId
    if (pid && !this.projectLive(ownerId, pid)) return { kind: 'parent-not-live' }

    const b = this.bucket(ownerId)
    const canvasKey = recordKey(ownerId, 'canvas', canvasId)
    const collKey = recordKey(ownerId, 'chat-collection', canvasId)
    const idemKey = opts.idempotencyKey
      ? idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
      : undefined

    // 快照覆盖全部索引(canvas meta + collection + globalCanvasOwners + idempotencyIndex)。
    const hadCanvas = b.get(canvasKey)
    const hadColl = b.get(collKey)
    const hadGlobalCanvasOwner = this.globalCanvasOwners.get(canvasId)
    const hadIdem = idemKey ? this.idempotencyIndex.get(idemKey) : undefined

    try {
      // restore canvas meta + chat-collection(同步:undelete+bump+payload merge;内部自快照回滚)。
      this.restoreCanvasTreeInPlace(ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
      // ensureCollectionLive(同步:防旧数据/恢复遗漏产生 orphan)。
      this.ensureCollectionLive(ownerId, canvasId)
      // globalCanvasOwners:canvas 之前已注册;确保指向 ownerId(防 orphan 归属错)。
      this.globalCanvasOwners.set(canvasId, ownerId)
      // idempotencyIndex:更新 envelopeKey + fingerprint(restored 路径定入)。
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, canvasKey, opts.bodyFingerprint ?? '')
      const restored = this.find(ownerId, 'canvas', canvasId)
      if (!restored) throw new Error('restoreCanvasWithCollectionCritical: post-restore canvas missing')
      return { kind: 'restored', record: clone(restored) }
    } catch (err) {
      // 全索引回滚(零 live orphan + 全索引一致;fault 注入 throw 含 globalCanvasOwners/idemIndex)。
      if (hadCanvas === undefined) b.delete(canvasKey)
      else b.set(canvasKey, hadCanvas)
      if (hadColl === undefined) b.delete(collKey)
      else b.set(collKey, hadColl)
      if (hadGlobalCanvasOwner === undefined) this.globalCanvasOwners.delete(canvasId)
      else this.globalCanvasOwners.set(canvasId, hadGlobalCanvasOwner)
      if (idemKey) {
        if (hadIdem === undefined) this.idempotencyIndex.delete(idemKey)
        else this.idempotencyIndex.set(idemKey, hadIdem)
      }
      throw err
    }
  }

  /**
   * F1:canvas + chat-collection 单一原子创建原语。route POST /api/canvas 只调这一个(防两段 TOCTOU orphan)。
   * 顺序:F4(全局唯一)→ F1(parent live)→ 幂等 replay(reuse-conflict/restored/existing)→ existing/restored/fresh。
   * - restored/replay-deleted:restoreCanvasWithCollectionCritical(同步临界区,无 await 缝;全索引快照回滚)。
   * - created(fresh):canvas meta + chat-collection 同一原子操作(快照回滚;失败回到 pre-state,不部分建 → 无 orphan)。
   */
  async createCanvasWithCollection(
    ownerId: string,
    canvasId: string,
    canvasPayload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<EnsureCreateResult> {
    // F4:canvas id 全局唯一(跨 owner 同 id → exists-other-owner;在 idem-replay 之前,不覆盖 globalCanvasOwners)。
    const globalOwner = this.globalCanvasOwners.get(canvasId)
    if (globalOwner && globalOwner !== ownerId) {
      const r = this.find(globalOwner, 'canvas', canvasId)
      if (r) return { kind: 'exists-other-owner', record: clone(r) }
    }
    // F1:父 project 须 live(软删 parent 下禁独立 child create/restore;阻断 orphan)。
    const pid = asCanvasMeta(canvasPayload)?.projectId
    if (pid && !this.projectLive(ownerId, pid)) return { kind: 'parent-not-live' }
    // 幂等 replay(owner+method+resourceKind+key + fingerprint)。
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) {
          // N4:同 key 不同 fingerprint(不同 body)→ reuse-conflict(route 422)。
          if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
          // N2/F1 返修五:幂等命中 deleted → 真恢复(同步临界区:复验 parent live + restore + ensureCollectionLive + 全索引更新/回滚,无 await 缝)。
          if (r.isDeleted) {
            return this.restoreCanvasWithCollectionCritical(ownerId, canvasId, canvasPayload, opts)
          }
          // existing live:collection 已随 canvas 原子创建;ensureCollectionLive 防御旧数据。
          this.ensureCollectionLive(ownerId, canvasId)
          return { kind: 'existing', record: clone(r) }
        }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, 'canvas', canvasId)
    if (existing && !existing.isDeleted) {
      this.ensureCollectionLive(ownerId, canvasId)
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, 'canvas', canvasId), opts.bodyFingerprint ?? '')
      return { kind: 'existing', record: clone(existing) }
    }
    if (existing && existing.isDeleted) {
      // N2/F1 返修五:parent live(已验 F1)→ restored 同步临界区(复验 + restore + ensureCollectionLive + 全索引更新/回滚,无 await 缝)。
      return this.restoreCanvasWithCollectionCritical(ownerId, canvasId, canvasPayload, opts)
    }
    // 不存在 → 原子 created(canvas meta + chat-collection 同一操作;快照回滚覆盖全部索引;无 TOCTOU 窗口)。
    const b = this.bucket(ownerId)
    const canvasKey = recordKey(ownerId, 'canvas', canvasId)
    const collKey = recordKey(ownerId, 'chat-collection', canvasId)
    const hadCanvas = b.get(canvasKey)
    const hadColl = b.get(collKey)
    const hadGlobalCanvasOwner = this.globalCanvasOwners.get(canvasId)
    const idemKey = opts.idempotencyKey
      ? idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
      : undefined
    const hadIdem = idemKey ? this.idempotencyIndex.get(idemKey) : undefined
    const ts = nowIso()
    const canvasRec: PersistRecord = {
      id: canvasId, ownerId, canvasId: null, type: 'canvas', scope: 'document', revision: 0, orderKey: 0,
      isDeleted: false, createdAt: ts, updatedAt: ts, payload: clone(canvasPayload),
      idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint,
    }
    const collRec: PersistRecord = {
      id: canvasId, ownerId, canvasId, type: 'chat-collection', scope: 'document', revision: 0, orderKey: 0,
      isDeleted: false, createdAt: ts, updatedAt: ts, payload: {},
      idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint,
    }
    try {
      b.set(canvasKey, canvasRec)
      b.set(collKey, collRec)
      this.globalCanvasOwners.set(canvasId, ownerId)
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, canvasKey, opts.bodyFingerprint ?? '')
    } catch (err) {
      // 全索引回滚:canvas meta + chat-collection + globalCanvasOwners + idempotencyIndex 回到 pre-state(不部分建 → 树内零 live orphan)。
      if (hadCanvas === undefined) b.delete(canvasKey)
      else b.set(canvasKey, hadCanvas)
      if (hadColl === undefined) b.delete(collKey)
      else b.set(collKey, hadColl)
      if (hadGlobalCanvasOwner === undefined) this.globalCanvasOwners.delete(canvasId)
      else this.globalCanvasOwners.set(canvasId, hadGlobalCanvasOwner)
      if (idemKey) {
        if (hadIdem === undefined) this.idempotencyIndex.delete(idemKey)
        else this.idempotencyIndex.set(idemKey, hadIdem)
      }
      throw err
    }
    return { kind: 'created', record: clone(canvasRec) }
  }

  /**
   * N2 私有 helper:meta record(project/canvas/chat-collection)恢复。
   * project/canvas → 原子 restore*Tree(单 record + 子树;快照回滚);chat-collection → 单 record undelete+bump+update payload。
   */
  private async restoreMeta(
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<void> {
    if (type === 'project') {
      await this.restoreProjectTree(ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
      return
    }
    if (type === 'canvas') {
      await this.restoreCanvasTree(ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
      return
    }
    // chat-collection(leaf meta):单 record undelete + bump + update payload(无子树)。
    const existing = this.find(ownerId, type, id)
    if (!existing) return
    const ts = nowIso()
    const restored: PersistRecord = {
      ...clone(existing),
      payload: clone(payload),
      revision: existing.revision + 1,
      isDeleted: false,
      updatedAt: ts,
      canvasId: opts.canvasId ?? existing.canvasId,
      scope: opts.scope ?? existing.scope,
      idempotencyKey: opts.idempotencyKey,
      fingerprint: opts.bodyFingerprint,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), restored)
  }

  /**
   * 返修 N3:子资源(chat-message)幂等创建——canvas_id 校验(existing/idem-replay/cross-canvas 全验)。
   * N4:同 idem key 不同 fingerprint → reuse-conflict;N2:软删命中真恢复;bump canvas contentVersion。
   */
  async ensureCreateChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<EnsureChildResult> {
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) {
          // N3:replay 时 canvas_id 不可变——同 id 属另一 canvas → cross-canvas(route 404)。
          if (r.canvasId !== canvasId) return { kind: 'cross-canvas' }
          // N4:fingerprint mismatch → reuse-conflict(route 422)。
          if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
          // N2:幂等命中 deleted → 真恢复(undelete + bump + update payload)。
          if (r.isDeleted) {
            const ts = nowIso()
            const restored: PersistRecord = {
              ...clone(r),
              payload: clone(payload),
              revision: r.revision + 1,
              isDeleted: false,
              updatedAt: ts,
              canvasId,
              idempotencyKey: opts.idempotencyKey,
              fingerprint: opts.bodyFingerprint,
            }
            this.bucket(ownerId).set(entry.envelopeKey, restored)
            // DP-6R:chat-message 是 per-actor 私有,不 bump 共享 canvas contentVersion。
            if (type !== 'chat-message') this.bumpCanvasContentVersion(ownerId, canvasId)
            return { kind: 'restored', record: clone(restored) }
          }
          return { kind: 'existing', record: clone(r) }
        }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, type, id)
    // N3:同 id 存在但属于另一 canvas → cross-canvas(canvas_id 不可变,不 create)。
    if (existing && existing.canvasId !== canvasId) return { kind: 'cross-canvas' }
    if (existing && !existing.isDeleted) {
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      return { kind: 'existing', record: clone(existing) }
    }
    if (existing && existing.isDeleted) {
      // N2:真恢复(undelete + bump + update payload)。
      const ts = nowIso()
      const restored: PersistRecord = {
        ...clone(existing),
        payload: clone(payload),
        revision: existing.revision + 1,
        isDeleted: false,
        updatedAt: ts,
        canvasId,
        idempotencyKey: opts.idempotencyKey,
        fingerprint: opts.bodyFingerprint,
      }
      this.bucket(ownerId).set(recordKey(ownerId, type, id), restored)
      this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
      // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
      if (type !== 'chat-message') this.bumpCanvasContentVersion(ownerId, canvasId)
      return { kind: 'restored', record: clone(restored) }
    }
    // 不存在 → created(orderKey 分配,返修 #6)。
    const ts = nowIso()
    const created: PersistRecord = {
      id,
      ownerId,
      canvasId,
      type,
      scope: 'document',
      revision: 0,
      orderKey: this.nextOrderKey(ownerId, canvasId, type),
      isDeleted: false,
      createdAt: ts,
      updatedAt: ts,
      payload: clone(payload),
      idempotencyKey: opts.idempotencyKey,
      fingerprint: opts.bodyFingerprint,
    }
    this.bucket(ownerId).set(recordKey(ownerId, type, id), created)
    this.setIdemIndex(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, recordKey(ownerId, type, id), opts.bodyFingerprint ?? '')
    // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
    if (type !== 'chat-message') this.bumpCanvasContentVersion(ownerId, canvasId)
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
        if (r) {
          // N4:同 idem key 不同 fingerprint(不同 body)→ reuse-conflict(route 422)。
          if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
          return { kind: r.isDeleted ? 'created' : 'updated', record: clone(r) }
        }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    // F1:canvas PUT move 目标 project 须 live(防 move 到软删 project)。idem-replay 之后、existing 之前。
    if (type === 'canvas') {
      const pid = asCanvasMeta(payload)?.projectId
      if (pid && !this.projectLive(ownerId, pid)) return { kind: 'parent-not-live' }
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
      strictUpdate?: boolean
    },
  ): Promise<UpsertChildResult> {
    if (opts.idempotencyKey) {
      const entry = this.idempotencyIndex.get(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      if (entry) {
        const r = this.bucket(ownerId).get(entry.envelopeKey)
        if (r) {
          // N3:replay 时 canvas_id 不可变——同 id 属另一 canvas → cross-canvas(route 404)。
          if (r.canvasId !== canvasId) return { kind: 'cross-canvas' }
          // N4:同 idem key 不同 fingerprint → reuse-conflict(route 422)。
          if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
          return { kind: 'updated', record: clone(r) }
        }
        this.idempotencyIndex.delete(idemIndexKey(ownerId, opts.method, opts.resourceKind, opts.idempotencyKey))
      }
    }
    const existing = this.find(ownerId, type, id)
    if (existing && existing.canvasId !== canvasId) {
      // 返修 #3:同 id 存在但属于另一 canvas → cross-canvas(canvas_id 不可变,不 create)。
      return { kind: 'cross-canvas' }
    }
    // DP-6R P2-1:strict-update(chat PATCH)——actor bucket 无此 id/已删 → not-found(route 404 unknown-message),
    // 不许借 PATCH create 己方副本(POST 是唯一 create 入口)。find + 判定在同一同步流程,无 get-then-upsert TOCTOU;
    // PG 侧事务内 SELECT + 拒绝(不走 create 的 INSERT ON CONFLICT),同样无 TOCTOU。
    if (opts.strictUpdate && (!existing || existing.isDeleted)) {
      return { kind: 'not-found' }
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
      // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion(node/edge/anchor 仍 bump)。
      if (type !== 'chat-message') this.bumpCanvasContentVersion(ownerId, canvasId)
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
    // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
    if (type !== 'chat-message') this.bumpCanvasContentVersion(ownerId, canvasId)
    return { kind: 'updated', record: clone(updated) }
  }

  async hardDeleteChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<{ deleted: boolean }> {
    const r = this.find(ownerId, type, id)
    if (!r || r.canvasId !== canvasId) return { deleted: false } // 返修 #3:cross-canvas/missing → 404
    this.bucket(ownerId).delete(recordKey(ownerId, type, id))
    // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion(node/edge/anchor 硬删仍 bump)。
    if (type !== 'chat-message') this.bumpCanvasContentVersion(ownerId, canvasId)
    return { deleted: true }
  }

  async reorderChildren(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    orderedIds: string[],
    opts: { base: Revision },
  ): Promise<ReorderResult> {
    const b = this.bucket(ownerId)
    // live set(type + canvasId + !deleted)
    const liveIds = new Set<string>()
    for (const r of b.values()) {
      if (r.type === type && r.canvasId === canvasId && !r.isDeleted) liveIds.add(r.id)
    }
    // N8:唯一性(含重复 → bad duplicate)
    const seen = new Set<string>()
    for (const id of orderedIds) {
      if (seen.has(id)) return { kind: 'bad', reason: 'duplicate' }
      seen.add(id)
    }
    // N8:全等(orderedIds 须 === live set;缺/多 → bad mismatch)
    if (orderedIds.length !== liveIds.size) return { kind: 'bad', reason: 'mismatch' }
    for (const id of orderedIds) {
      if (!liveIds.has(id)) return { kind: 'bad', reason: 'mismatch' }
    }
    // DP-6R P1-2:chat-message 用 per-actor×canvas **独立 orderRevision** 做 If-Match base(非共享 cv)。
    // 同事务 compare+bump——同 base 两并发一成一败;A/B 不同 actor 各自独立 cursor 互不冲突;
    // node 写 bump 共享 cv 但不触 chat orderRevision → node 写不使 chat reorder 误 409。chat 不 bump 共享 cv。
    if (type === 'chat-message') {
      const current = this.chatOrderRevision(ownerId, canvasId)
      if (opts.base !== current) {
        return { kind: 'conflict', currentContentVersion: current }
      }
      // 原子:快照 children → 重分配 orderKey;失败回滚。chat 不 bump 共享 cv,只 bump orderRevision。
      const chatSnapshot: Array<[string, PersistRecord]> = []
      for (const id of orderedIds) {
        const key = recordKey(ownerId, type, id)
        const r = b.get(key)
        if (r) chatSnapshot.push([key, clone(r)])
      }
      try {
        let n = 0
        for (const id of orderedIds) {
          const key = recordKey(ownerId, type, id)
          const r = b.get(key)
          if (!r) continue
          b.set(key, { ...clone(r), orderKey: n, updatedAt: nowIso() })
          n++
        }
        const newRev = this.bumpChatOrderRevision(ownerId, canvasId)
        return { kind: 'ok', reordered: n, contentVersion: newRev }
      } catch (err) {
        for (const [key, rec] of chatSnapshot) b.set(key, rec)
        throw err
      }
    }
    // N8/F5:node/edge/anchor——If-Match base = 共享 canvas contentVersion;stale → 409(两并发一成一 409)。
    const currentCv = this.canvasContentVersion(ownerId, canvasId)
    if (opts.base !== currentCv) {
      return { kind: 'conflict', currentContentVersion: currentCv }
    }
    // 原子:快照(children + canvas meta)→ 重分配 orderKey + bump contentVersion+updatedAt;失败回滚。
    const snapshot: Array<[string, PersistRecord]> = []
    for (const id of orderedIds) {
      const key = recordKey(ownerId, type, id)
      const r = b.get(key)
      if (r) snapshot.push([key, clone(r)])
    }
    const metaKey = recordKey(ownerId, 'canvas', canvasId)
    const meta = this.find(ownerId, 'canvas', canvasId)
    if (meta) snapshot.push([metaKey, clone(meta)])
    try {
      let n = 0
      for (const id of orderedIds) {
        const key = recordKey(ownerId, type, id)
        const r = b.get(key)
        if (!r) continue
        b.set(key, { ...clone(r), orderKey: n, updatedAt: nowIso() })
        n++
      }
      let newCv = currentCv
      if (meta) {
        const p = asCanvasMeta(meta.payload) ?? {}
        newCv = (p.contentVersion ?? 0) + 1
        p.contentVersion = newCv
        b.set(metaKey, { ...meta, payload: p, updatedAt: nowIso() })
      }
      return { kind: 'ok', reordered: n, contentVersion: newCv }
    } catch (err) {
      for (const [key, rec] of snapshot) b.set(key, rec)
      throw err
    }
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

  /**
   * N2 同步临界区:canvas meta + chat-collection undelete+bump+payload merge(单原子,快照回滚)。
   * F1 返修五:createCanvasWithCollection restored 路径直接调此同步版——无 await 让出点,JS 单线程下
   * microtask(queueMicrotask(softDeleteProjectTree))无法在临界区中间插入,根除 TOCTOU live orphan。
   * public restoreCanvasTree(async)保留 interface 契约,内部委托此同步实现(route/测试调用面不变)。
   */
  private restoreCanvasTreeInPlace(
    ownerId: string,
    canvasId: string,
    opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {},
  ): number {
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
        const isMeta = r.type === 'canvas' && r.id === canvasId
        let newPayload = clone(r.payload)
        if (isMeta && opts.payload !== undefined) {
          // N2:restore-via-POST 带 new payload——保留 contentVersion(backend 维护),合并 incoming 域字段。
          const oldCv = asCanvasMeta(r.payload)?.contentVersion ?? 0
          newPayload = { ...(opts.payload as object), contentVersion: oldCv }
        }
        const extra = isMeta ? { idempotencyKey: opts.idempotencyKey, fingerprint: opts.fingerprint } : {}
        b.set(key, { ...clone(r), payload: newPayload, isDeleted: false, revision: r.revision + 1, updatedAt: ts, ...extra })
      }
      return targets.length
    } catch (err) {
      for (const [key, rec] of snapshot) b.set(key, rec)
      throw err
    }
  }

  async restoreCanvasTree(
    ownerId: string,
    canvasId: string,
    opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {},
  ): Promise<{ count: number }> {
    return { count: this.restoreCanvasTreeInPlace(ownerId, canvasId, opts) }
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

  async restoreProjectTree(
    ownerId: string,
    projectId: string,
    opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {},
  ): Promise<{ count: number }> {
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
        const isProj = r.type === 'project' && r.id === projectId
        // N2:project meta payload 更新(若提供);canvas targets 保留 contentVersion(clone r.payload)。
        const newPayload = isProj && opts.payload !== undefined ? clone(opts.payload) : clone(r.payload)
        const extra = isProj ? { idempotencyKey: opts.idempotencyKey, fingerprint: opts.fingerprint } : {}
        b.set(key, { ...clone(r), payload: newPayload, isDeleted: false, revision: r.revision + 1, updatedAt: ts, ...extra })
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
    this.globalCanvasOwners.clear()
    this.chatOrderRevisions.clear()
  }
}

/**
 * 工厂:默认内存 backend(T1.3 过渡)。server/app.ts 注入;PG 落地后换 PgPersistBackend。
 * routes 通过 createXxxRoutes({ backend }) 接收(同 createLocalAssetsRoutes({ enabled }) 模式)。
 */
export const createPersistBackend = (): PersistBackend => new InMemoryPersistBackend()

// re-export shared types routes consume(信封 + 结果类型),避免 routes 各自 import shared。
export type { Envelope, PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'
