// server/persist/pgBackend.ts
// T1.3 PgPersistBackend:PG 持久化后端(Kysely + pg),drop-in 实现 PersistBackend 接口。
// 权威:docs/decisions/api-surface.md(契约冻结)+ 附录 A SQL 草案 + docs/decisions/pg-backend-schema.md(实施定稿)。
//
// 设计(详见 pg-backend-schema.md):
//  - persist_records 单一真相源(全 record 信封列 + payload jsonb);projects/canvases 退化为瘦全局唯一索引表
//    (id→owner→is_deleted;附录 A 草案这两表含 payload,实施去重——payload 留 persist_records,减少双写同步面,语义不变)。
//  - 全局唯一索引同步读(getProjectOwner/getCanvasOwner/projectLive 接口同步,route authz seam 同步调用)
//    → 内存缓存(projectIndex/canvasIndex),启动从 PG 预热(ready promise);写操作在事务提交后定点同步缓存(P1-5:纯内存赋值,不再查 DB)。
//  - 乐观并发:UPDATE ... WHERE revision=$client;numUpdatedRows=0 → 409(#4/#5)。
//  - 原子 tree 软删/恢复:createCanvasWithCollection / softDelete*Tree / restore*Tree 用单事务(等效内存实现快照回滚)。
//  - contentVersion bump:原子 jsonb_set(payload,'{contentVersion}', +1)(#5,不动 metaRevision)。
//  - 幂等(#10):idempotency_index 独立表 UNIQUE(owner+method+resourceKind+key)+ fingerprint;软删命中真恢复。
//  - F1(parent live)/F4(canvas 全局唯一)在事务内 SELECT...FOR UPDATE 防跨事务 TOCTOU(等效内存同步临界区)。
//  - 并发返修(P1/P2):reorder 用 FOR UPDATE 锁 canvas meta 序列化同 base(P1-1 一 200 一 409);幂等键 INSERT ON CONFLICT
//    DO NOTHING 作串行点,输家同事务回滚返 replay/reuse-conflict(P1-2);persist_records INSERT ON CONFLICT DO NOTHING +
//    重读转 existing(P1-3,同 owner 不再 23505 泄漏);ready = migrate-before-warm(P1-4,fresh DB 不再 42P01);nextOrderKey
//    先锁 canvas meta 防 orderKey 撞号(P2-1)。
//
// swap 不改路由/契约:server/app.ts 注入点从 InMemoryPersistBackend 换 PgPersistBackend(env 开关),路由零改动。

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql, type Generated, type JSONColumnType, type Selectable } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import { migrations } from './migrations'
import type { PgConnectionConfig } from './pgConfig'
import type {
  ApplyDomainOpsResult,
  CreateChildResult,
  DeleteChildResult,
  EnsureChildResult,
  EnsureCreateResult,
  GetChildResult,
  GetResult,
  LegacyReplaceDrainResult,
  ListResult,
  OverwrittenNotice,
  PersistBackend,
  PersistRecord,
  ReorderResult,
  UpsertChildResult,
  UpsertResult,
} from './backend'
import { ArchivedCanvasWriteError, ArchivedParentWriteError, ConcurrentParentChangeError } from './backend'
import { requiredTopLevelFields, validateChildPayload } from '../../shared/persist-contract.ts'
import { fieldKeyOf, setByPath, unsetByPath, getByPath, type DomainOp } from '../lib/domainOp'
import type { FieldClocks } from '../lib/baseCursor'
import type { PersistScope, PersistType, RecordStatus, Revision } from '../../shared/persist-contract.ts'

// ── Kysely Database 类型(列 SelectType=读类型;Generated=有 DB 默认值可省略插入)──────────
interface PersistRecordsTable {
  id: string
  owner_id: string
  canvas_id: string | null
  type: string
  scope: string
  revision: Generated<number>
  order_key: Generated<number>
  is_deleted: Generated<boolean>
  /** D1(Phase 2 归档):status 列(镜像 is_deleted;缺省 'active')。 */
  status: Generated<string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  // read=object(pg 解析 jsonb 为对象);insert/update=string(JSON.stringify 写入,PG text→jsonb 隐式转换)。JSONColumnType 须 object select,unknown 会破坏 Insertable 提取。
  payload: JSONColumnType<object>
}
interface GlobalIndexTable {
  id: string
  owner_id: string
  is_deleted: Generated<boolean>
  /** D1(Phase 2 归档):status 列(瘦索引表同步;缺省 'active')。 */
  status: Generated<string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
interface IdempotencyTable {
  owner_id: string
  method: string
  resource_kind: string
  key: string
  fingerprint: string
  envelope_owner: string
  envelope_type: string
  envelope_id: string
  created_at: Generated<Date>
}
/**
 * DP-6R P1-2:per-actor×canvas chat collection 独立乐观锁 cursor(orderRevision)。
 * PK=(actor_id, canvas_id);reorder 事务内 compare+bump。与共享 canvas contentVersion 解耦。
 */
interface ChatOrderRevisionsTable {
  actor_id: string
  canvas_id: string
  revision: Generated<number>
  updated_at: Generated<Date>
}
// ── A2-S2(§14.1/§10.5/§10.7;009 migration)──
/** per-record per-field clock(fieldKeyOf 完整 path 粒度;同-field stale 判定)+ writer(overwritten byActor)。 */
interface FieldClocksTable {
  record_key: string
  field_key: string
  clock: Generated<number>
  writer: string | null
  updated_at: Generated<Date>
}
/** per-canvas 单调事件序号 seq(§10.5;?since=seq 补拉)。 */
interface CanvasSeqTable {
  canvas_id: string
  seq: Generated<number>
  updated_at: Generated<Date>
}
/** child tombstone(§10.7 幂等已删返 seq vs 从未存在 404;物理删后留占位)。 */
interface ChildTombstonesTable {
  record_key: string
  canvas_id: string
  seq_at_delete: number
  deleted_at: Generated<Date>
}
interface Database {
  persist_records: PersistRecordsTable
  projects: GlobalIndexTable
  canvases: GlobalIndexTable
  idempotency_index: IdempotencyTable
  chat_order_revisions: ChatOrderRevisionsTable
  field_clocks: FieldClocksTable
  canvas_seq: CanvasSeqTable
  child_tombstones: ChildTombstonesTable
}

const clone = <T>(value: T): T => structuredClone(value)

/**
 * PG record_key(009 migration field_clocks/child_tombstones.record_key TEXT 列)。
 * InMemory recordKey() 用 NUL('\0')分隔(Map key,进程内安全),但 PG TEXT 列拒 0x00 字节。
 * PG 用 \x1f unit-separator 替代(TEXT 安全:PG TEXT 仅拒 0x00,其余控制字符可存;不出现于 ownerId/type/id)。
 * 逻辑同 recordKey()(同 (ownerId,type,id) → 同 key),仅分隔符不同(PG/InMemory 独立后端,record_key 不跨用)。
 */
const pgRecordKey = (ownerId: string, type: PersistType, id: string): string =>
  `${ownerId}\x1f${type}\x1f${id}`

/** DB 行 → PersistRecord(.returningAll()/.selectAll() 返 Selectable:revision→number, created_at→Date, payload→object;Date→ISO,jsonb payload→对象)。idempotencyKey/fingerprint 不持久化在 record 行,由写方法从 opts 回填。 */
const rowToRecord = (row: Selectable<PersistRecordsTable>): PersistRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  canvasId: row.canvas_id,
  type: row.type as PersistType,
  scope: row.scope as PersistScope,
  revision: Number(row.revision),
  orderKey: Number(row.order_key),
  isDeleted: Boolean(row.is_deleted),
  status: row.status as RecordStatus | undefined,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  payload: clone(row.payload),
})

/** canvas meta payload shape(backend 维护 contentVersion;其余域字段 route 管)。 */
type CanvasMetaPayload = { projectId?: string; title?: string; sourceTemplateId?: string; contentVersion?: Revision; archivedByCascade?: boolean }
const asCanvasMeta = (p: unknown): CanvasMetaPayload | null =>
  typeof p === 'object' && p !== null ? (p as CanvasMetaPayload) : null

type GlobalIndexEntry = { ownerId: string; isDeleted: boolean }

// ── Migration provider(静态列表,免 FileMigrationProvider 路径解析)──────────────────────
class StaticMigrationProvider implements MigrationProvider {
  private readonly migs: Record<string, Migration>
  constructor(migs: Record<string, Migration>) {
    this.migs = migs
  }
  async getMigrations(): Promise<Record<string, Migration>> {
    return this.migs
  }
}

/**
 * runMigrations:对 db 跑 migrateToLatest(可重放;migrator 自带 kysely_migration 追踪表)。
 * 测试用此对 fresh DB 跑;生产实操由 lead 走 runbook(docs/runbook/t1.1-pg-provisioning.md)。
 */
export const runMigrations = async (db: Kysely<Database>): Promise<void> => {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider(migrations) })
  const { error, results } = await migrator.migrateToLatest()
  if (error) throw error
  if (results) {
    for (const r of results) {
      if (r.status === 'Error') throw new Error(`migration ${r.migrationName} failed`)
    }
  }
}

/**
 * P1-2:幂等键竞争 signal。setIdempotencyEntryInTrx 用 INSERT ON CONFLICT DO NOTHING 作串行点;输家(返回空)
 * 重读赢家 entry 比对 fingerprint,throw 本 signal → Kysely 回滚输家同事务资源创建(无 partial 泄漏)。
 * 调用方 withIdempotencyGuard catch 后按 mismatch 返 reuse-conflict / replay(不再查 DB)。
 */
class IdempotencyRaceLost extends Error {
  readonly winnerRecord: PersistRecord
  readonly fingerprintMismatch: boolean
  constructor(winnerRecord: PersistRecord, fingerprintMismatch: boolean) {
    super('IDEMPOTENCY_RACE_LOST')
    this.name = 'IdempotencyRaceLost'
    this.winnerRecord = winnerRecord
    this.fingerprintMismatch = fingerprintMismatch
  }
}

/**
 * 直接 canvas archive/unarchive 的 parent CAS 失败信号。必须抛出事务边界,让已持有的旧 parent
 * projects 锁随 rollback 释放；外层随后用新事务重读 parent 并重试,严禁在旧锁事务内追锁新 parent。
 */
class CanvasParentChanged extends Error {
  constructor() {
    super('CANVAS_PARENT_CHANGED')
    this.name = 'CanvasParentChanged'
  }
}

/**
 * P3 item 4:CAS miss 重试前的短 jitter 退避(10-50ms)。并发 move 下多个 CAS 失败者若同步雷同重试,
 * 会再次在同一瞬间撞 parent churn 形成重试雷同群;jitter 把重试时间错开。纯函数(rand 注入,默认
 * Math.random),单测断言返回值 ∈ [10,50)。生产路径在两个 CAS 重试循环(withCanvasWriteGuard /
 * setCanvasArchiveStatusWithParentRetry)的 CanvasParentChanged 分支调用。
 */
export const casRetryJitterMs = (rand: () => number = Math.random): number =>
  10 + Math.floor(rand() * 41) // 10..50 inclusive of 10, exclusive of 51 → [10,50]

/** P3 item 4:在 CAS 重试前 await 短 jitter。封装便于测试/观测(可被 spy/替换)。 */
const waitCasRetryJitter = async (rand: () => number = Math.random): Promise<number> => {
  const delay = casRetryJitterMs(rand)
  await new Promise<void>((resolve) => setTimeout(resolve, delay))
  return delay
}

/**
 * PgPersistBackend:PG 持久化后端。drop-in 实现 PersistBackend;路由零改动。
 * 单实例 BFF 假设(缓存 in-process;多实例协作留 T1.4+,见 pg-backend-schema.md §4)。
 */
export class PgPersistBackend implements PersistBackend {
  private readonly db: Kysely<Database>
  /** F2:是否拥有(并应在 destroy 时释放)底层 Pool。sharedPool 注入时由拥有者(app)释放,本 backend 不销毁。 */
  private readonly ownsPool: boolean
  /** 全局唯一索引内存缓存(同步读;启动预热;写操作事务提交后定点同步)。 */
  private readonly projectIndex = new Map<string, GlobalIndexEntry>()
  private readonly canvasIndex = new Map<string, GlobalIndexEntry>()
  /** ready:全局索引预热完成(memory backend 立即 resolve;PG 从 PG load projects/canvases)。app 启动 await 后再 serve。 */
  readonly ready: Promise<void>

  /**
   * F2 返修:支持共享 Pool。`sharedPool` 注入则复用(单预算 + permission backend 同 pool,见 app.ts);
   * 不注入(测试/独立实例)则自建(含 connectionTimeoutMillis)。destroy 仅在 ownsPool 时销毁 pool。
   */
  constructor(conn: PgConnectionConfig, sharedPool?: Pool) {
    const pool = sharedPool ?? new Pool({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      max: conn.maxConnections,
      idleTimeoutMillis: conn.idleTimeoutMs,
      // P0.3 连接预算:池满时排队等待上限,超时即抛错(fail fast,不无限排队拖垮 BFF)。
      // config 未给(测试字面量)时兜底 5000ms;生产 env 总经 resolvePersistBackendConfig 填。
      connectionTimeoutMillis: conn.connectionTimeoutMs ?? 5000,
    })
    this.ownsPool = sharedPool === undefined
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
    })
    // P1-4:migrate-before-warm。app.ts/index.ts 只 await ready 从不调 migrate;旧编排 ready=warm() 在 fresh DB
    // (migrate 还没建表)上 warm() 先 SELECT projects → 42P01 → unhandled rejection。ready 内部先 migrate(建表,
    // migrator 追踪表保证可重放)再 warm,杜绝 fresh-DB 启动断裂。
    this.ready = this.init()
  }

  /** P1-4:migrate-then-warm(可重放;migrator 自带 kysely_migration 追踪表)。 */
  private async init(): Promise<void> {
    await this.migrate()
    await this.warm()
  }

  /** 预热全局唯一索引(projects/canvases 全量 load;瘦表,单实例量级小)。P1-5:仅启动预热用,写后不再调(改定点 mutation)。 */
  private async warm(): Promise<void> {
    const projects = await this.db.selectFrom('projects').select(['id', 'owner_id', 'is_deleted']).execute()
    for (const p of projects) this.projectIndex.set(p.id, { ownerId: p.owner_id, isDeleted: Boolean(p.is_deleted) })
    const canvases = await this.db.selectFrom('canvases').select(['id', 'owner_id', 'is_deleted']).execute()
    for (const c of canvases) this.canvasIndex.set(c.id, { ownerId: c.owner_id, isDeleted: Boolean(c.is_deleted) })
  }

  /** 优雅关闭连接池(app shutdown 用)。F2:shared pool 时不销毁(由拥有者释放),own pool 时 db.destroy 连带销毁。 */
  async destroy(): Promise<void> {
    if (this.ownsPool) await this.db.destroy()
  }

  /** 对本 backend 的 db 跑 migrateToLatest(可重放)。测试 beforeAll + 生产 runbook 用。 */
  async migrate(): Promise<void> {
    await runMigrations(this.db)
  }

  /**
   * P0.3 readiness probe:`SELECT 1` 探活连接池(捕 PG 挂/连接耗尽/网络断)。
   * /readyz 用:不同于 ready(启动预热一次性),ping 是"此刻依赖可用"的 live 探测。
   * 不抛错——返 ok=false + reason,让 /readyz 回 503 而非 500(诊断体含 reason)。
   * 用 Kysely `sql\`SELECT 1\`` 走池里取一条连接(受 connectionTimeoutMillis 排队超时保护)。
   */
  async ping(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await sql`SELECT 1`.execute(this.db)
      return { ok: true }
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      return { ok: false, reason }
    }
  }

  // ── 同步全局唯一索引读(route authz seam 同步调用)────────────────────────────────────
  getProjectOwner(id: string): { ownerId: string } | undefined {
    const e = this.projectIndex.get(id)
    return e ? { ownerId: e.ownerId } : undefined
  }
  getCanvasOwner(id: string): { ownerId: string } | undefined {
    const e = this.canvasIndex.get(id)
    return e ? { ownerId: e.ownerId } : undefined
  }
  /** CR-6 缺口1:node id 全局反查(migration 011 部分索引 idx_persist_node_by_id 支撑;存量无需回填)。 */
  async findNodeOwners(nodeId: string): Promise<Array<{ ownerId: string; canvasId: string | null; isDeleted: boolean }>> {
    await this.ready
    const rows = await this.db
      .selectFrom('persist_records')
      .select(['owner_id', 'canvas_id', 'is_deleted'])
      .where('type', '=', 'node')
      .where('id', '=', nodeId)
      .execute()
    return rows.map((r) => ({ ownerId: r.owner_id, canvasId: r.canvas_id, isDeleted: Boolean(r.is_deleted) }))
  }
  /** F1:project 存在且 !isDeleted(缓存读,反映已提交状态;事务内 F1/SG-1 检查用 projectStateInTrx 防 TOCTOU)。 */
  projectLive(ownerId: string, projectId: string): boolean {
    const e = this.projectIndex.get(projectId)
    return !!e && e.ownerId === ownerId && !e.isDeleted
  }

  // ── 内部 helpers ──────────────────────────────────────────────────────────────────────

  /**
   * P1-5:定点内存 cache mutation(纯 Map.set,不可失败)。事务提交后用已提交结果同步 project/canvas 全局索引,
   * 不再 await warm()(warm 瞬时失败 → API 报错但 DB 已提交 → getProjectOwner 返 undefined → authz 误判 unknown)。
   * warm 只作启动预热;post-commit 仅此纯内存赋值。
   */
  private setIndexEntry(type: PersistType, id: string, ownerId: string, isDeleted: boolean): void {
    if (type === 'project') this.projectIndex.set(id, { ownerId, isDeleted })
    else if (type === 'canvas') this.canvasIndex.set(id, { ownerId, isDeleted })
  }

  /**
   * P1-2:幂等键竞争串行点守护。run() 内的 transaction().execute 若在 setIdempotencyEntryInTrx 输家分支 throw
   * IdempotencyRaceLost(Kysely 回滚输家同事务资源创建),本 helper 在外 catch:按 onRace 构造
   * replay(同 body)/reuse-conflict(不同 body)返回,不再查 DB、不再写。
   */
  private async withIdempotencyGuard<T>(
    run: () => Promise<T>,
    onRace: (winnerRecord: PersistRecord, fingerprintMismatch: boolean) => T,
  ): Promise<T> {
    try {
      return await run()
    } catch (e) {
      if (e instanceof IdempotencyRaceLost) return onRace(e.winnerRecord, e.fingerprintMismatch)
      throw e
    }
  }

  /**
   * CR-6 缺口2(TOCTOU 检查时守卫):事务内 SELECT...FOR UPDATE canvas meta 行,重验 archived-live
   * (!is_deleted && status='archived')→ throw ArchivedCanvasWriteError(顶层 onError → 409 archived)。
   * 与 route 层 authzCanvas/resolveCanvasAccess 的 check-time 判定互补:锁 canvas 行使本写事务与并发
   * archiveCanvasTree/archiveProjectTree(同样 UPDATE canvas 行)串行化——archive 先提交则本判定必见
   * archived;本事务先锁行则 archive 阻塞到写提交后。per-canvas 行锁粒度,无全局锁;canvas missing/
   * deleted/active → 放行(missing 由 route authz 兜;deleted 对齐 resolveCanvasAccess isDeleted 先于
   * archived 的顺序)。子写方法在事务起点调用,统一 canvas→child 加锁顺序(与 bumpCanvasContentVersionInTrx
   * 后置更新同行,不产生锁升级/乱序)。
   * canvas 按 id 全局定位(不带 owner_id 过滤;F4 canvas id 全局唯一):chat-message 子写的 ownerId=actor
   * ≠ canvas owner(DP-6R per-actor),按 (owner_id,id) 查会落空漏防。
   */
  private async assertCanvasWritableInTrx(trx: Kysely<Database>, _ownerId: string, canvasId: string): Promise<void> {
    const r = await trx
      .selectFrom('persist_records')
      .select(['is_deleted', 'status'])
      .where('type', '=', 'canvas')
      .where('id', '=', canvasId)
      .forUpdate()
      .executeTakeFirst()
    if (r && !r.is_deleted && r.status === 'archived') throw new ArchivedCanvasWriteError(canvasId)
  }

  /**
   * P2-1:asset ref 等 persist 外部 mutation 的 write-time guard。无锁读 parent 仅用于决定第一把锁；
   * 随后 projects → canvas FOR UPDATE，并以 payload.projectId 作 CAS。parent 并发 move 时整事务释放旧锁后
   * 重试，绝不持 canvas 反追新 project。callback 只在 parent 稳定且 canvas 非 archived-live 后执行一次。
   *
   * P3 item 3 non-reentrant 契约(文档):禁止同 canvas 嵌套调用——在 mutation 内再次以同一 canvasId 调用
   * 本方法会形成跨事务 self-等待(PG 事务在 mutation 内未提交,嵌套取锁会撞自身未提交行锁 / 串行等待)。
   * memory 侧 withCanvasCritical 对同步段重入 throw fail-fast;PG 侧无进程内 mutex(以 DB 行锁串行),
   * 嵌套调用会表现为事务内锁竞争/死锁,故契约由 JSDoc 声明禁止,调用方不得在 mutation 内同 canvas 重入。
   * P3 item 4:CAS miss(CanvasParentChanged)重试前加 10-50ms 短 jitter,防并发 CAS 失败者同步雷同重试群。
   */
  async withCanvasWriteGuard<T>(ownerId: string, canvasId: string, mutation: () => Promise<T>): Promise<T> {
    await this.ready
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.db.transaction().execute(async (trx) => {
          const before = await trx
            .selectFrom('persist_records')
            .select(sql`payload->>'projectId'`.as('project_id'))
            .where('owner_id', '=', ownerId)
            .where('type', '=', 'canvas')
            .where('id', '=', canvasId)
            .executeTakeFirst()
          const parentProjectId = typeof before?.project_id === 'string' && before.project_id.length > 0
            ? before.project_id
            : undefined
          if (parentProjectId) await this.projectStateInTrx(trx, ownerId, parentProjectId)

          const canvas = await trx
            .selectFrom('persist_records')
            .select(['is_deleted', 'status', sql`payload->>'projectId'`.as('project_id')])
            .where('owner_id', '=', ownerId)
            .where('type', '=', 'canvas')
            .where('id', '=', canvasId)
            .forUpdate()
            .executeTakeFirst()
          const lockedParentId = typeof canvas?.project_id === 'string' && canvas.project_id.length > 0
            ? canvas.project_id
            : undefined
          if (lockedParentId !== parentProjectId) throw new CanvasParentChanged()
          if (canvas && !canvas.is_deleted && canvas.status === 'archived') throw new ArchivedCanvasWriteError(canvasId)
          return mutation()
        })
      } catch (error) {
        if (!(error instanceof CanvasParentChanged)) throw error
        if (attempt === maxAttempts) throw new ConcurrentParentChangeError(canvasId, { cause: error })
        // P3 item 4:CAS miss 重试前短 jitter(10-50ms),防并发 CAS 失败者同步雷同重试群。
        await waitCasRetryJitter()
      }
    }
    throw new ConcurrentParentChangeError(canvasId)
  }

  /**
   * 事务内 F1+SG-1:SELECT...FOR UPDATE project 行,同时返 live 与 archived 状态(单查询,防跨事务 TOCTOU)。
   * archived 判据取 projects 瘦索引 status 列(archive/unarchive tree 与 persist_records 同事务同步,F-idx)。
   */
  private async projectStateInTrx(trx: Kysely<Database>, ownerId: string, projectId: string): Promise<{ live: boolean; archived: boolean }> {
    const r = await trx
      .selectFrom('projects')
      .select(['owner_id', 'is_deleted', 'status'])
      .where('id', '=', projectId)
      .forUpdate()
      .executeTakeFirst()
    const live = !!r && r.owner_id === ownerId && !r.is_deleted
    return { live, archived: live && r!.status === 'archived' }
  }

  /**
   * Project tree 全局锁序静态清单(projects → project meta → canvas meta → children/index):
   * 1) softDeleteProjectTree；2) restoreProjectTree；3) ensureCreate(project deleted，经 restore helper)；
   * 4) upsert(project deleted/fresh，空 projects 行锁为 no-op)；5) archiveProjectTree；6) unarchiveProjectTree；
   * 7) createCanvasWithCollection(parent)；8) upsert(canvas move target)；9) direct canvas archive/unarchive
   * (parent CAS miss 必须 rollback 后新事务重读重锁)。所有 project 复活路径在写 project meta 前先锁 projects 行。
   */

  /**
   * 直接归档/恢复 canvas 的 parent-project-first 锁入口。先无锁读取 parent id,随后锁 projects 行;
   * 真正 canvas UPDATE 还会以该 parent id 作 CAS 谓词；standalone 用 projectId IS NULL。谓词 miss
   * 由外层 rollback 整事务并用新事务重读重锁,不会在持有旧 project 锁时追锁新 project。
   */
  private async lockCanvasParentProjectInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom('persist_records')
      .select(sql`payload->>'projectId'`.as('project_id'))
      .where('owner_id', '=', ownerId)
      .where('type', '=', 'canvas')
      .where('id', '=', canvasId)
      .executeTakeFirst()
    const projectId = typeof row?.project_id === 'string' && row.project_id.length > 0 ? row.project_id : undefined
    if (projectId) await this.projectStateInTrx(trx, ownerId, projectId)
    return projectId
  }

  /**
   * 直接 canvas archive/unarchive：parent-project-first + parent CAS + 有界新事务重试。
   * CAS miss 且 canvas 仍处于 source status 说明并发 move 赢了；throw 使旧 parent 锁先释放，再重试。
   * 已到 target status / 已删除 / 不存在是真幂等 no-op。三次 parent churn 后显式返回 retryableConflict。
   */
  private async setCanvasArchiveStatusWithParentRetry(
    ownerId: string,
    canvasId: string,
    source: 'active' | 'archived',
    target: 'active' | 'archived',
  ): Promise<{ count: number; retryableConflict?: true }> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.db.transaction().execute(async (trx) => {
          const parentProjectId = await this.lockCanvasParentProjectInTrx(trx, ownerId, canvasId)
          let q = trx.updateTable('persist_records')
            .set({
              status: target,
              payload: sql`jsonb_set(payload, '{archivedByCascade}', 'false'::jsonb)`,
              revision: sql`revision + 1`,
              updated_at: new Date(),
            })
            .where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId)
            .where('is_deleted', '=', false).where('status', '=', source)
          q = parentProjectId
            ? q.where(sql`payload->>'projectId'`, '=', parentProjectId)
            : q.where(sql<boolean>`payload->>'projectId' IS NULL`)
          const r = await q.returning('id').executeTakeFirst()
          if (!r) {
            const current = await trx.selectFrom('persist_records')
              .select(['is_deleted', 'status'])
              .where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId)
              .executeTakeFirst()
            if (current && !current.is_deleted && current.status === source) throw new CanvasParentChanged()
            return { count: 0 }
          }
          await trx.updateTable('canvases').set({ status: target, updated_at: new Date() })
            .where('id', '=', r.id).where('owner_id', '=', ownerId).where('is_deleted', '=', false).where('status', '=', source).execute()
          return { count: 1 }
        })
      } catch (error) {
        if (!(error instanceof CanvasParentChanged)) throw error
        if (attempt === maxAttempts) return { count: 0, retryableConflict: true }
        // P3 item 4:CAS miss 重试前短 jitter(10-50ms),防并发 archive CAS 失败者同步雷同重试群。
        await waitCasRetryJitter()
      }
    }
    return { count: 0, retryableConflict: true }
  }

  /** 事务内原子 bump canvas meta payload.contentVersion(不动 metaRevision;#5)。返新 contentVersion。 */
  private async bumpCanvasContentVersionInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string): Promise<number> {
    const row = await trx
      .updateTable('persist_records')
      .set({
        payload: sql`jsonb_set(payload, '{contentVersion}', to_jsonb(COALESCE((payload->>'contentVersion')::int, 0) + 1))`,
        updated_at: new Date(),
      })
      .where('owner_id', '=', ownerId)
      .where('type', '=', 'canvas')
      .where('id', '=', canvasId)
      .returning(sql`(payload->>'contentVersion')::int`.as('content_version'))
      .executeTakeFirst()
    return row ? Number(row.content_version) : 0
  }

  /**
   * 事务内读 canvas meta contentVersion(缺省 0)。P1-1:FOR UPDATE 锁 canvas meta 行,序列化并发 reorder
   * (两并发同 base:赢家锁行读 cv、bump、提交;输家阻塞至赢家提交后读新 cv → base≠cv → 409 conflict)。
   */
  private async canvasContentVersionInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string): Promise<Revision> {
    const r = await trx
      .selectFrom('persist_records')
      .select(sql`payload->>'contentVersion'`.as('content_version'))
      .where('owner_id', '=', ownerId)
      .where('type', '=', 'canvas')
      .where('id', '=', canvasId)
      .forUpdate()
      .executeTakeFirst()
    return r ? Number(r.content_version ?? 0) : 0
  }

  /**
   * DP-6R P1-2:GET /chat 用——读 per-actor×canvas chat collection orderRevision(缺省 0;行不存在即 0)。
   * 非事务读(反映已提交状态);供 route 返 ListChatMessagesResponse.orderRevision。
   */
  async getChatOrderRevision(ownerId: string, canvasId: string): Promise<Revision> {
    await this.ready
    const r = await this.db
      .selectFrom('chat_order_revisions')
      .select('revision')
      .where('actor_id', '=', ownerId)
      .where('canvas_id', '=', canvasId)
      .executeTakeFirst()
    return r ? Number(r.revision) : 0
  }

  /**
   * A2-S3:读单 record per-field clock 全快照(供 route encodeBase 签发 BaseCursor;hydrate 用)。
   * 非事务读(已提交状态);复用 snapshotFieldClocksInTrx(this.db, rk)。
   */
  async readRecordFieldClocks(ownerId: string, type: PersistType, recordId: string): Promise<FieldClocks> {
    await this.ready
    return this.snapshotFieldClocksInTrx(this.db, pgRecordKey(ownerId, type, recordId))
  }

  /**
   * A2-S3:读 canvas 当前事件 seq(供 route encodeSinceBase/encodeBundle + CanvasMeta.sinceSeq)。
   * 非事务读;复用 readCanvasSeqInTrx(this.db, canvasId);行不存在即 0。
   */
  async readCanvasSeq(canvasId: string): Promise<number> {
    await this.ready
    return this.readCanvasSeqInTrx(this.db, canvasId)
  }


  /**
   * DP-6R P1-2(返修 R2-P1-2):原子读 (messages, orderRevision) 对——单事务 REPEATABLE READ 一致快照。
   * READ COMMITTED 两语句间并发 reorder 提交 → torn pair(旧 messages + 新 rev);REPEATABLE READ 冻结 snapshot
   * 于首条语句,messages 与 orderRevision 必同见 pre-reorder 或 post-reorder,不撕裂。与 memory 同步临界区等价。
   * route GET /chat 用此(替代 listByCanvas + getChatOrderRevision 两 await),根除 canvas.ts:590-592 的 torn pair。
   */
  async listChatWithOrderRevision(
    ownerId: string,
    canvasId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<{ records: PersistRecord[]; orderRevision: Revision }> {
    await this.ready
    const include = opts.includeDeleted ?? false
    // R2-P1-2:单事务 REPEATABLE READ 一致快照——production 默认;test 可经 __listChatTornPairTestHooks
    // 强制 'read committed' 复现 torn pair 回归(barrier 旋钮详见属性注释)。
    const isolation: 'repeatable read' | 'read committed' =
      this.__listChatTornPairTestHooks.isolationLevel ?? 'repeatable read'
    return this.db
      .transaction()
      .setIsolationLevel(isolation)
      .execute(async (trx) => {
        let q = trx
          .selectFrom('persist_records')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('canvas_id', '=', canvasId)
          .where('type', '=', 'chat-message')
        if (!include) q = q.where('is_deleted', '=', false)
        const rows = await q.orderBy('order_key', 'asc').orderBy('created_at', 'asc').execute()
        // R2-P1-2 barrier:torn pair 危险窗口正在此——messages SELECT 已完成、orderRevision SELECT 未开始。
        // production 无 hook 直通(单事务 snapshot 自洽);test 注入 latch 在此暂停,期间提交 reorder,
        // 确定性验证 REPEATABLE READ 自洽 / READ COMMITTED 撕裂。详见 backend.contract.dual.test.ts PG barrier 套件。
        if (this.__listChatTornPairTestHooks.afterMessages) {
          await this.__listChatTornPairTestHooks.afterMessages()
        }
        const revRow = await trx
          .selectFrom('chat_order_revisions')
          .select('revision')
          .where('actor_id', '=', ownerId)
          .where('canvas_id', '=', canvasId)
          .executeTakeFirst()
        return { records: rows.map(rowToRecord), orderRevision: revRow ? Number(revRow.revision) : 0 }
      })
  }

  /**
   * DP-6R P1-2:事务内原子 compare+bump chat orderRevision(单语句条件 INSERT,无 get-then-upsert TOCTOU)。
   *
   * R2-P1-1(返修):原 `INSERT (rev=1) ON CONFLICT DO UPDATE WHERE revision=base` 在缺行时 INSERT 无条件成功
   * (base guard 仅在 DO UPDATE 分支)→ 缺行+base=7 也 ok,与 memory(current=0、base≠0→conflict)分歧。
   * 改条件 INSERT:`INSERT ... SELECT 1 WHERE base=0 OR EXISTS(...) ON CONFLICT DO UPDATE WHERE revision=base RETURNING`:
   *   - 缺行 + base===0 → SELECT 出 1 行 → INSERT 成功(rev=1)→ ok(1);
   *   - 缺行 + base≠0  → SELECT 出 0 行(base≠0 且 EXISTS=false)→ 不 INSERT → 0 rows → conflict(0);【防分歧,与 memory 一致】
   *   - 行存在 + base===current → INSERT attempt → ON CONFLICT UPDATE WHERE revision=base 命中 → rev+1 → ok(newRev);
   *   - 行存在 + base!==current(stale)→ ON CONFLICT UPDATE WHERE revision=base 不命中 → 0 rows → conflict(current)。
   *
   * `WHERE base=0 OR EXISTS` 的意义:缺行+base≠0 不 INSERT(返 conflict);行存在时 INSERT 仍 attempt 以触发
   * ON CONFLICT 走 UPDATE 分支(合法 base 匹配→bump,不破坏)。EXISTS 读 statement snapshot;PK arbiter + ON CONFLICT
   * 串行化并发:两同 base reorder——赢家 INSERT/UPDATE 提交;输家阻塞至赢家提交后,WHERE revision=base 不命中 → conflict。
   *
   * 软删/恢复不动 chat_order_revisions(独立于 persist_records 软删状态)→ orderRevision 保留不复位(防 ABA,
   * 见 backend.ts chatOrderRevision 契约注释 + 双后端契约测试)。不需要 FOR UPDATE 预锁。
   */
  private async bumpChatOrderRevisionInTrx(
    trx: Kysely<Database>,
    ownerId: string,
    canvasId: string,
    base: Revision,
  ): Promise<{ kind: 'ok'; newRevision: number } | { kind: 'conflict'; current: number }> {
    const result = await sql<{ revision: bigint | number | string }>`
      INSERT INTO chat_order_revisions (actor_id, canvas_id, revision)
      SELECT ${ownerId}, ${canvasId}, 1
      WHERE ${base} = 0
         OR EXISTS (SELECT 1 FROM chat_order_revisions WHERE actor_id = ${ownerId} AND canvas_id = ${canvasId})
      ON CONFLICT (actor_id, canvas_id)
      DO UPDATE SET revision = chat_order_revisions.revision + 1, updated_at = NOW()
      WHERE chat_order_revisions.revision = ${base}
      RETURNING chat_order_revisions.revision
    `.execute(trx)
    const row = result.rows[0]
    if (row) return { kind: 'ok', newRevision: Number(row.revision) }
    // 0 rows:缺行+base≠0(不 INSERT)或 行存在但 stale(base≠current)→ 读 current 供 client rebase。
    const cur = await trx
      .selectFrom('chat_order_revisions')
      .select('revision')
      .where('actor_id', '=', ownerId)
      .where('canvas_id', '=', canvasId)
      .executeTakeFirst()
    return { kind: 'conflict', current: cur ? Number(cur.revision) : 0 }
  }

  /**
   * 事务内 nextOrderKey:MAX(order_key)+1(子资源不软删,无需 is_deleted 过滤)。
   * P2-1:先 SELECT FOR UPDATE 锁 canvas meta 行,序列化同 canvas 并发 append(否则两并发都读 MAX → 撞号)。
   * 锁与 bumpCanvasContentVersionInTrx 的 UPDATE 同行同事务,无死锁(锁序一致:canvas meta 在前)。
   */
  private async nextOrderKeyInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string, type: PersistType): Promise<number> {
    await trx
      .selectFrom('persist_records')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('type', '=', 'canvas')
      .where('id', '=', canvasId)
      .forUpdate()
      .executeTakeFirst()
    const r = await trx
      .selectFrom('persist_records')
      .select(sql`COALESCE(MAX(order_key), -1) + 1`.as('next'))
      .where('owner_id', '=', ownerId)
      .where('canvas_id', '=', canvasId)
      .where('type', '=', type)
      .executeTakeFirst()
    return r ? Number(r.next) : 0
  }

  /** 事务内幂等 replay 查(返 envelope ref + fingerprint;nil 表示无 idem 条目)。 */
  private async idempotencyEntryInTrx(
    trx: Kysely<Database>,
    ownerId: string,
    method: string,
    resourceKind: string,
    key: string,
  ): Promise<{ envelope_owner: string; envelope_type: string; envelope_id: string; fingerprint: string } | undefined> {
    return trx
      .selectFrom('idempotency_index')
      .select(['envelope_owner', 'envelope_type', 'envelope_id', 'fingerprint'])
      .where('owner_id', '=', ownerId)
      .where('method', '=', method)
      .where('resource_kind', '=', resourceKind)
      .where('key', '=', key)
      .executeTakeFirst()
  }

  /**
   * 事务内写幂等条目(P1-2:INSERT ON CONFLICT DO NOTHING 串行点)。
   * 赢家(returning 非空)→ 完成。输家(returning 空,另一事务已提交占此 key)→ 重读(FOR UPDATE)赢家 entry
   * 比对 fingerprint,fetch 赢家 record → throw IdempotencyRaceLost(回滚输家同事务资源创建;调用方 withIdempotencyGuard
   * catch 后返 replay/reuse-conflict)。INSERT ON CONFLICT 阻塞至占位事务提交后返回空,故重读时赢家 record 已可见。
   */
  private async setIdempotencyEntryInTrx(
    trx: Kysely<Database>,
    ownerId: string,
    method: string,
    resourceKind: string,
    key: string | undefined,
    fingerprint: string,
    envelopeOwner: string,
    envelopeType: string,
    envelopeId: string,
  ): Promise<void> {
    if (!key) return
    const inserted = await trx
      .insertInto('idempotency_index')
      .values({
        owner_id: ownerId,
        method,
        resource_kind: resourceKind,
        key,
        fingerprint,
        envelope_owner: envelopeOwner,
        envelope_type: envelopeType,
        envelope_id: envelopeId,
      })
      .onConflict((oc) => oc.columns(['owner_id', 'method', 'resource_kind', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst()
    if (!inserted) {
      // 输家:另一事务已占此 idem key(已提交)。重读(锁)赢家 entry + fetch 赢家 record,throw signal 让调用方回滚返 replay/reuse-conflict。
      const entry = await trx
        .selectFrom('idempotency_index')
        .select(['fingerprint', 'envelope_owner', 'envelope_type', 'envelope_id'])
        .where('owner_id', '=', ownerId)
        .where('method', '=', method)
        .where('resource_kind', '=', resourceKind)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst()
      if (!entry) throw new Error(`idempotency race: entry vanished on re-read (key=${key})`)
      const winnerRow = await trx
        .selectFrom('persist_records')
        .selectAll()
        .where('owner_id', '=', entry.envelope_owner)
        .where('type', '=', entry.envelope_type)
        .where('id', '=', entry.envelope_id)
        .executeTakeFirst()
      if (!winnerRow) throw new Error(`idempotency race: winner envelope missing (${entry.envelope_owner}:${entry.envelope_type}:${entry.envelope_id})`)
      throw new IdempotencyRaceLost(rowToRecord(winnerRow), !!fingerprint && entry.fingerprint !== fingerprint)
    }
  }

  // ── meta record CRUD ──────────────────────────────────────────────────────────────────

  async get(ownerId: string, type: PersistType, id: string): Promise<GetResult> {
    await this.ready
    const row = await this.db
      .selectFrom('persist_records')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('type', '=', type)
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? { kind: 'found', record: rowToRecord(row) } : { kind: 'missing' }
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
      /** D2(Phase 2 归档):create wire 可选 status;fresh create 落列,restore 路径应用(combineOps create+archive→create(status:'archived'))。 */
      status?: RecordStatus
    },
  ): Promise<EnsureCreateResult> {
    await this.ready
    return this.withIdempotencyGuard(
      async () => {
        const result: EnsureCreateResult = await this.db.transaction().execute(async (trx) => {
          // F4:canvas id 全局唯一——跨 owner 同 id → exists-other-owner(在 idem-replay 之前,不覆盖 canvasIndex)。
          if (type === 'canvas') {
            const g = await trx.selectFrom('canvases').select(['owner_id']).where('id', '=', id).executeTakeFirst()
            if (g && g.owner_id !== ownerId) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'canvas').where('id', '=', id).executeTakeFirst()
              if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
            }
          }
          // F1:canvas 父 project 须 live(软删 parent 下禁独立 child create/restore;在 idem-replay 之前)。
          // SG-1:archived 目标 project 拒子记录 create/restore(route → 409 archived;defense-in-depth)。
          if (type === 'canvas') {
            const pid = asCanvasMeta(payload)?.projectId
            if (pid) {
              const ps = await this.projectStateInTrx(trx, ownerId, pid)
              if (!ps.live) return { kind: 'parent-not-live' }
              if (ps.archived) return { kind: 'parent-archived' }
            }
          }
          // 返修 #10/N4:幂等 header 复用(owner+method+resourceKind+key + fingerprint)。
          if (opts.idempotencyKey) {
            const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
            if (entry) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
              if (r) {
                // N4:同 key 不同 fingerprint(不同 body)→ reuse-conflict。
                if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
                // N2:幂等命中 deleted → 真恢复(undelete + bump + restore tree);非 deleted → 返既有不 bump。
                if (r.is_deleted) {
                  // F1:replay 命中 deleted → 真恢复。idem 条目已存在(:436 读到),不重插(INSERT DO NOTHING→null→误判
                  //   race loser→回滚恢复,外层映射 existing → 返成功但资源仍删除态)。entry fingerprint 已验(:441),无需更新。
                  // F4:按 restoreMetaInTrx 的 rowCount 定输赢——0 行(并发赢家已恢复)→ existing,非 0 → restored。
                  const { record: restoredRec, restored } = await this.restoreMetaInTrx(trx, ownerId, type, id, payload, opts)
                  return { kind: restored ? 'restored' : 'existing', record: this.withIdem(restoredRec, opts) }
                }
                return { kind: 'existing', record: this.withIdem(rowToRecord(r), opts) }
              }
              // idem 条目存在但 envelope 已 purge → 删 idem 条目,fallback 到正常 create。
              await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
            }
          }
          // 返修 #1:project id 全局唯一——跨 owner 同 id → exists-other-owner。
          if (type === 'project') {
            const g = await trx.selectFrom('projects').select(['owner_id']).where('id', '=', id).executeTakeFirst()
            if (g && g.owner_id !== ownerId) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'project').where('id', '=', id).executeTakeFirst()
              if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
            }
          }
          // Project create/update/restore 统一 projects-first。fresh insert 时 projects 行不存在,FOR UPDATE
          // 空结果为 no-op,随后 INSERT 逻辑不受影响；deleted project 则在写 meta 前锁住瘦索引行。
          // P3 item 5:捕获 projectState 供下方 deleted-restore 路径复用(同事务内避免 restoreProjectTreeInTrx
          //   再次 projectStateInTrx 重复锁查询;非语义优化,FOR UPDATE 同行已锁,仅省一次往返)。非 project 类型
          //   或 fresh/existing-live 路径不进 restore,preState 留 undefined(restoreProjectTreeInTrx 自行锁)。
          const projectPreState = type === 'project' ? await this.projectStateInTrx(trx, ownerId, id) : undefined
          const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
          const scope: PersistScope = opts.scope ?? 'document'
          const canvasId = opts.canvasId ?? null
          if (existing && !existing.is_deleted) {
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            return { kind: 'existing', record: this.withIdem(rowToRecord(existing), opts) }
          }
          if (existing && existing.is_deleted) {
            // N2:backend 原子 create-or-restore-tree。F4:rowCount 定输赢(并发赢家已恢复→existing)。
            // P3 item 5:传 projectPreState(project 路径,L878 已锁并取 state)→ restoreProjectTreeInTrx 复用,
            //   不再重复 projectStateInTrx(canvas 路径 preState=undefined,restoreCanvasTreeInTrx 本就不锁 project)。
            const { record: restoredRec, restored } = await this.restoreMetaInTrx(trx, ownerId, type, id, payload, opts, projectPreState)
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            return { kind: restored ? 'restored' : 'existing', record: this.withIdem(restoredRec, opts) }
          }
          // 不存在 → created(revision 0;orderKey 0 for meta;createdAt/updatedAt = now)。
          // Greptile P1(全局索引竞争):project/canvas 全局唯一索引先建(doNothing+returning);若 returning 空(跨事务
          // race 被吞)→ re-SELECT 归属 → 跨 owner → exists-other-owner(此时 persist_records 尚未插入,trx 提交无 partial)。
          if (type === 'project') {
            const idx = await trx.insertInto('projects').values({ id, owner_id: ownerId, is_deleted: false, status: opts.status ?? 'active' }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst()
            if (!idx) {
              const g = await trx.selectFrom('projects').select('owner_id').where('id', '=', id).executeTakeFirst()
              if (g && g.owner_id !== ownerId) {
                const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'project').where('id', '=', id).executeTakeFirst()
                if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
              }
            }
          } else if (type === 'canvas') {
            const idx = await trx.insertInto('canvases').values({ id, owner_id: ownerId, is_deleted: false, status: opts.status ?? 'active' }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst()
            if (!idx) {
              const g = await trx.selectFrom('canvases').select('owner_id').where('id', '=', id).executeTakeFirst()
              if (g && g.owner_id !== ownerId) {
                const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'canvas').where('id', '=', id).executeTakeFirst()
                if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
              }
            }
          }
          // 全局索引赢了 → INSERT persist_records。P1-3:ON CONFLICT DO NOTHING + 重读转 existing/restored
          // (同 owner 同 id 跨事务 race:输家不再 23505 泄漏成 500,重读赢家已提交行返 200 existing/restored)。
          const created = await trx
            .insertInto('persist_records')
            .values({
              id,
              owner_id: ownerId,
              canvas_id: canvasId,
              type,
              scope,
              revision: 0,
              order_key: 0,
              is_deleted: false,
              status: opts.status ?? 'active',
              payload: JSON.stringify(payload),
            })
            .onConflict((oc) => oc.columns(['owner_id', 'type', 'id']).doNothing())
            .returningAll()
            .executeTakeFirst()
          if (!created) {
            // P1-3:另一事务已创建 (owner,type,id)(INSERT ON CONFLICT 阻塞至其提交后返回空)。重读 → existing/restored。
            const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
            if (r) {
              if (r.is_deleted) {
                const { record: restoredRec, restored } = await this.restoreMetaInTrx(trx, ownerId, type, id, payload, opts)
                await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
                return { kind: restored ? 'restored' : 'existing', record: this.withIdem(restoredRec, opts) }
              }
              await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
              return { kind: 'existing', record: this.withIdem(rowToRecord(r), opts) }
            }
            throw new Error(`ensureCreate: insert conflict anomaly for ${type}:${id}`)
          }
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
          return { kind: 'created', record: this.withIdem(rowToRecord(created), opts) }
        })
        // P1-5:post-commit 定点 cache mutation(纯内存,不可失败;不再 await warm)。project/canvas create/restore → isDeleted=false。
        if ((result.kind === 'created' || result.kind === 'restored') && (type === 'project' || type === 'canvas')) {
          this.setIndexEntry(type, id, ownerId, false)
        }
        return result
      },
      (winnerRecord, mismatch) =>
        mismatch ? { kind: 'reuse-conflict' } : { kind: 'existing', record: this.withIdem(winnerRecord, opts) },
    )
  }

  /** 给返回 record 回填 idempotencyKey/fingerprint(内存实现把它们存 record 行;PG 不持久化在 record 行,从 opts 回填以匹配契约测试断言)。 */
  private withIdem(rec: PersistRecord, opts: { idempotencyKey?: string; bodyFingerprint?: string }): PersistRecord {
    return { ...rec, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint }
  }

  /**
   * N2 私有 helper(事务内):meta record(project/canvas/chat-collection)恢复。
   * project/canvas → restoreProjectTree/restoreCanvasTreeInTrx(单 record + 子树);chat-collection → 单 record undelete+bump+payload。
   * F4:返 { record, restored }——restored = meta UPDATE rowCount>0(并发赢家已恢复→0 行→调用方返 existing,不再误报 restored)。
   */
  private async restoreMetaInTrx(
    trx: Kysely<Database>,
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; status?: RecordStatus },
    // P3 item 5:ensureCreate(project deleted) 路径传入上游已取的 projectState,避免 restoreProjectTreeInTrx
    //   重复 projectStateInTrx(同事务同行已锁,仅省一次往返;非语义优化)。undefined(其他调用方)→ 自行锁。
    preProjectState?: { live: boolean; archived: boolean },
  ): Promise<{ record: PersistRecord; restored: boolean }> {
    let restored: boolean
    if (type === 'project') {
      const { metaRestored } = await this.restoreProjectTreeInTrx(trx, ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint, status: opts.status }, preProjectState)
      restored = metaRestored
    } else if (type === 'canvas') {
      const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint, status: opts.status })
      restored = metaRestored
    } else {
      // chat-collection / leaf meta:单 record undelete + bump + payload。F4:WHERE is_deleted=true + rowCount 定输赢(0 行=并发赢家已恢复)。
      const upd = await trx
        .updateTable('persist_records')
        .set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: opts.canvasId ?? sql`canvas_id`, scope: opts.scope ?? sql`scope` })
        .where('owner_id', '=', ownerId)
        .where('type', '=', type)
        .where('id', '=', id)
        .where('is_deleted', '=', true)
        .executeTakeFirst()
      restored = (upd?.numUpdatedRows ?? 0n) > 0n
    }
    const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
    if (!r) throw new Error(`restoreMetaInTrx: ${type}:${id} missing post-restore`)
    return { record: rowToRecord(r), restored }
  }

  async createCanvasWithCollection(
    ownerId: string,
    canvasId: string,
    canvasPayload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; status?: RecordStatus },
  ): Promise<EnsureCreateResult> {
    await this.ready
    return this.withIdempotencyGuard(
      async () => {
        const result: EnsureCreateResult = await this.db.transaction().execute(async (trx) => {
          // F4:canvas id 全局唯一(跨 owner 同 id → exists-other-owner;在 idem-replay 之前)。
          const g = await trx.selectFrom('canvases').select(['owner_id', 'is_deleted']).where('id', '=', canvasId).executeTakeFirst()
          if (g && g.owner_id !== ownerId) {
            const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
            if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
          }
          // F1:父 project 须 live(软删 parent 下禁独立 child create/restore;防 orphan)。
          // SG-1:archived 目标 project 拒子画布 create(route → 409 archived;defense-in-depth)。
          const pid = asCanvasMeta(canvasPayload)?.projectId
          if (pid) {
            const ps = await this.projectStateInTrx(trx, ownerId, pid)
            if (!ps.live) return { kind: 'parent-not-live' }
            if (ps.archived) return { kind: 'parent-archived' }
          }
          // 幂等 replay(owner+method+resourceKind+key + fingerprint)。
          if (opts.idempotencyKey) {
            const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
            if (entry) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
              if (r) {
                if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
                // N2/F1:幂等命中 deleted → 真恢复(事务内:复验 parent live + restore canvas+collection + ensureCollectionLive)。
                if (r.is_deleted) {
                  // SG-1:restore 路径同门禁(archived 目标 project 拒恢复)。
                  const pid2 = asCanvasMeta(canvasPayload)?.projectId
                  if (pid2) {
                    const ps2 = await this.projectStateInTrx(trx, ownerId, pid2)
                    if (!ps2.live) return { kind: 'parent-not-live' }
                    if (ps2.archived) return { kind: 'parent-archived' }
                  }
                  // F1:replay 命中 deleted → 真恢复。idem 条目已存在(:602 读到),不重插(否则误判 race loser→回滚恢复)。
                  // F4:按 restoreCanvasTreeInTrx 的 rowCount 定输赢——0 行(并发赢家已恢复)→ existing。
                  const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint, status: opts.status })
                  await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
                  const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
                  if (!rec) throw new Error('createCanvasWithCollection: post-restore canvas missing')
                  return { kind: metaRestored ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
                }
                // existing live:collection 已随 canvas 原子创建;ensureCollectionLive 防御旧数据。
                await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
                return { kind: 'existing', record: this.withIdem(rowToRecord(r), opts) }
              }
              await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
            }
          }
          const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
          if (existing && !existing.is_deleted) {
            await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
            return { kind: 'existing', record: this.withIdem(rowToRecord(existing), opts) }
          }
          if (existing && existing.is_deleted) {
            // N2/F1:parent live(已验 F1)→ restored(事务内 restore + ensureCollectionLive)。F4:rowCount 定输赢(并发赢家已恢复→existing)。
            const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint, status: opts.status })
            await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
            const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
            if (!rec) throw new Error('createCanvasWithCollection: post-restore canvas missing')
            return { kind: metaRestored ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
          }
          // 不存在 → 原子 created(canvas meta + chat-collection + canvases 全局索引 同一事务;失败全回滚,无 partial,无 orphan)。
          // Greptile P1(全局索引竞争):canvases 全局索引先建(doNothing+returning);若 returning 空(跨事务 race 被吞)
          // → re-SELECT 归属 → 跨 owner → exists-other-owner(此时 canvas meta/collection 尚未插入,trx 提交无 partial)。
          const idx = await trx.insertInto('canvases').values({ id: canvasId, owner_id: ownerId, is_deleted: false, status: opts.status ?? 'active' }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst()
          if (!idx) {
            const g = await trx.selectFrom('canvases').select('owner_id').where('id', '=', canvasId).executeTakeFirst()
            if (g && g.owner_id !== ownerId) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
              if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
            }
            // 同 owner race:canvases 索引被另一事务占。下面 persist_records INSERT ON CONFLICT DO NOTHING + 重读处理(同 owner 不泄漏)。
          }
          // P1-3:canvas meta INSERT ON CONFLICT DO NOTHING + 重读(同 owner 同 id race:输家重读赢家已提交行 → existing/restored,不再 23505)。
          const canvasInsert = await trx
            .insertInto('persist_records')
            .values({ id: canvasId, owner_id: ownerId, canvas_id: null, type: 'canvas', scope: 'document', revision: 0, order_key: 0, is_deleted: false, status: opts.status ?? 'active', payload: JSON.stringify(canvasPayload) })
            .onConflict((oc) => oc.columns(['owner_id', 'type', 'id']).doNothing())
            .returningAll()
            .executeTakeFirst()
          if (!canvasInsert) {
            const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
            if (r) {
              await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
              if (r.is_deleted) {
                // F4:rowCount 定输赢(并发赢家已恢复→existing)。
                const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint, status: opts.status })
                await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
                await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
                const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
                if (!rec) throw new Error('createCanvasWithCollection: post-restore canvas missing')
                return { kind: metaRestored ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
              }
              await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
              return { kind: 'existing', record: this.withIdem(rowToRecord(r), opts) }
            }
            throw new Error(`createCanvasWithCollection: canvas meta conflict anomaly for ${canvasId}`)
          }
          // chat-collection(ON CONFLICT DO NOTHING;若赢家同事务已建则 no-op,幂等)。
          await trx
            .insertInto('persist_records')
            .values({ id: canvasId, owner_id: ownerId, canvas_id: canvasId, type: 'chat-collection', scope: 'document', revision: 0, order_key: 0, is_deleted: false, payload: JSON.stringify({}) })
            .onConflict((oc) => oc.columns(['owner_id', 'type', 'id']).doNothing())
            .execute()
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
          const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
          if (!rec) throw new Error('createCanvasWithCollection: post-create canvas missing')
          return { kind: 'created', record: this.withIdem(rowToRecord(rec), opts) }
        })
        // P1-5:post-commit 定点 cache mutation(canvas create/restore → isDeleted=false)。
        if (result.kind === 'created' || result.kind === 'restored') {
          this.setIndexEntry('canvas', canvasId, ownerId, false)
        }
        return result
      },
      (winnerRecord, mismatch) =>
        mismatch ? { kind: 'reuse-conflict' } : { kind: 'existing', record: this.withIdem(winnerRecord, opts) },
    )
  }

  /**
   * F1 事务内:canvas live 时确保 chat-collection 也 live(create-or-restore idempotent;防旧数据/恢复遗漏 orphan)。
   * 不存在 → create;soft-deleted → undelete+bump+清 payload;live → no-op。不 bump canvas contentVersion(meta 配对创建)。
   */
  private async ensureCollectionLiveInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string): Promise<void> {
    const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('id', '=', canvasId).executeTakeFirst()
    if (existing && !existing.is_deleted) return
    if (existing && existing.is_deleted) {
      await trx.updateTable('persist_records').set({ payload: JSON.stringify({}), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('id', '=', canvasId).execute()
      return
    }
    await trx.insertInto('persist_records').values({ id: canvasId, owner_id: ownerId, canvas_id: canvasId, type: 'chat-collection', scope: 'document', revision: 0, order_key: 0, is_deleted: false, payload: JSON.stringify({}) }).execute()
  }

  async ensureCreateChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<EnsureChildResult> {
    await this.ready
    return this.withIdempotencyGuard(
      async () => {
        return this.db.transaction().execute(async (trx) => {
          // CR-6 缺口2:事务起点 FOR UPDATE 重验 archived(与写入同原子边界)。
          await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
          if (opts.idempotencyKey) {
            const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
            if (entry) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
              if (r) {
                if (r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
                if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
                if (r.is_deleted) {
                  // F1:replay 命中 deleted → 真恢复。idem 条目已存在(:728 读到),不重插(否则误判 race loser→回滚恢复)。
                  // F4:WHERE is_deleted=true + rowCount 定输赢——0 行(并发赢家已恢复)→ existing,非 0 → restored(并 bump contentVersion)。
                  // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
                  const upd = await trx.updateTable('persist_records').set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: canvasId }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).where('is_deleted', '=', true).executeTakeFirst()
                  if ((upd?.numUpdatedRows ?? 0n) > 0n && type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
                  const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
                  if (!rec) throw new Error('ensureCreateChild: post-restore missing')
                  return { kind: (upd?.numUpdatedRows ?? 0n) > 0n ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
                }
                return { kind: 'existing', record: this.withIdem(rowToRecord(r), opts) }
              }
              await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
            }
          }
          const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
          if (existing && existing.canvas_id !== canvasId) return { kind: 'cross-canvas' }
          if (existing && !existing.is_deleted) {
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            return { kind: 'existing', record: this.withIdem(rowToRecord(existing), opts) }
          }
          if (existing && existing.is_deleted) {
            // F4:WHERE is_deleted=true + rowCount 定输赢(并发赢家已恢复→existing;赢家 bump,输家不 bump)。
            // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
            const upd = await trx.updateTable('persist_records').set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: canvasId }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).where('is_deleted', '=', true).executeTakeFirst()
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            if ((upd?.numUpdatedRows ?? 0n) > 0n && type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
            const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
            if (!rec) throw new Error('ensureCreateChild: post-restore missing')
            return { kind: (upd?.numUpdatedRows ?? 0n) > 0n ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
          }
          // 不存在 → created(orderKey 分配,#6)。
          const orderKey = await this.nextOrderKeyInTrx(trx, ownerId, canvasId, type)
          await trx.insertInto('persist_records').values({ id, owner_id: ownerId, canvas_id: canvasId, type, scope: 'document', revision: 0, order_key: orderKey, is_deleted: false, payload: JSON.stringify(payload) }).execute()
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
          // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
          if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
          const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
          if (!rec) throw new Error('ensureCreateChild: post-create missing')
          return { kind: 'created', record: this.withIdem(rowToRecord(rec), opts) }
        })
      },
      (winnerRecord, mismatch) =>
        mismatch ? { kind: 'reuse-conflict' } : { kind: 'existing', record: this.withIdem(winnerRecord, opts) },
    )
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
    await this.ready
    return this.withIdempotencyGuard(
      async () => {
        const result: UpsertResult = await this.db.transaction().execute(async (trx) => {
          // CR-6 缺口2 + P2-4(全局锁序协议,lead 拍板两 backlog PR 统一:
          // projects 行 → persist_records project 行 → persist_records canvas 行 → children/幂等判定):
          // canvas meta PUT/move 先取 parent project 行(projectStateInTrx 锁 projects 表行,防 move 到软删/归档 project),
          // 再锁 persist_records canvas 行(assertCanvasWritableInTrx FOR UPDATE 重验 archived-live)。
          // fresh create/restore-tree 路径不受影响:missing 行放行,unarchive 走 tree 方法不经此。
          // 原序(canvas 先锁再取 project)与 softDeleteProjectTree/archiveProjectTree(projects→canvas)构成
          // 反向闭环 → 死锁;此序对齐协议,消除 canvas PUT 反向锁序死锁(#276 合并后 rebase 不复活 projectLiveInTrx)。
          if (type === 'canvas') {
            const pid = asCanvasMeta(payload)?.projectId
            if (pid) {
              const ps = await this.projectStateInTrx(trx, ownerId, pid)
              if (!ps.live) return { kind: 'parent-not-live' }
              if (ps.archived) return { kind: 'parent-archived' }
            }
          }
          if (type === 'canvas') await this.assertCanvasWritableInTrx(trx, ownerId, id)
          if (opts.idempotencyKey) {
            const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
            if (entry) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
              if (r) {
                if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
                return { kind: r.is_deleted ? 'created' : 'updated', record: this.withIdem(rowToRecord(r), opts) }
              }
              await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
            }
          }
          // Project upsert 的 fresh/deleted 两分支都 projects-first。不存在的索引行锁为 no-op；
          // deleted 分支则确保下面 persist_records ON CONFLICT UPDATE 前已持 projects 行锁。
          if (type === 'project') await this.projectStateInTrx(trx, ownerId, id)
          const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
          const scope: PersistScope = opts.scope ?? 'document'
          const canvasId = opts.canvasId ?? null
          // F3:upsert missing 路径全局 owner 检查——id 已属他人 → exists-other-owner(不跨 owner insert、不覆盖缓存;
          //   route → 409 project-exists/canvas-exists,与 ensureCreate 同语义;route 层 authz+预检已阻,backend 防御性拒绝)。
          if (!existing && type === 'project') {
            const g = await trx.selectFrom('projects').select('owner_id').where('id', '=', id).executeTakeFirst()
            if (g && g.owner_id !== ownerId) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'project').where('id', '=', id).executeTakeFirst()
              if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
            }
          } else if (!existing && type === 'canvas') {
            const g = await trx.selectFrom('canvases').select('owner_id').where('id', '=', id).executeTakeFirst()
            if (g && g.owner_id !== ownerId) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'canvas').where('id', '=', id).executeTakeFirst()
              if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
            }
          }
          // missing 或软删 → create(revision max(0,base),返修 #5;canvas 保留 contentVersion)。
          if (!existing || existing.is_deleted) {
            const base = opts.base ?? 0
            const rev = existing ? Number(existing.revision) + 1 : Math.max(0, base)
            const oldCv = existing && type === 'canvas' ? asCanvasMeta(existing.payload)?.contentVersion ?? 0 : 0
            const newPayload = type === 'canvas' ? { ...(payload as object), contentVersion: oldCv } : payload
            const created = await trx
              .insertInto('persist_records')
              .values({
                id,
                owner_id: ownerId,
                canvas_id: canvasId,
                type,
                scope,
                revision: rev,
                order_key: 0,
                is_deleted: false,
                payload: JSON.stringify(newPayload),
              })
              .onConflict((oc) =>
                oc.columns(['owner_id', 'type', 'id']).doUpdateSet({
                  payload: JSON.stringify(newPayload),
                  is_deleted: false,
                  revision: rev,
                  updated_at: new Date(),
                  canvas_id: canvasId,
                  scope,
                }),
              )
              .returningAll()
              .executeTakeFirst()
            if (!created) throw new Error(`upsert: upsert failed for ${type}:${id}`)
            if (type === 'project') await trx.insertInto('projects').values({ id, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.column('id').doUpdateSet({ is_deleted: false, updated_at: new Date() })).execute()
            if (type === 'canvas') await trx.insertInto('canvases').values({ id, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.column('id').doUpdateSet({ is_deleted: false, updated_at: new Date() })).execute()
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            return { kind: 'created', record: this.withIdem(rowToRecord(created), opts) }
          }
          // existing & !deleted → 返修 #4:缺 base → precondition-required(428)。
          if (opts.base === undefined) return { kind: 'precondition-required', record: this.withIdem(rowToRecord(existing), opts) }
          if (opts.base !== Number(existing.revision)) return { kind: 'conflict', currentRevision: Number(existing.revision), record: this.withIdem(rowToRecord(existing), opts) }
          // base 匹配 → 乐观并发 bump + update(canvas_id 不可变,返修 #3:保留 existing.canvasId;contentVersion 保留)。
          const oldCv = type === 'canvas' ? asCanvasMeta(existing.payload)?.contentVersion ?? 0 : 0
          const newPayload = type === 'canvas' ? { ...(payload as object), contentVersion: oldCv } : payload
          const updated = await trx
            .updateTable('persist_records')
            .set({
              payload: JSON.stringify(newPayload),
              revision: sql`revision + 1`,
              updated_at: new Date(),
              scope,
            })
            .where('owner_id', '=', ownerId)
            .where('type', '=', type)
            .where('id', '=', id)
            .where('revision', '=', opts.base)
            .returningAll()
            .executeTakeFirst()
          if (!updated) {
            // 乐观并发失败(base 不匹配,跨事务 race)→ conflict。
            const cur = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
            return { kind: 'conflict', currentRevision: cur ? Number(cur.revision) : opts.base, record: this.withIdem(cur ? rowToRecord(cur) : rowToRecord(existing), opts) }
          }
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
          return { kind: 'updated', record: this.withIdem(rowToRecord(updated), opts) }
        })
        // P1-5/F3:post-commit 定点 cache mutation(project/canvas create → isDeleted=false);用 DB 返回的 ownerId(非入参),F3 跨 owner 检查已确保 create 仅为本 owner。
        if (result.kind === 'created' && (type === 'project' || type === 'canvas')) {
          this.setIndexEntry(type, id, result.record.ownerId, false)
        }
        return result
      },
      (winnerRecord, mismatch) =>
        mismatch
          ? { kind: 'reuse-conflict' }
          : { kind: winnerRecord.isDeleted ? 'created' : 'updated', record: this.withIdem(winnerRecord, opts) },
    )
  }

  async softDelete(ownerId: string, type: PersistType, id: string): Promise<{ deleted: boolean; record?: PersistRecord }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
      if (!existing) return { deleted: false }
      if (!existing.is_deleted) {
        const updated = await trx
          .updateTable('persist_records')
          .set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() })
          .where('owner_id', '=', ownerId)
          .where('type', '=', type)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst()
        // project/canvas 软删占位在全局索引表(canvases/projects);缓存同步由 post-commit 定点 mutation(P1-5)。
        return { deleted: true, record: rowToRecord(updated ?? existing) }
      }
      return { deleted: true, record: rowToRecord(existing) }
    })
    // P1-5:post-commit 定点 cache mutation(project/canvas 软删 → isDeleted=true;纯内存,不可失败)。
    if (res.deleted && (type === 'project' || type === 'canvas')) {
      this.setIndexEntry(type, id, ownerId, true)
    }
    return res
  }

  // ── 子资源(node/edge/anchor/chat-message)──────────────────────────────────────────────

  async getChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<GetChildResult> {
    await this.ready
    const r = await this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
    if (!r) return { kind: 'missing' }
    if (r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
    return { kind: 'found', record: rowToRecord(r) }
  }

  async upsertChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { base?: Revision; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; strictUpdate?: boolean },
  ): Promise<UpsertChildResult> {
    await this.ready
    return this.withIdempotencyGuard(
      async () => {
        return this.db.transaction().execute(async (trx) => {
          // CR-6 缺口2:事务起点 FOR UPDATE 重验 archived(legacyReplaceDrain 委托本方法,守卫一并覆盖)。
          await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
          if (opts.idempotencyKey) {
            const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
            if (entry) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
              if (r) {
                if (r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
                if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
                return { kind: 'updated', record: this.withIdem(rowToRecord(r), opts) }
              }
              await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
            }
          }
          const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
          if (existing && existing.canvas_id !== canvasId) return { kind: 'cross-canvas' }
          // DP-6R P2-1:strict-update(chat PATCH)——actor bucket 无此 id/已删 → not-found(route 404 unknown-message),
          // 不许借 PATCH create 己方副本(POST 是唯一 create 入口)。事务内 SELECT + 拒绝,不走 create 的 INSERT ON
          // CONFLICT,无 get-then-upsert TOCTOU(create-on-missing 是旧 bug;strict-update 只拒绝,不 create)。
          if (opts.strictUpdate && (!existing || existing.is_deleted)) return { kind: 'not-found' }
          if (!existing || existing.is_deleted) {
            const base = opts.base ?? 0
            const rev = existing ? Number(existing.revision) + 1 : Math.max(0, base)
            const orderKey = existing ? Number(existing.order_key) : await this.nextOrderKeyInTrx(trx, ownerId, canvasId, type)
            const created = await trx
              .insertInto('persist_records')
              .values({ id, owner_id: ownerId, canvas_id: canvasId, type, scope: 'document', revision: rev, order_key: orderKey, is_deleted: false, payload: JSON.stringify(payload) })
              .onConflict((oc) => oc.columns(['owner_id', 'type', 'id']).doUpdateSet({ payload: JSON.stringify(payload), is_deleted: false, revision: rev, canvas_id: canvasId, updated_at: new Date() }))
              .returningAll()
              .executeTakeFirst()
            if (!created) throw new Error(`upsertChild: upsert failed for ${type}:${id}`)
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion(node/edge/anchor 仍 bump)。
            if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
            return { kind: 'created', record: this.withIdem(rowToRecord(created), opts) }
          }
          if (opts.base === undefined) return { kind: 'precondition-required', record: this.withIdem(rowToRecord(existing), opts) }
          if (opts.base !== Number(existing.revision)) return { kind: 'conflict', currentRevision: Number(existing.revision), record: this.withIdem(rowToRecord(existing), opts) }
          const result = await trx
            .updateTable('persist_records')
            .set({ payload: JSON.stringify(payload), revision: sql`revision + 1`, updated_at: new Date(), canvas_id: existing.canvas_id })
            .where('owner_id', '=', ownerId)
            .where('type', '=', type)
            .where('id', '=', id)
            .where('revision', '=', opts.base)
            .returningAll()
            .executeTakeFirst()
          if (!result) {
            const cur = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
            return { kind: 'conflict', currentRevision: cur ? Number(cur.revision) : opts.base, record: this.withIdem(cur ? rowToRecord(cur) : rowToRecord(existing), opts) }
          }
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
          // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion。
          if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
          return { kind: 'updated', record: this.withIdem(rowToRecord(result), opts) }
        })
      },
      (winnerRecord, mismatch) =>
        mismatch ? { kind: 'reuse-conflict' } : { kind: 'updated', record: this.withIdem(winnerRecord, opts) },
    )
  }

  // ── A2-S2 §14.3:legacy drain(PATCH /:id/nodes/:nodeId 复用 decoder wire;FX-5 队列迁移 drain-only 兼容通道)──
  // 四态矩阵(同 InMemory;fresh 落 upsertChild(base 重验)作 TOCTOU guard;seq 独立 tx bump,observability cursor)。
  async legacyReplaceDrain(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    recordId: string,
    env: { payload: unknown; baseRevision: Revision },
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; actor: string },
  ): Promise<LegacyReplaceDrainResult> {
    await this.ready
    // 先 getChild 判 stale(existing+base≠rev / missing+base>0 → 409 dead-letter),fresh 再 upsertChild 原子写。
    const got = await this.getChild(ownerId, canvasId, type, recordId)
    if (got.kind === 'cross-canvas') return { kind: 'cross-canvas' }
    if (got.kind === 'found') {
      // existing+base≠rev → 409 terminal conflict(不盲 replace;队列残留是离线期改动,覆盖是数据破坏)
      if (env.baseRevision !== got.record.revision) {
        return { kind: 'stale-conflict', currentRevision: got.record.revision }
      }
      // fresh(existing+base=rev)→ 落 upsertChild(base 重验,TOCTOU guard)
    } else {
      // missing+base>0 → 409 dead-letter(防盲 create 复活已删 record);missing+base=0 → create fresh 落 upsertChild
      if (env.baseRevision > 0) return { kind: 'stale-conflict', currentRevision: 0 }
    }
    // whole-record replace(委托 upsertChild;base=env.baseRevision → upsertChild conflict check 充当 TOCTOU guard:
    //   getChild 与 write 之间并发写 bump revision → upsertChild base≠current → conflict,非盲 replace)。
    const r = await this.upsertChild(ownerId, canvasId, type, recordId, env.payload, {
      base: env.baseRevision,
      idempotencyKey: opts.idempotencyKey,
      method: opts.method,
      resourceKind: opts.resourceKind,
      bodyFingerprint: opts.bodyFingerprint,
      strictUpdate: false,
    })
    if (r.kind === 'created' || r.kind === 'updated') {
      // seq = per-canvas 单调事件序号(§10.5);独立 tx bump(observability cursor,record 写已由 upsertChild 原子落)。
      const seq = await this.db.transaction().execute(async (trx) => this.nextCanvasSeqInTrx(trx, canvasId))
      return { kind: 'replaced', record: r.record, seq }
    }
    if (r.kind === 'conflict') return { kind: 'stale-conflict', currentRevision: r.currentRevision }
    if (r.kind === 'cross-canvas') return { kind: 'cross-canvas' }
    if (r.kind === 'reuse-conflict') return { kind: 'reuse-conflict' }
    // precondition-required / not-found —— 不应发生(传了 base + strictUpdate=false);防御返 stale-conflict
    return { kind: 'stale-conflict', currentRevision: 0 }
  }

  async hardDeleteChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<{ deleted: boolean }> {
    await this.ready
    return this.db.transaction().execute(async (trx) => {
      // CR-6 缺口2:chat DELETE 路由走 authz 'write'(canvas.ts:991)→ archived 属写禁面;事务起点重验。
      await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
      const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
      if (!r || r.canvas_id !== canvasId) return { deleted: false }
      await trx.deleteFrom('persist_records').where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).execute()
      await trx.deleteFrom('idempotency_index').where('envelope_owner', '=', ownerId).where('envelope_type', '=', type).where('envelope_id', '=', id).execute()
      // DP-6R:chat-message per-actor 私有,不 bump 共享 canvas contentVersion(node/edge/anchor 硬删仍 bump)。
      if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
      return { deleted: true }
    })
  }

  // ── A2-S2 PG helpers(canvas_seq / field_clocks / child_tombstones;009 migration 表;conn=trx 或 this.db 均可)──
  /** 事务内 bump per-canvas seq(UPSERT;首 INSERT seq=1,conflict seq+1);返新 seq。 */
  private async nextCanvasSeqInTrx(conn: Kysely<Database>, canvasId: string): Promise<number> {
    const row = await conn
      .insertInto('canvas_seq')
      .values({ canvas_id: canvasId, seq: 1 })
      .onConflict((oc) => oc.column('canvas_id').doUpdateSet({ seq: sql`canvas_seq.seq + 1`, updated_at: new Date() }))
      .returning('seq')
      .executeTakeFirstOrThrow()
    return Number(row.seq)
  }
  /** 事务内读 per-canvas seq(缺省 0)。 */
  private async readCanvasSeqInTrx(conn: Kysely<Database>, canvasId: string): Promise<number> {
    const r = await conn.selectFrom('canvas_seq').select('seq').where('canvas_id', '=', canvasId).executeTakeFirst()
    return r ? Number(r.seq) : 0
  }
  /** 事务内读 per-record per-field clock(缺省 0)。 */
  private async getFieldClockInTrx(conn: Kysely<Database>, rk: string, fieldKey: string): Promise<number> {
    const r = await conn.selectFrom('field_clocks').select('clock').where('record_key', '=', rk).where('field_key', '=', fieldKey).executeTakeFirst()
    return r ? Number(r.clock) : 0
  }
  /** 事务内 bump per-record per-field clock(UPSERT;首 INSERT clock=1,conflict clock+1)+ writer;返新 clock。 */
  private async bumpFieldClockInTrx(conn: Kysely<Database>, rk: string, fieldKey: string, writer: string): Promise<number> {
    const row = await conn
      .insertInto('field_clocks')
      .values({ record_key: rk, field_key: fieldKey, clock: 1, writer, updated_at: new Date() })
      .onConflict((oc) => oc.columns(['record_key', 'field_key']).doUpdateSet({ clock: sql`field_clocks.clock + 1`, writer, updated_at: new Date() }))
      .returning('clock')
      .executeTakeFirstOrThrow()
    return Number(row.clock)
  }
  /** 事务内读 per-record 全 fieldClocks 快照(供 route encodeBase)。 */
  private async snapshotFieldClocksInTrx(conn: Kysely<Database>, rk: string): Promise<FieldClocks> {
    const rows = await conn.selectFrom('field_clocks').select(['field_key', 'clock']).where('record_key', '=', rk).execute()
    const out: FieldClocks = {}
    for (const r of rows) out[r.field_key] = Number(r.clock)
    return out
  }
  /** 事务内读 per-field writer(overwritten notice 的 byActor;缺省 'unknown')。 */
  private async getFieldWriterInTrx(conn: Kysely<Database>, rk: string, fieldKey: string): Promise<string> {
    const r = await conn.selectFrom('field_clocks').select('writer').where('record_key', '=', rk).where('field_key', '=', fieldKey).executeTakeFirst()
    return r?.writer ?? 'unknown'
  }
  /** 事务内查 tombstone(§10.7 幂等已删返 seq vs 从未存在 404)。 */
  private async isTombstonedInTrx(conn: Kysely<Database>, rk: string): Promise<boolean> {
    const r = await conn.selectFrom('child_tombstones').select('record_key').where('record_key', '=', rk).executeTakeFirst()
    return !!r
  }
  /** 事务内写 tombstone(物理删后留占位;ON CONFLICT DO NOTHING 幂等)。 */
  private async setTombstoneInTrx(conn: Kysely<Database>, rk: string, canvasId: string, seqAtDelete: number): Promise<void> {
    await conn
      .insertInto('child_tombstones')
      .values({ record_key: rk, canvas_id: canvasId, seq_at_delete: seqAtDelete })
      .onConflict((oc) => oc.column('record_key').doNothing())
      .execute()
  }

  // ── A2-S2 field-level DomainOp 路径(§10.1/§14.1;PG 单事务实装,逻辑同 InMemory,复用 domainOp setByPath)──
  async applyDomainOps(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    recordId: string,
    ops: DomainOp[],
    opts: {
      baseRevision?: Revision
      baseFieldClocks?: FieldClocks
      idempotencyKey?: string
      method: string
      resourceKind: string
      bodyFingerprint?: string
      actor: string
    },
  ): Promise<ApplyDomainOpsResult> {
    await this.ready
    try {
      return await this.db.transaction().execute(async (trx) => {
        // CR-6 缺口2:事务起点 FOR UPDATE 重验 archived。
        await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
        const rk = pgRecordKey(ownerId,type, recordId)
        // idem 预检 replay(同 key 已提交 → 返既有 accepted,不二次 bump,§10.3 idempotent replay)
        if (opts.idempotencyKey) {
          const entry = await trx.selectFrom('idempotency_index').select(['fingerprint', 'envelope_owner', 'envelope_type', 'envelope_id']).where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).executeTakeFirst()
          if (entry) {
            const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
            if (r) {
              if (r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
              if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
              return { kind: 'accepted', record: this.withIdem(rowToRecord(r), opts), seq: await this.readCanvasSeqInTrx(trx, canvasId), fieldClocks: await this.snapshotFieldClocksInTrx(trx, rk), overwritten: [] }
            }
            // stale idem entry(record 物理删)→ 清 + 继续写
            await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
          }
        }
        // SELECT existing FOR UPDATE(锁 record 行,序列化并发 edit;edit 永不 409,base 仅作 overwritten 判定)
        const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).forUpdate().executeTakeFirst()
        if (existing && existing.canvas_id !== canvasId) return { kind: 'cross-canvas' }
        if (!existing || existing.is_deleted) return { kind: 'not-found' }
        if (opts.baseRevision === undefined) return { kind: 'precondition-required' }
        // ★ batch 同 record 原子:逐 op apply(clone payload)+ 收集 toBump;全 ok 后统一 bump+UPDATE(无 partial)。
        const updatedPayload = clone(existing.payload) as Record<string, unknown>
        // F1-ter:unsetByPath 顶层 required 空壳保留回调(schema 推导);relations:{} 保留,optional 顶层照剪。
        const childType: 'node' | 'edge' | 'anchor' | undefined =
          type === 'node' || type === 'edge' || type === 'anchor' ? type : undefined
        const requiredFields = childType === undefined ? undefined : requiredTopLevelFields(childType)
        const isRequiredTopLevel: ((key: string) => boolean) | undefined =
          requiredFields === undefined ? undefined : (key: string): boolean => requiredFields.includes(key)
        const overwritten: OverwrittenNotice[] = []
        const toBump: string[] = []
        const seenFields = new Set<string>()
        for (const op of ops) {
          if (op.kind === 'reorder') throw new Error('reorder op not allowed in applyDomainOps (use reorderChildren)')
          const fieldPath = [...op.fieldPath] as (string | number)[]
          const fkey = fieldKeyOf(fieldPath)
          // §14.1:同 fieldKeyOf path stale(base.clock < current.clock)才 overwritten;不同 field stale 不误报。
          if (!seenFields.has(fkey)) {
            seenFields.add(fkey)
            const currentClock = await this.getFieldClockInTrx(trx, rk, fkey)
            const baseClock = opts.baseFieldClocks?.[fkey] ?? 0
            if (baseClock < currentClock) {
              overwritten.push({ fieldKey: fkey, historicalValue: getByPath(clone(existing.payload) as Record<string, unknown>, fieldPath), byActor: await this.getFieldWriterInTrx(trx, rk, fkey), currentRevision: Number(existing.revision) })
            }
          }
          if (op.kind === 'set') {
            setByPath(updatedPayload, fieldPath, op.value)
          } else if (op.kind === 'unset') {
            unsetByPath(updatedPayload, fieldPath, { isRequiredTopLevel })
          } else if (op.kind === 'array') {
            if (op.class === 'whole-lww') {
              setByPath(updatedPayload, fieldPath, op.value, { allowContainerClobber: true })
            } else {
              const arr = getByPath(updatedPayload, fieldPath)
              const set = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
              if (op.intent === 'insert') { if (!set.includes(op.value)) set.push(op.value) }
              else { const i = set.indexOf(op.value); if (i >= 0) set.splice(i, 1) }
              setByPath(updatedPayload, fieldPath, set, { allowContainerClobber: true })
            }
          }
          toBump.push(fkey)
        }
        // F1-ter(T2.2 Block 2 五轮):post-apply schema 校验堤坝 — UPDATE 前 validateChildPayload 对 mutated
        //   payload 递归白名单;非法(required 顶层被掏空 / set ['type']='bogus' / required child 缺失 / unknown-field)
        //   → 返 payload-rejected,fail-visible 不 commit(不 UPDATE、不 bump;tx 仅 SELECT,提交无副作用,无 partial)。
        if (childType !== undefined) {
          const damCheck = validateChildPayload(childType, updatedPayload, recordId)
          if (!damCheck.ok) return { kind: 'payload-rejected', body: damCheck.body }
        }
        // 全 op apply 成功 → UPDATE payload/revision + bump fieldClocks + canvas_seq + contentVersion + idem row(同事务原子)
        const newRev = Number(existing.revision) + 1
        const updated = await trx.updateTable('persist_records').set({ payload: JSON.stringify(updatedPayload), revision: newRev, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).returningAll().executeTakeFirst()
        if (!updated) throw new Error('applyDomainOps: update affected 0 rows (record vanished mid-tx;FOR UPDATE should prevent)')
        for (const fkey of toBump) await this.bumpFieldClockInTrx(trx, rk, fkey, opts.actor)
        const seq = await this.nextCanvasSeqInTrx(trx, canvasId)
        if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
        await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, recordId)
        return { kind: 'accepted', record: this.withIdem(rowToRecord(updated), opts), seq, fieldClocks: await this.snapshotFieldClocksInTrx(trx, rk), overwritten }
      })
    } catch (e) {
      // IdempotencyRaceLost:并发同 idem key,输家事务回滚 → 重读赢家构造 replay(同 body)/reuse-conflict(不同 body)
      if (e instanceof IdempotencyRaceLost) {
        if (e.fingerprintMismatch) return { kind: 'reuse-conflict' }
        const r = await this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).executeTakeFirst()
        if (!r || r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
        const rk = pgRecordKey(ownerId,type, recordId)
        return { kind: 'accepted', record: this.withIdem(rowToRecord(r), opts), seq: await this.readCanvasSeqInTrx(this.db, canvasId), fieldClocks: await this.snapshotFieldClocksInTrx(this.db, rk), overwritten: [] }
      }
      throw e
    }
  }

  async createChild(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    recordId: string,
    payload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; actor: string },
  ): Promise<CreateChildResult> {
    await this.ready
    try {
      return await this.db.transaction().execute(async (trx) => {
        // CR-6 缺口2:事务起点 FOR UPDATE 重验 archived。
        await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
        // idem 预检 replay
        if (opts.idempotencyKey) {
          const entry = await trx.selectFrom('idempotency_index').select(['fingerprint', 'envelope_owner', 'envelope_type', 'envelope_id']).where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).executeTakeFirst()
          if (entry) {
            const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
            if (r) {
              if (r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
              if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
              return { kind: 'created', record: this.withIdem(rowToRecord(r), opts), seq: await this.readCanvasSeqInTrx(trx, canvasId), fieldClocks: {} }
            }
            await trx.deleteFrom('idempotency_index').where('owner_id', '=', ownerId).where('method', '=', opts.method).where('resource_kind', '=', opts.resourceKind).where('key', '=', opts.idempotencyKey).execute()
          }
        }
        const rk = pgRecordKey(ownerId,type, recordId)
        // SELECT existing(create 用 INSERT ON CONFLICT 自身原子;不加 FOR UPDATE)
        const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).executeTakeFirst()
        if (existing && existing.canvas_id !== canvasId) return { kind: 'cross-canvas' }
        // existing & !isDeleted → dup-conflict(§10.2 create dup→409;不借 PATCH create)
        if (existing && !existing.is_deleted) return { kind: 'dup-conflict', existingRevision: Number(existing.revision) }
        // create(id 来自 path,client-id;返 seq+空 fieldClocks 供 route encodeBase;软删重建走 ON CONFLICT doUpdateSet)
        const rev = existing ? Number(existing.revision) + 1 : 1
        const orderKey = existing ? Number(existing.order_key) : await this.nextOrderKeyInTrx(trx, ownerId, canvasId, type)
        const created = await trx
          .insertInto('persist_records')
          .values({ id: recordId, owner_id: ownerId, canvas_id: canvasId, type, scope: 'document', revision: rev, order_key: orderKey, is_deleted: false, payload: JSON.stringify(payload) })
          .onConflict((oc) => oc.columns(['owner_id', 'type', 'id']).doUpdateSet({ payload: JSON.stringify(payload), is_deleted: false, revision: rev, canvas_id: canvasId, updated_at: new Date() }))
          .returningAll()
          .executeTakeFirst()
        if (!created) throw new Error(`createChild: insert failed for ${type}:${recordId}`)
        await trx.deleteFrom('child_tombstones').where('record_key', '=', rk).execute() // 重建清 tombstone(§10.7 幂等已删 → 重建后不再 idempotent)
        const seq = await this.nextCanvasSeqInTrx(trx, canvasId)
        if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
        await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, recordId)
        return { kind: 'created', record: this.withIdem(rowToRecord(created), opts), seq, fieldClocks: {} }
      })
    } catch (e) {
      // IdempotencyRaceLost:并发同 idem key,输家回滚 → 重读赢家构造 created replay / reuse-conflict
      if (e instanceof IdempotencyRaceLost) {
        if (e.fingerprintMismatch) return { kind: 'reuse-conflict' }
        const r = await this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).executeTakeFirst()
        if (!r || r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
        return { kind: 'created', record: this.withIdem(rowToRecord(r), opts), seq: await this.readCanvasSeqInTrx(this.db, canvasId), fieldClocks: {} }
      }
      throw e
    }
  }

  async deleteChildCascade(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    recordId: string,
    opts: { baseRevision?: Revision; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string; actor: string },
  ): Promise<DeleteChildResult> {
    await this.ready
    try {
      return await this.db.transaction().execute(async (trx) => {
        // CR-6 缺口2:子记录 DELETE 路由走 authz 'write'(canvas.ts:779)→ archived 属写禁面;事务起点重验。
        await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
        const rk = pgRecordKey(ownerId,type, recordId)
        // SELECT existing FOR UPDATE(锁,序列化并发 delete;fresh/stale 判定)
        const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).forUpdate().executeTakeFirst()
        if (existing && existing.canvas_id !== canvasId) return { kind: 'cross-canvas' }
        if (existing && !existing.is_deleted) {
          // base 必填(fresh/stale 判定)。
          if (opts.baseRevision === undefined) return { kind: 'precondition-required' }
          // ★ §14.1 冻结矩阵:delete fresh base→200,stale base→409 race(base.revision !== current → conflict)。
          if (opts.baseRevision !== Number(existing.revision)) return { kind: 'conflict', currentRevision: Number(existing.revision) }
          // fresh base → node-delete-cascade(§10.4:type='node' 删 node + 级联引用 edge;同事务原子)。
          const cascadedEdgeIds: string[] = []
          if (type === 'node') {
            const edges = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'edge').where('canvas_id', '=', canvasId).where('is_deleted', '=', false).execute()
            for (const e of edges) {
              const ep = e.payload as Record<string, unknown> | null
              if (ep && (ep.from === recordId || ep.to === recordId)) cascadedEdgeIds.push(e.id)
            }
          }
          await trx.deleteFrom('persist_records').where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', recordId).execute()
          for (const eid of cascadedEdgeIds) {
            await trx.deleteFrom('persist_records').where('owner_id', '=', ownerId).where('type', '=', 'edge').where('id', '=', eid).execute()
            await trx.deleteFrom('field_clocks').where('record_key', '=', pgRecordKey(ownerId,'edge', eid)).execute()
          }
          await trx.deleteFrom('field_clocks').where('record_key', '=', rk).execute() // 清被删 record 的 field clocks
          const seq = await this.nextCanvasSeqInTrx(trx, canvasId)
          await this.setTombstoneInTrx(trx, rk, canvasId, seq)
          if (type !== 'chat-message') await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, recordId)
          return { kind: 'deleted', seq }
        }
        // !existing:幂等已删 vs 从未存在(§10.7)。幂等已删(tombstone 命中)→ 返当前 seq(不 404,accepted 必携 cursor)。
        if (await this.isTombstonedInTrx(trx, rk)) return { kind: 'idempotent', seq: await this.readCanvasSeqInTrx(trx, canvasId) }
        return { kind: 'not-found' }
      })
    } catch (e) {
      // IdempotencyRaceLost:并发同 idem key(重复 DELETE)→ 输家回滚;delete 幂等 → idempotent
      if (e instanceof IdempotencyRaceLost) return { kind: 'idempotent', seq: await this.readCanvasSeqInTrx(this.db, canvasId) }
      throw e
    }
  }

  async reorderChildren(
    ownerId: string,
    canvasId: string,
    type: PersistType,
    orderedIds: string[],
    opts: { base: Revision },
  ): Promise<ReorderResult> {
    await this.ready
    return this.db.transaction().execute(async (trx) => {
      // CR-6 缺口2:事务起点 FOR UPDATE 重验 archived(与后续 canvasContentVersionInTrx 同行锁,顺序一致)。
      await this.assertCanvasWritableInTrx(trx, ownerId, canvasId)
      // live set(type + canvasId + !deleted)。
      const live = await trx.selectFrom('persist_records').select(['id']).where('owner_id', '=', ownerId).where('canvas_id', '=', canvasId).where('type', '=', type).where('is_deleted', '=', false).execute()
      const liveIds = new Set(live.map((r) => r.id))
      // N8:唯一性(含重复 → bad duplicate)。
      const seen = new Set<string>()
      for (const id of orderedIds) {
        if (seen.has(id)) return { kind: 'bad', reason: 'duplicate' }
        seen.add(id)
      }
      // N8:全等(orderedIds 须 === live set;缺/多 → bad mismatch)。
      if (orderedIds.length !== liveIds.size) return { kind: 'bad', reason: 'mismatch' }
      for (const id of orderedIds) {
        if (!liveIds.has(id)) return { kind: 'bad', reason: 'mismatch' }
      }
      // DP-6R P1-2:chat-message 走 per-actor×canvas **独立 orderRevision** compare+bump(非共享 cv)。
      // 单语句原子(INSERT ON CONFLICT WHERE revision=base;无 get-then-upsert TOCTOU):同 base 两并发一成一败;
      // node 写 bump 共享 cv 不触此 cursor → node 写不使 chat reorder 误 409;A/B 不同 actor 各自独立行互不冲突。
      if (type === 'chat-message') {
        const bump = await this.bumpChatOrderRevisionInTrx(trx, ownerId, canvasId, opts.base)
        if (bump.kind === 'conflict') return { kind: 'conflict', currentContentVersion: bump.current }
        // 原子:事务内逐行重分配 orderKey(actor 自己的 collection);事务失败全回滚(含 bump 回滚)。chat 不 bump 共享 cv。
        for (let i = 0; i < orderedIds.length; i++) {
          await trx
            .updateTable('persist_records')
            .set({ order_key: i, updated_at: new Date() })
            .where('owner_id', '=', ownerId)
            .where('canvas_id', '=', canvasId)
            .where('type', '=', type)
            .where('id', '=', orderedIds[i])
            .execute()
        }
        return { kind: 'ok', reordered: orderedIds.length, contentVersion: bump.newRevision }
      }
      // N8/F5:node/edge/anchor——If-Match base = 共享 canvas contentVersion;FOR UPDATE 锁 canvas meta 行
      // 序列化并发(赢家 bump 提交后输家才读到新 cv → base≠cv → conflict;旧实现无锁,两并发都读到旧 cv → 双 ok)。
      const currentCv = await this.canvasContentVersionInTrx(trx, ownerId, canvasId)
      if (opts.base !== currentCv) return { kind: 'conflict', currentContentVersion: currentCv }
      // 原子:事务内逐行重分配 orderKey(parameterized UPDATE,防 SQL 注入;事务失败全回滚)+ bump contentVersion。
      for (let i = 0; i < orderedIds.length; i++) {
        await trx
          .updateTable('persist_records')
          .set({ order_key: i, updated_at: new Date() })
          .where('owner_id', '=', ownerId)
          .where('canvas_id', '=', canvasId)
          .where('type', '=', type)
          .where('id', '=', orderedIds[i])
          .execute()
      }
      const newCv = await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
      return { kind: 'ok', reordered: orderedIds.length, contentVersion: newCv }
    })
  }

  // ── 列表(返修 #6 ORDER BY orderKey;#8 枚举)──────────────────────────────────────────

  async listByOwner(ownerId: string, type: PersistType, opts: { includeDeleted?: boolean; includeArchived?: boolean } = {}): Promise<ListResult> {
    await this.ready
    const includeDel = opts.includeDeleted ?? false
    const includeArch = opts.includeArchived ?? false
    let q = this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type)
    if (!includeDel) q = q.where('is_deleted', '=', false)
    // Phase 2 归档:默认排除 archived(回收站视图用 includeArchived=true 拉取);includeDel 时返全量(含 archived)。
    if (!includeDel && !includeArch) q = q.where('status', '!=', 'archived')
    const rows = await q.orderBy('order_key', 'asc').orderBy('created_at', 'asc').execute()
    return { records: rows.map(rowToRecord) }
  }

  async listByCanvas(ownerId: string, canvasId: string, type: PersistType, opts: { includeDeleted?: boolean; includeArchived?: boolean } = {}): Promise<ListResult> {
    await this.ready
    const includeDel = opts.includeDeleted ?? false
    const includeArch = opts.includeArchived ?? false
    let q = this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('canvas_id', '=', canvasId).where('type', '=', type)
    if (!includeDel) q = q.where('is_deleted', '=', false)
    if (!includeDel && !includeArch) q = q.where('status', '!=', 'archived')
    const rows = await q.orderBy('order_key', 'asc').orderBy('created_at', 'asc').execute()
    return { records: rows.map(rowToRecord) }
  }

  async listCanvasByProject(ownerId: string, projectId: string, opts: { includeDeleted?: boolean; includeArchived?: boolean } = {}): Promise<ListResult> {
    await this.ready
    const includeDel = opts.includeDeleted ?? false
    const includeArch = opts.includeArchived ?? false
    let q = this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)
    if (!includeDel) q = q.where('is_deleted', '=', false)
    if (!includeDel && !includeArch) q = q.where('status', '!=', 'archived')
    const rows = await q.orderBy('order_key', 'asc').orderBy('created_at', 'asc').execute()
    return { records: rows.map(rowToRecord) }
  }

  // ── 返修 #7/N2:原子 tree 软删/恢复(单事务,失败全回滚)──────────────────────────────

  async softDeleteCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).where('is_deleted', '=', false).executeTakeFirst()
      const c = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', '=', canvasId).where('is_deleted', '=', false).executeTakeFirst()
      // F2:canvases 瘦索引 owner-scoped + is_deleted=false + returning;0 行(不存在/已删/错 owner)→ undefined(调用方不碰缓存,无幽灵授权索引)。
      const idx = await trx.updateTable('canvases').set({ is_deleted: true, updated_at: new Date() }).where('id', '=', canvasId).where('owner_id', '=', ownerId).where('is_deleted', '=', false).returning('owner_id').executeTakeFirst()
      const count = Number((r?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((c?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
      return { count, canvasIdxOwner: idx?.owner_id }
    })
    // F2/P1-5:post-commit 仅当事务实际命中 durable 行(用 DB owner_id);0 行 → 不碰缓存(无幽灵)。
    if (res.canvasIdxOwner !== undefined) this.setIndexEntry('canvas', canvasId, res.canvasIdxOwner, true)
    return { count: res.count }
  }

  async softDeleteProjectTree(ownerId: string, projectId: string): Promise<{ count: number; blocked?: 'active-child' }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      // 全局锁序:projects 行 → persist_records project 行 → persist_records canvas 行 → children/索引。
      // SG-2:先锁 project 两层,再锁全部 live child canvas；锁后状态判定与后续级联写共用同一临界区。
      const ps = await this.projectStateInTrx(trx, ownerId, projectId)
      await trx.selectFrom('persist_records').select('id')
        .where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId)
        .forUpdate().executeTakeFirst()
      const lockedChildren = await trx.selectFrom('persist_records').select(['id', 'status'])
        .where('owner_id', '=', ownerId).where('type', '=', 'canvas')
        .where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false)
        .orderBy('id', 'asc').forUpdate().execute()
      if (ps.archived) {
        if (lockedChildren.some((child) => child.status !== 'archived')) {
          return { count: 0, blocked: 'active-child' as const, projIdxOwner: undefined, childIdxOwners: [] }
        }
      }
      // project meta
      const p = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', false).executeTakeFirst()
      // 其所有 canvas meta + chat-collection(canvas meta payload->>projectId = projectId)
      const cv = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false).returning(['id', 'owner_id']).execute()
      const childIds = cv.map((r) => r.id)
      // chat-collection:canvas_id 属 project 的 canvas(子查询)
      const cc = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', 'in', (qb) => qb.selectFrom('persist_records').select('id').where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)).where('is_deleted', '=', false).executeTakeFirst()
      // F2:projects 瘦索引 owner-scoped + is_deleted=false + returning;0 行(不存在/已删/错 owner)→ undefined(调用方不碰缓存,无幽灵)。
      const projIdx = await trx.updateTable('projects').set({ is_deleted: true, updated_at: new Date() }).where('id', '=', projectId).where('owner_id', '=', ownerId).where('is_deleted', '=', false).returning('owner_id').executeTakeFirst()
      // F5:child canvases 瘦索引同步(实际受影响集 owner-scoped + is_deleted=false + returning;未命中不进结果)。
      const childIdx = childIds.length > 0
        ? await trx.updateTable('canvases').set({ is_deleted: true, updated_at: new Date() }).where('id', 'in', childIds).where('owner_id', '=', ownerId).where('is_deleted', '=', false).returning(['id', 'owner_id']).execute()
        : []
      // 注:project tree cascade 软删只标 project + 其 canvas meta + chat-collection;children 保持活记录(#2)。
      const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number(cv.length > 0) + Number((cc?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
      return { count, blocked: undefined as 'active-child' | undefined, projIdxOwner: projIdx?.owner_id, childIdxOwners: childIdx.map((x) => ({ id: x.id, ownerId: x.owner_id })) }
    })
    // SG-2:blocked → 零写零缓存变更,直接透传。
    if (res.blocked) return { count: 0, blocked: res.blocked }
    // F2/F5:post-commit 仅当事务实际命中 durable 行(用 DB owner_id);child canvases 同步。0 行 → 不碰缓存(无幽灵)。
    if (res.projIdxOwner !== undefined) this.setIndexEntry('project', projectId, res.projIdxOwner, true)
    for (const c of res.childIdxOwners) this.setIndexEntry('canvas', c.id, c.ownerId, true)
    return { count: res.count }
  }

  /** 事务内:恢复 canvas 子树(canvas meta + chat-collection;原子,N2)。opts.payload 更新 canvas meta 域字段(保留 contentVersion)。opts.status(D2)若提供则覆写 status 列(combineOps create(status:'archived')→restore 带归档),否则保留既有 status。返 { count, metaRestored, canvasIdxOwner }——metaRestored=F4 输赢判定;canvasIdxOwner=F2 post-commit cache 数据源(DB owner_id,未命中→undefined 调用方不碰缓存)。 */
  private async restoreCanvasTreeInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string; status?: RecordStatus } = {}): Promise<{ count: number; metaRestored: boolean; canvasIdxOwner?: string }> {
    const r = await trx.updateTable('persist_records').set({
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      payload: opts.payload !== undefined ? sql`jsonb_set(${JSON.stringify(opts.payload)}::jsonb, '{contentVersion}', COALESCE(payload->'contentVersion', '0'::jsonb), true)` : sql`payload`,
      is_deleted: false,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).where('is_deleted', '=', true).executeTakeFirst()
    const c = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', '=', canvasId).where('is_deleted', '=', true).executeTakeFirst()
    // F2:canvases 瘦索引 owner-scoped + is_deleted=true + returning;0 行(不存在/未删/错 owner)→ undefined(调用方不碰缓存,无幽灵)。
    // F-idx:status 与 persist_records 侧(:1718)对称——opts.status 若提供则同步覆写索引 status,防 PR-B 回收站 JOIN 瘦索引读陈旧值。
    const idx = await trx.updateTable('canvases').set({ ...(opts.status !== undefined ? { status: opts.status } : {}), is_deleted: false, updated_at: new Date() }).where('id', '=', canvasId).where('owner_id', '=', ownerId).where('is_deleted', '=', true).returning('owner_id').executeTakeFirst()
    const count = Number((r?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((c?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
    return { count, metaRestored: (r?.numUpdatedRows ?? 0n) > 0n, canvasIdxOwner: idx?.owner_id }
  }

  /** 事务内:恢复 project 子树(project + 其 canvas meta + chat-collection;原子,N2)。opts.status(D2)同 restoreCanvasTreeInTrx。返 { count, metaRestored, projIdxOwner, childIdxOwners }——F4 输赢 + F2/F5 cache 数据源(全 DB owner_id,未命中不进结果→调用方不碰缓存,无幽灵)。 */
  private async restoreProjectTreeInTrx(trx: Kysely<Database>, ownerId: string, projectId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string; status?: RecordStatus } = {}, preProjectState?: { live: boolean; archived: boolean }): Promise<{ count: number; metaRestored: boolean; projIdxOwner?: string; childIdxOwners: { id: string; ownerId: string }[] }> {
    // 全部 project restore 入口(直接/ensureCreate/restoreMeta)共用此第一步：projects-first。
    // fresh insert 不走本 helper；即使未来误入,不存在行的 FOR UPDATE 也是安全 no-op。
    // P3 item 5:ensureCreate(project deleted) 路径已在上游(L878)取并锁 projectState,经 restoreMetaInTrx
    //   传入 preProjectState → 复用,不再重复 projectStateInTrx(同事务同行 FOR UPDATE 已锁,仅省一次往返,
    //   非语义优化)。undefined(直接 restoreProjectTree / restoreMeta 非删除路径)→ 自行锁,保持原契约。
    if (!preProjectState) await this.projectStateInTrx(trx, ownerId, projectId)
    // F5:先选定本 project 下 soft-deleted child canvas 集合(级联恢复前),供 canvases 瘦索引同步(与 persist_records canvas meta 恢复同集)。
    const childCv = await trx.selectFrom('persist_records').select(['id']).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', true).execute()
    const childIds = childCv.map((r) => r.id)
    const p = await trx.updateTable('persist_records').set({
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      payload: opts.payload !== undefined ? JSON.stringify(opts.payload) : sql`payload`,
      is_deleted: false,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', true).executeTakeFirst()
    const cv = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', true).executeTakeFirst()
    const cc = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', 'in', (qb) => qb.selectFrom('persist_records').select('id').where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)).where('is_deleted', '=', true).executeTakeFirst()
    // F2:projects 瘦索引 owner-scoped + is_deleted=true + returning;0 行 → undefined(调用方不碰缓存)。
    // F-idx:status 与 persist_records 侧(:1737 project meta)对称——opts.status 若提供则同步覆写索引 status。
    const projIdx = await trx.updateTable('projects').set({ ...(opts.status !== undefined ? { status: opts.status } : {}), is_deleted: false, updated_at: new Date() }).where('id', '=', projectId).where('owner_id', '=', ownerId).where('is_deleted', '=', true).returning('owner_id').executeTakeFirst()
    // F5:child canvases 瘦索引同步(实际受影响集 owner-scoped + is_deleted=true + returning;未命中不进结果)。
    // F-idx:此处**不**加 opts.status——上面 persist_records 子画布 `cv`(:1743)本身不设 status(子画布恢复时保留
    //   既有 status,非 project-meta 的 opts.status);索引若单方面写 opts.status 会与 persist_records 不一致(恰是 F-idx
    //   要消灭的陈旧值)。故子画布索引亦保留既有 status,与 `cv` 对称。
    const childIdx = childIds.length > 0
      ? await trx.updateTable('canvases').set({ is_deleted: false, updated_at: new Date() }).where('id', 'in', childIds).where('owner_id', '=', ownerId).where('is_deleted', '=', true).returning(['id', 'owner_id']).execute()
      : []
    void opts.idempotencyKey; void opts.fingerprint
    const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((cv?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((cc?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
    return { count, metaRestored: (p?.numUpdatedRows ?? 0n) > 0n, projIdxOwner: projIdx?.owner_id, childIdxOwners: childIdx.map((x) => ({ id: x.id, ownerId: x.owner_id })) }
  }

  async restoreCanvasTree(ownerId: string, canvasId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      // P3 item 1 SG-1 守卫:opts.payload.projectId 指向 archived project → throw ArchivedParentWriteError,
      // 与 createCanvasWithCollection / ensureCreate 同语义(事务内 projectStateInTrx 锁 projects 行 + 读
      // status,防 TOCTOU)。该 primitive 当前无生产调用方(internal restoreMetaInTrx 已在上游
      // ensureCreate 的 SG-1 守卫覆盖),守卫防未来误用。无 payload / payload 无 projectId → no-op(同 create
      // 路径 `if (pid)` 语义;既有 direct 调用面 tests 传空 opts,不受影响)。
      const pid = asCanvasMeta(opts.payload)?.projectId
      if (pid) {
        const ps = await this.projectStateInTrx(trx, ownerId, pid)
        if (ps.archived) throw new ArchivedParentWriteError(pid)
      }
      return this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, opts)
    })
    // F2/P1-5:post-commit 定点 cache mutation 仅当事务实际命中 durable 行(用 DB owner_id,不信用入参);0 行(no-op/错 owner/不存在)→ 不碰缓存(无幽灵)。
    if (res.canvasIdxOwner !== undefined) this.setIndexEntry('canvas', canvasId, res.canvasIdxOwner, false)
    return { count: res.count }
  }

  async restoreProjectTree(ownerId: string, projectId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => this.restoreProjectTreeInTrx(trx, ownerId, projectId, opts))
    // F2/F5:post-commit 仅当事务实际命中 durable 行(用 DB owner_id);child canvases 同步(与 persist_records 恢复同集)。0 行 → 不碰缓存(无幽灵)。
    if (res.projIdxOwner !== undefined) this.setIndexEntry('project', projectId, res.projIdxOwner, false)
    for (const c of res.childIdxOwners) this.setIndexEntry('canvas', c.id, c.ownerId, false)
    return { count: res.count }
  }

  // ── Phase 2 归档(回收站):archive/unarchive tree 事务 ──────────────────────────────
  // 镜像 softDelete*Tree / restore*TreeInTrx 的原子/级联/幂等模式,但用 status 列(D1)作归档标记(非 is_deleted)。
  // archivedByCascade(D3)在 canvas meta payload 内布尔:archiveProjectTree 级联写 true,直接 archiveCanvasTree 写 false;
  // unarchiveProjectTree 只恢复 archivedByCascade=true 的子画布(用户先前单独归档的不被强制恢复)。
  // 彻底删除仍走 softDelete*Tree(is_deleted 终态);archive=软隐藏(可读/可恢复/子记录写返 409 archived,CR-6 write-guard)。
  // 索引缓存(projectIndex/canvasIndex)只存 ownerId+isDeleted,归档不改 isDeleted → 缓存无需 mutation(返 durable owner 仅观测)。

  /** 归档 canvas(直接):canvas meta status→archived + archivedByCascade→false;canvases 索引同步。幂等(已归档→0 行 no-op)。 */
  async archiveCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number; retryableConflict?: true }> {
    await this.ready
    return this.setCanvasArchiveStatusWithParentRetry(ownerId, canvasId, 'active', 'archived')
  }

  /** 恢复 canvas(直接):canvas meta status→active + archivedByCascade→false;canvases 索引同步。幂等(已 active→0 行)。 */
  async unarchiveCanvasTree(ownerId: string, canvasId: string): Promise<{ count: number; retryableConflict?: true }> {
    await this.ready
    return this.setCanvasArchiveStatusWithParentRetry(ownerId, canvasId, 'archived', 'active')
  }

  /** 归档 project 子树(级联):project meta status→archived + 其全部 active 子画布 status→archived + archivedByCascade→true;projects/canvases 索引同步。幂等。 */
  async archiveProjectTree(ownerId: string, projectId: string): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      // 全局锁序第一步:projects 行。随后 project meta → canvas meta → 瘦索引/children。
      await this.projectStateInTrx(trx, ownerId, projectId)
      await trx.selectFrom('persist_records').select('id')
        .where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId)
        .forUpdate().executeTakeFirst()
      const p = await trx.updateTable('persist_records').set({ status: 'archived', revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', false).where('status', '=', 'active').executeTakeFirst()
      // 其全部 active 子画布 → archived + archivedByCascade=true(D3:级联归档标记,unarchiveProjectTree 据此恢复)
      const cv = await trx.updateTable('persist_records').set({ status: 'archived', payload: sql`jsonb_set(payload, '{archivedByCascade}', 'true'::jsonb)`, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false).where('status', '=', 'active').returning('id').execute()
      const childIds = cv.map((r) => r.id)
      await trx.updateTable('projects').set({ status: 'archived', updated_at: new Date() }).where('id', '=', projectId).where('owner_id', '=', ownerId).where('is_deleted', '=', false).where('status', '=', 'active').execute()
      if (childIds.length > 0) await trx.updateTable('canvases').set({ status: 'archived', updated_at: new Date() }).where('id', 'in', childIds).where('owner_id', '=', ownerId).where('is_deleted', '=', false).where('status', '=', 'active').execute()
      // F-count:count 为布尔型语义——>0=有变更,非精确变更行数(PG 侧=(proj?1:0)+(anyCanvas?1:0)≤2;mem 侧=targets.length;双后端定义不同,勿按精确值做算术)。唯一消费者 route 日志 note(count>0 一致)。
      const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number(cv.length > 0)
      return { count }
    })
    return { count: res.count }
  }

  /** 恢复 project 子树(级联):project meta status→active + 仅恢复 archivedByCascade=true 的子画布(D3:单独归档的不被强制恢复);清 archivedByCascade→false;索引同步。幂等。 */
  async unarchiveProjectTree(ownerId: string, projectId: string): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      // 全局锁序第一步:projects 行。随后 project meta → 实际命中的 cascade canvas → 索引。
      await this.projectStateInTrx(trx, ownerId, projectId)
      await trx.selectFrom('persist_records').select('id')
        .where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId)
        .forUpdate().executeTakeFirst()
      const p = await trx.updateTable('persist_records').set({ status: 'active', revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', false).where('status', '=', 'archived').executeTakeFirst()
      const cv = await trx.updateTable('persist_records').set({ status: 'active', payload: sql`jsonb_set(payload, '{archivedByCascade}', 'false'::jsonb)`, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false).where('status', '=', 'archived').where(sql`payload->>'archivedByCascade'`, '=', 'true').returning('id').execute()
      const childIds = cv.map((r) => r.id)
      await trx.updateTable('projects').set({ status: 'active', updated_at: new Date() }).where('id', '=', projectId).where('owner_id', '=', ownerId).where('is_deleted', '=', false).where('status', '=', 'archived').execute()
      if (childIds.length > 0) await trx.updateTable('canvases').set({ status: 'active', updated_at: new Date() }).where('id', 'in', childIds).where('owner_id', '=', ownerId).where('is_deleted', '=', false).where('status', '=', 'archived').execute()
      // F-count:count 为布尔型语义——>0=有变更,非精确变更行数(PG 侧=(proj?1:0)+(anyCanvas?1:0)≤2;mem 侧=targets.length;双后端定义不同,勿按精确值做算术)。唯一消费者 route 日志 note(count>0 一致)。
      const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number(cv.length > 0)
      return { count }
    })
    return { count: res.count }
  }

  // ── G2.2:persist 域 owner rekey(fingerprint→SSO username)──────────────────────────────────
  // 覆盖 dp4 owner inventory 的 persist 域:persist_records.owner_id(含 chat-message,§3.1)+ projects/canvases
  // .owner_id(瘦全局索引表)+ idempotency_index.owner_id + envelope_owner(#10 幂等表)+ chat_order_revisions
  // .actor_id(DP-6R P1-2)。两阶段(防 resolver 中途抛留半迁移态):① SELECT DISTINCT legacy owner + resolve;
  // ② 事务内 UPDATE 全表(无 resolver 调用,不抛)+ warm() 刷新内存全局索引缓存。幂等:已 username 形态不再
  // 匹配 16-hex 正则,重跑只处理剩余 legacy。unmapped>0 → strict gate 仍 no-go(明确拒迁)。

  /**
   * G2.1 R2-1 三域 gate 的 persist 域 detector(PG 实扫):统计 persist 域三表(persist_records.owner_id +
   * idempotency_index.owner_id/envelope_owner + chat_order_revisions.actor_id + projects/canvases.owner_id)中为
   * legacy 指纹形态(16-hex)的 DISTINCT owner 数。strict 启动 gate 调用:>0 → 拒启动(persist 域迁移未完成)。
   */
  async countLegacyFormOwners(): Promise<number> {
    await this.ready
    // PG 独立表(idempotency/chat_order_revisions/projects/canvases)非内存 byOwner 派生,须显式扫描;
    // 与 InMemory(byOwner 外层 key = persist_records.owner_id)对齐并扩展覆盖 PG 独立表。
    const rows = await sql<{ owner: string | null }>`
    SELECT DISTINCT owner_id AS owner FROM persist_records WHERE owner_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT owner_id AS owner FROM idempotency_index WHERE owner_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT envelope_owner AS owner FROM idempotency_index WHERE envelope_owner ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT actor_id AS owner FROM chat_order_revisions WHERE actor_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT owner_id AS owner FROM projects WHERE owner_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT owner_id AS owner FROM canvases WHERE owner_id ~ '^[0-9a-f]{16}$'
  `.execute(this.db)
    const legacy = new Set<string>()
    for (const r of rows.rows) if (r.owner) legacy.add(r.owner)
    return legacy.size
  }

  /**
   * G2.2 persist 域 owner rekey:把 legacy 指纹 ownerId 重键为 SSO username(resolver 返回值)。
   * 两阶段:Phase 1 收集 DISTINCT legacy owner + resolve(resolver 可能抛 → 未 mutation);Phase 2 事务内
   * UPDATE persist_records + idempotency_index(owner_id + envelope_owner)+ chat_order_revisions.actor_id +
   * projects + canvases,再 warm() 刷新内存全局索引缓存。返回 {migrated, unmapped}(owner 维度计数)。
   */
  async migrateLegacyOwnersToUsernameForm(
    resolveFingerprintToUsername: (fingerprint: string) => string | undefined,
  ): Promise<{ migrated: number; unmapped: number }> {
    await this.ready
    // P1-2:dp4 §3.1 fail-closed 预审——零 mutation 前断言所有 legacy chat-message.owner_id === canvas owner
    //   (migration 003 "零搬迁"论证前提)。异常行(owner_id ≠ canvas owner / 孤儿 canvas)→ no-go 抛错,不静默
    //   carry over(防换键后数据孤儿 + 隐私边界破损)。memory(backend.ts)parity。
    const auditRows = await sql<{ id: string; ownerId: string; canvasId: string | null; canvasOwner: string | null }>`
      SELECT cm.id, cm.owner_id AS "ownerId", cm.canvas_id AS "canvasId", c.owner_id AS "canvasOwner"
      FROM persist_records cm
      LEFT JOIN canvases c ON c.id = cm.canvas_id
      WHERE cm.type = 'chat-message' AND cm.owner_id ~ '^[0-9a-f]{16}$'
    `.execute(this.db)
    for (const r of auditRows.rows) {
      if (r.canvasOwner === null) {
        throw new Error(
          `G2.2 dp4 §3.1 no-go: legacy chat-message ${r.id} (owner ${r.ownerId}) references canvas ${r.canvasId} which has no global canvas owner (orphan/canvas deleted); refusing to rekey — resolve or quarantine before migration.`,
        )
      }
      if (r.ownerId !== r.canvasOwner) {
        throw new Error(
          `G2.2 dp4 §3.1 no-go: legacy chat-message ${r.id} owner_id ${r.ownerId} !== canvas ${r.canvasId} owner ${r.canvasOwner} (member chat under non-canvas-owner fingerprint is anomalous in legacy form); refusing to rekey — migration 003 "no-move" invariant violated.`,
        )
      }
    }
    // Phase 1:收集 DISTINCT legacy owner(跨 persist 域全表)+ resolve(resolver 可能抛 → 此时未 mutation)。
    const rows = await sql<{ owner: string | null }>`
    SELECT DISTINCT owner_id AS owner FROM persist_records WHERE owner_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT owner_id AS owner FROM idempotency_index WHERE owner_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT envelope_owner AS owner FROM idempotency_index WHERE envelope_owner ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT actor_id AS owner FROM chat_order_revisions WHERE actor_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT owner_id AS owner FROM projects WHERE owner_id ~ '^[0-9a-f]{16}$'
    UNION SELECT DISTINCT owner_id AS owner FROM canvases WHERE owner_id ~ '^[0-9a-f]{16}$'
  `.execute(this.db)
    const legacySet = new Set<string>()
    for (const r of rows.rows) if (r.owner) legacySet.add(r.owner)
    const mapping = new Map<string, string>()
    let unmapped = 0
    for (const fp of legacySet) {
      const u = resolveFingerprintToUsername(fp)
      if (u && u.length > 0) mapping.set(fp, u)
      else unmapped += 1
    }
    if (mapping.size === 0) return { migrated: 0, unmapped }
    // Phase 2:事务内 UPDATE 全表(无 resolver 调用,不抛;幂等:已 username 形态不再匹配 16-hex)。
    await this.db.transaction().execute(async (trx) => {
      for (const [fp, u] of mapping) {
        await trx.updateTable('persist_records').set({ owner_id: u }).where('owner_id', '=', fp).execute()
        await trx.updateTable('idempotency_index').set({ owner_id: u }).where('owner_id', '=', fp).execute()
        await trx.updateTable('idempotency_index').set({ envelope_owner: u }).where('envelope_owner', '=', fp).execute()
        await trx.updateTable('chat_order_revisions').set({ actor_id: u }).where('actor_id', '=', fp).execute()
        await trx.updateTable('projects').set({ owner_id: u }).where('owner_id', '=', fp).execute()
        await trx.updateTable('canvases').set({ owner_id: u }).where('owner_id', '=', fp).execute()
      }
    })
    // post-migrate:rekey 后 projectIndex/canvasIndex 的 owner 指向变了,从 DB 重新 warm(防 getProjectOwner
    // 返旧指纹 → strict 下访问错 owner)。warm() 全量重建,幂等。
    await this.warm()
    return { migrated: mapping.size, unmapped }
  }

  /**
   * R2-P1-2 回归 barrier 的 test-only 旋钮(production 永不设置;实例属性,随实例销毁)。
   * - afterMessages:在 messages SELECT 完成、orderRevision SELECT 开始之间 await——测试在此窗口内提交
   *   reorder,确定性复现 READ COMMITTED 下的 torn pair(旧 messages + 新 rev)。无 hook 时直通(production 自洽)。
   * - isolationLevel:测试强制隔离级别(undefined → production 默认 'repeatable read')。red-detector 用
   *   'read committed' 证明 barrier 非空转(READ COMMITTED 下必出 torn pair)。
   * 测试务必在 afterEach 清空两字段,避免泄漏到同实例其他用例(共享 pgBackend 单例)。
   */
  __listChatTornPairTestHooks: {
    afterMessages?: () => Promise<void>
    isolationLevel?: 'repeatable read' | 'read committed'
  } = {}

  /** Test-only:清空全部 records + idempotency index + 全局索引缓存 + 009 field_clocks/canvas_seq/child_tombstones。PG:deleteFrom(异步)。 */
  __reset(): Promise<void> {
    this.projectIndex.clear()
    this.canvasIndex.clear()
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('idempotency_index').execute()
      await trx.deleteFrom('persist_records').execute()
      await trx.deleteFrom('projects').execute()
      await trx.deleteFrom('canvases').execute()
      await trx.deleteFrom('chat_order_revisions').execute()
      // A2-S2(009 migration):field_clocks/canvas_seq/child_tombstones 须一并清,否则 field_clocks 跨测试累积
      // → 同 record_key (owner,type,id) 的 title.clock 残留,后续测试 "expected 1 got 2"。三表无 FK,顺序无关。
      await trx.deleteFrom('field_clocks').execute()
      await trx.deleteFrom('canvas_seq').execute()
      await trx.deleteFrom('child_tombstones').execute()
    })
  }

  /** Test-only:读 project 全局索引缓存条目(F2 幽灵索引/F5 级联同步断言用;生产不用)。 */
  __projectCacheEntry(id: string): { ownerId: string; isDeleted: boolean } | undefined {
    return this.projectIndex.get(id)
  }

  /** Test-only:读 canvas 全局索引缓存条目(F2 幽灵索引/F5 级联同步断言用;生产不用)。 */
  __canvasCacheEntry(id: string): { ownerId: string; isDeleted: boolean } | undefined {
    return this.canvasIndex.get(id)
  }

  /** Test-only:DROP 全部表(含 kysely_migration 追踪表)模拟 fresh DB,验证 ready 的 migrate-before-warm 编排(P1-4)。生产不用。 */
  __dropAllTables(): Promise<void> {
    this.projectIndex.clear()
    this.canvasIndex.clear()
    return this.db.transaction().execute(async (trx) => {
      // T1.4:permission 两表(project_members/share_links)FK→projects(id);须先 drop,否则 DROP projects 被 FK 引用阻。
      // permission 表不在本 backend Database 类型内,但 schema.dropTable 按表名操作,无需类型登记(同 kysely_migration)。
      // R3:share_link_compensations(005)同样 FK→projects,须先 drop(否则 DROP projects 被 compensations 引用阻)。
      await trx.schema.dropTable('share_link_compensations').ifExists().execute()
      await trx.schema.dropTable('share_links').ifExists().execute()
      await trx.schema.dropTable('project_members').ifExists().execute()
      await trx.schema.dropTable('idempotency_index').ifExists().execute()
      await trx.schema.dropTable('canvases').ifExists().execute()
      await trx.schema.dropTable('projects').ifExists().execute()
      await trx.schema.dropTable('persist_records').ifExists().execute()
      // R2-P2-1:DP-6R P1-2 新表(migration 004)曾漏入 drop → __dropAllTables 实际不 fresh,to_regclass 仍在,
      // 掩盖 004 CREATE/registry 错误。补入;无 FK(PK actor_id,canvas_id)独立 drop。
      // A2-S2(009 migration):field_clocks/canvas_seq/child_tombstones 同理须补入 drop,否则 __reset 漏三表
      // + fresh-DB 掩盖 009 schema 错误。三表无 FK(PK record_key/canvas_id),独立 drop 顺序无关。
      // **⚠ 未来 010+ 新表同样须加此处,否则 fresh-DB 测试继续掩盖 schema/registry 错误。**
      await trx.schema.dropTable('chat_order_revisions').ifExists().execute()
      await trx.schema.dropTable('field_clocks').ifExists().execute()
      await trx.schema.dropTable('canvas_seq').ifExists().execute()
      await trx.schema.dropTable('child_tombstones').ifExists().execute()
      await trx.schema.dropTable('kysely_migration').ifExists().execute()
      await trx.schema.dropTable('kysely_migration_lock').ifExists().execute()
    })
  }

  /** Test-only:表是否存在(to_regclass IS NOT NULL);__dropAllTables fresh-DB 断言用(R2-P2-1:防新表漏入 drop 掩盖错误)。生产不用。 */
  async __tableExists(name: string): Promise<boolean> {
    await this.ready
    const r = await sql<{ exists: string | null }>`SELECT to_regclass(${name}) AS exists`.execute(this.db)
    return r.rows[0]?.exists != null
  }
}

// re-export(供 app 注入 + routes 类型消费)
export type { Envelope, PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'
export { fingerprintOfBody } from './backend'
