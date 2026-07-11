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
  EnsureChildResult,
  EnsureCreateResult,
  GetChildResult,
  GetResult,
  ListResult,
  PersistBackend,
  PersistRecord,
  ReorderResult,
  UpsertChildResult,
  UpsertResult,
} from './backend'
import type { PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'

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
  created_at: Generated<Date>
  updated_at: Generated<Date>
  // read=object(pg 解析 jsonb 为对象);insert/update=string(JSON.stringify 写入,PG text→jsonb 隐式转换)。JSONColumnType 须 object select,unknown 会破坏 Insertable 提取。
  payload: JSONColumnType<object>
}
interface GlobalIndexTable {
  id: string
  owner_id: string
  is_deleted: Generated<boolean>
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
interface Database {
  persist_records: PersistRecordsTable
  projects: GlobalIndexTable
  canvases: GlobalIndexTable
  idempotency_index: IdempotencyTable
}

const clone = <T>(value: T): T => structuredClone(value)

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
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  payload: clone(row.payload),
})

/** canvas meta payload shape(backend 维护 contentVersion;其余域字段 route 管)。 */
type CanvasMetaPayload = { projectId?: string; title?: string; sourceTemplateId?: string; contentVersion?: Revision }
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
  /** F1:project 存在且 !isDeleted(缓存读,反映已提交状态;事务内 F1 检查用 projectLiveInTrx 防 TOCTOU)。 */
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

  /** 事务内 F1:SELECT...FOR UPDATE project 行(防跨事务 TOCTOU;返 live 状态)。 */
  private async projectLiveInTrx(trx: Kysely<Database>, ownerId: string, projectId: string): Promise<boolean> {
    const r = await trx
      .selectFrom('projects')
      .select(['owner_id', 'is_deleted'])
      .where('id', '=', projectId)
      .forUpdate()
      .executeTakeFirst()
    return !!r && r.owner_id === ownerId && !r.is_deleted
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
          if (type === 'canvas') {
            const pid = asCanvasMeta(payload)?.projectId
            if (pid && !(await this.projectLiveInTrx(trx, ownerId, pid))) return { kind: 'parent-not-live' }
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
          const existing = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
          const scope: PersistScope = opts.scope ?? 'document'
          const canvasId = opts.canvasId ?? null
          if (existing && !existing.is_deleted) {
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            return { kind: 'existing', record: this.withIdem(rowToRecord(existing), opts) }
          }
          if (existing && existing.is_deleted) {
            // N2:backend 原子 create-or-restore-tree。F4:rowCount 定输赢(并发赢家已恢复→existing)。
            const { record: restoredRec, restored } = await this.restoreMetaInTrx(trx, ownerId, type, id, payload, opts)
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            return { kind: restored ? 'restored' : 'existing', record: this.withIdem(restoredRec, opts) }
          }
          // 不存在 → created(revision 0;orderKey 0 for meta;createdAt/updatedAt = now)。
          // Greptile P1(全局索引竞争):project/canvas 全局唯一索引先建(doNothing+returning);若 returning 空(跨事务
          // race 被吞)→ re-SELECT 归属 → 跨 owner → exists-other-owner(此时 persist_records 尚未插入,trx 提交无 partial)。
          if (type === 'project') {
            const idx = await trx.insertInto('projects').values({ id, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst()
            if (!idx) {
              const g = await trx.selectFrom('projects').select('owner_id').where('id', '=', id).executeTakeFirst()
              if (g && g.owner_id !== ownerId) {
                const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', g.owner_id).where('type', '=', 'project').where('id', '=', id).executeTakeFirst()
                if (r) return { kind: 'exists-other-owner', record: rowToRecord(r) }
              }
            }
          } else if (type === 'canvas') {
            const idx = await trx.insertInto('canvases').values({ id, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst()
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
    opts: { canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<{ record: PersistRecord; restored: boolean }> {
    let restored: boolean
    if (type === 'project') {
      const { metaRestored } = await this.restoreProjectTreeInTrx(trx, ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
      restored = metaRestored
    } else if (type === 'canvas') {
      const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
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
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
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
          const pid = asCanvasMeta(canvasPayload)?.projectId
          if (pid && !(await this.projectLiveInTrx(trx, ownerId, pid))) return { kind: 'parent-not-live' }
          // 幂等 replay(owner+method+resourceKind+key + fingerprint)。
          if (opts.idempotencyKey) {
            const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
            if (entry) {
              const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
              if (r) {
                if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
                // N2/F1:幂等命中 deleted → 真恢复(事务内:复验 parent live + restore canvas+collection + ensureCollectionLive)。
                if (r.is_deleted) {
                  const pid2 = asCanvasMeta(canvasPayload)?.projectId
                  if (pid2 && !(await this.projectLiveInTrx(trx, ownerId, pid2))) return { kind: 'parent-not-live' }
                  // F1:replay 命中 deleted → 真恢复。idem 条目已存在(:602 读到),不重插(否则误判 race loser→回滚恢复)。
                  // F4:按 restoreCanvasTreeInTrx 的 rowCount 定输赢——0 行(并发赢家已恢复)→ existing。
                  const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
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
            const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
            await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
            const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
            if (!rec) throw new Error('createCanvasWithCollection: post-restore canvas missing')
            return { kind: metaRestored ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
          }
          // 不存在 → 原子 created(canvas meta + chat-collection + canvases 全局索引 同一事务;失败全回滚,无 partial,无 orphan)。
          // Greptile P1(全局索引竞争):canvases 全局索引先建(doNothing+returning);若 returning 空(跨事务 race 被吞)
          // → re-SELECT 归属 → 跨 owner → exists-other-owner(此时 canvas meta/collection 尚未插入,trx 提交无 partial)。
          const idx = await trx.insertInto('canvases').values({ id: canvasId, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst()
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
            .values({ id: canvasId, owner_id: ownerId, canvas_id: null, type: 'canvas', scope: 'document', revision: 0, order_key: 0, is_deleted: false, payload: JSON.stringify(canvasPayload) })
            .onConflict((oc) => oc.columns(['owner_id', 'type', 'id']).doNothing())
            .returningAll()
            .executeTakeFirst()
          if (!canvasInsert) {
            const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
            if (r) {
              await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
              if (r.is_deleted) {
                // F4:rowCount 定输赢(并发赢家已恢复→existing)。
                const { metaRestored } = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
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
                  const upd = await trx.updateTable('persist_records').set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: canvasId }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).where('is_deleted', '=', true).executeTakeFirst()
                  if ((upd?.numUpdatedRows ?? 0n) > 0n) await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
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
            const upd = await trx.updateTable('persist_records').set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: canvasId }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).where('is_deleted', '=', true).executeTakeFirst()
            await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
            if ((upd?.numUpdatedRows ?? 0n) > 0n) await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
            const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
            if (!rec) throw new Error('ensureCreateChild: post-restore missing')
            return { kind: (upd?.numUpdatedRows ?? 0n) > 0n ? 'restored' : 'existing', record: this.withIdem(rowToRecord(rec), opts) }
          }
          // 不存在 → created(orderKey 分配,#6)。
          const orderKey = await this.nextOrderKeyInTrx(trx, ownerId, canvasId, type)
          await trx.insertInto('persist_records').values({ id, owner_id: ownerId, canvas_id: canvasId, type, scope: 'document', revision: 0, order_key: orderKey, is_deleted: false, payload: JSON.stringify(payload) }).execute()
          await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
          await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
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
          // F1:canvas PUT move 目标 project 须 live(防 move 到软删 project)。idem-replay 之后、existing 之前。
          if (type === 'canvas') {
            const pid = asCanvasMeta(payload)?.projectId
            if (pid && !(await this.projectLiveInTrx(trx, ownerId, pid))) return { kind: 'parent-not-live' }
          }
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
    opts: { base?: Revision; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<UpsertChildResult> {
    await this.ready
    return this.withIdempotencyGuard(
      async () => {
        return this.db.transaction().execute(async (trx) => {
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
            await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
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
          await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
          return { kind: 'updated', record: this.withIdem(rowToRecord(result), opts) }
        })
      },
      (winnerRecord, mismatch) =>
        mismatch ? { kind: 'reuse-conflict' } : { kind: 'updated', record: this.withIdem(winnerRecord, opts) },
    )
  }

  async hardDeleteChild(ownerId: string, canvasId: string, type: PersistType, id: string): Promise<{ deleted: boolean }> {
    await this.ready
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
      if (!r || r.canvas_id !== canvasId) return { deleted: false }
      await trx.deleteFrom('persist_records').where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).execute()
      await trx.deleteFrom('idempotency_index').where('envelope_owner', '=', ownerId).where('envelope_type', '=', type).where('envelope_id', '=', id).execute()
      await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
      return { deleted: true }
    })
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
      // N8/F5:If-Match(contentVersion base)必填——stale → 409(两并发一成一 409)。P1-1:FOR UPDATE 锁 canvas meta 行
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

  async listByOwner(ownerId: string, type: PersistType, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    await this.ready
    const include = opts.includeDeleted ?? false
    let q = this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type)
    if (!include) q = q.where('is_deleted', '=', false)
    const rows = await q.orderBy('order_key', 'asc').orderBy('created_at', 'asc').execute()
    return { records: rows.map(rowToRecord) }
  }

  async listByCanvas(ownerId: string, canvasId: string, type: PersistType, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    await this.ready
    const include = opts.includeDeleted ?? false
    let q = this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('canvas_id', '=', canvasId).where('type', '=', type)
    if (!include) q = q.where('is_deleted', '=', false)
    const rows = await q.orderBy('order_key', 'asc').orderBy('created_at', 'asc').execute()
    return { records: rows.map(rowToRecord) }
  }

  async listCanvasByProject(ownerId: string, projectId: string, opts: { includeDeleted?: boolean } = {}): Promise<ListResult> {
    await this.ready
    const include = opts.includeDeleted ?? false
    let q = this.db.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)
    if (!include) q = q.where('is_deleted', '=', false)
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

  async softDeleteProjectTree(ownerId: string, projectId: string): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      // F5:先选定本 project 下 live child canvas 集合(级联软删前),供 canvases 瘦索引同步(与 persist_records canvas meta 软删同集)。
      const childCv = await trx.selectFrom('persist_records').select(['id']).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false).execute()
      const childIds = childCv.map((r) => r.id)
      // project meta
      const p = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', false).executeTakeFirst()
      // 其所有 canvas meta + chat-collection(canvas meta payload->>projectId = projectId)
      const cv = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false).executeTakeFirst()
      // chat-collection:canvas_id 属 project 的 canvas(子查询)
      const cc = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', 'in', (qb) => qb.selectFrom('persist_records').select('id').where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)).where('is_deleted', '=', false).executeTakeFirst()
      // F2:projects 瘦索引 owner-scoped + is_deleted=false + returning;0 行(不存在/已删/错 owner)→ undefined(调用方不碰缓存,无幽灵)。
      const projIdx = await trx.updateTable('projects').set({ is_deleted: true, updated_at: new Date() }).where('id', '=', projectId).where('owner_id', '=', ownerId).where('is_deleted', '=', false).returning('owner_id').executeTakeFirst()
      // F5:child canvases 瘦索引同步(实际受影响集 owner-scoped + is_deleted=false + returning;未命中不进结果)。
      const childIdx = childIds.length > 0
        ? await trx.updateTable('canvases').set({ is_deleted: true, updated_at: new Date() }).where('id', 'in', childIds).where('owner_id', '=', ownerId).where('is_deleted', '=', false).returning(['id', 'owner_id']).execute()
        : []
      // 注:project tree cascade 软删只标 project + 其 canvas meta + chat-collection;children 保持活记录(#2)。
      const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((cv?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((cc?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
      return { count, projIdxOwner: projIdx?.owner_id, childIdxOwners: childIdx.map((x) => ({ id: x.id, ownerId: x.owner_id })) }
    })
    // F2/F5:post-commit 仅当事务实际命中 durable 行(用 DB owner_id);child canvases 同步。0 行 → 不碰缓存(无幽灵)。
    if (res.projIdxOwner !== undefined) this.setIndexEntry('project', projectId, res.projIdxOwner, true)
    for (const c of res.childIdxOwners) this.setIndexEntry('canvas', c.id, c.ownerId, true)
    return { count: res.count }
  }

  /** 事务内:恢复 canvas 子树(canvas meta + chat-collection;原子,N2)。opts.payload 更新 canvas meta 域字段(保留 contentVersion)。返 { count, metaRestored, canvasIdxOwner }——metaRestored=F4 输赢判定;canvasIdxOwner=F2 post-commit cache 数据源(DB owner_id,未命中→undefined 调用方不碰缓存)。 */
  private async restoreCanvasTreeInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number; metaRestored: boolean; canvasIdxOwner?: string }> {
    const r = await trx.updateTable('persist_records').set({
      payload: opts.payload !== undefined ? sql`jsonb_set(${JSON.stringify(opts.payload)}::jsonb, '{contentVersion}', COALESCE(payload->'contentVersion', '0'::jsonb), true)` : sql`payload`,
      is_deleted: false,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).where('is_deleted', '=', true).executeTakeFirst()
    const c = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', '=', canvasId).where('is_deleted', '=', true).executeTakeFirst()
    // F2:canvases 瘦索引 owner-scoped + is_deleted=true + returning;0 行(不存在/未删/错 owner)→ undefined(调用方不碰缓存,无幽灵)。
    const idx = await trx.updateTable('canvases').set({ is_deleted: false, updated_at: new Date() }).where('id', '=', canvasId).where('owner_id', '=', ownerId).where('is_deleted', '=', true).returning('owner_id').executeTakeFirst()
    const count = Number((r?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((c?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
    return { count, metaRestored: (r?.numUpdatedRows ?? 0n) > 0n, canvasIdxOwner: idx?.owner_id }
  }

  /** 事务内:恢复 project 子树(project + 其 canvas meta + chat-collection;原子,N2)。返 { count, metaRestored, projIdxOwner, childIdxOwners }——F4 输赢 + F2/F5 cache 数据源(全 DB owner_id,未命中不进结果→调用方不碰缓存,无幽灵)。 */
  private async restoreProjectTreeInTrx(trx: Kysely<Database>, ownerId: string, projectId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number; metaRestored: boolean; projIdxOwner?: string; childIdxOwners: { id: string; ownerId: string }[] }> {
    // F5:先选定本 project 下 soft-deleted child canvas 集合(级联恢复前),供 canvases 瘦索引同步(与 persist_records canvas meta 恢复同集)。
    const childCv = await trx.selectFrom('persist_records').select(['id']).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', true).execute()
    const childIds = childCv.map((r) => r.id)
    const p = await trx.updateTable('persist_records').set({
      payload: opts.payload !== undefined ? JSON.stringify(opts.payload) : sql`payload`,
      is_deleted: false,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', true).executeTakeFirst()
    const cv = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', true).executeTakeFirst()
    const cc = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', 'in', (qb) => qb.selectFrom('persist_records').select('id').where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)).where('is_deleted', '=', true).executeTakeFirst()
    // F2:projects 瘦索引 owner-scoped + is_deleted=true + returning;0 行 → undefined(调用方不碰缓存)。
    const projIdx = await trx.updateTable('projects').set({ is_deleted: false, updated_at: new Date() }).where('id', '=', projectId).where('owner_id', '=', ownerId).where('is_deleted', '=', true).returning('owner_id').executeTakeFirst()
    // F5:child canvases 瘦索引同步(实际受影响集 owner-scoped + is_deleted=true + returning;未命中不进结果)。
    const childIdx = childIds.length > 0
      ? await trx.updateTable('canvases').set({ is_deleted: false, updated_at: new Date() }).where('id', 'in', childIds).where('owner_id', '=', ownerId).where('is_deleted', '=', true).returning(['id', 'owner_id']).execute()
      : []
    void opts.idempotencyKey; void opts.fingerprint
    const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((cv?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((cc?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
    return { count, metaRestored: (p?.numUpdatedRows ?? 0n) > 0n, projIdxOwner: projIdx?.owner_id, childIdxOwners: childIdx.map((x) => ({ id: x.id, ownerId: x.owner_id })) }
  }

  async restoreCanvasTree(ownerId: string, canvasId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, opts))
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

  /** Test-only:清空全部 records + idempotency index + 全局索引缓存。PG:TRUNCATE(异步)。 */
  __reset(): Promise<void> {
    this.projectIndex.clear()
    this.canvasIndex.clear()
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('idempotency_index').execute()
      await trx.deleteFrom('persist_records').execute()
      await trx.deleteFrom('projects').execute()
      await trx.deleteFrom('canvases').execute()
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
      await trx.schema.dropTable('share_links').ifExists().execute()
      await trx.schema.dropTable('project_members').ifExists().execute()
      await trx.schema.dropTable('idempotency_index').ifExists().execute()
      await trx.schema.dropTable('canvases').ifExists().execute()
      await trx.schema.dropTable('projects').ifExists().execute()
      await trx.schema.dropTable('persist_records').ifExists().execute()
      await trx.schema.dropTable('kysely_migration').ifExists().execute()
      await trx.schema.dropTable('kysely_migration_lock').ifExists().execute()
    })
  }
}

// re-export(供 app 注入 + routes 类型消费)
export type { Envelope, PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'
export { fingerprintOfBody } from './backend'
