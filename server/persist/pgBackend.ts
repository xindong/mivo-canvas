// server/persist/pgBackend.ts
// T1.3 PgPersistBackend:PG 持久化后端(Kysely + pg),drop-in 实现 PersistBackend 接口。
// 权威:docs/decisions/api-surface.md(契约冻结)+ 附录 A SQL 草案 + docs/decisions/pg-backend-schema.md(实施定稿)。
//
// 设计(详见 pg-backend-schema.md):
//  - persist_records 单一真相源(全 record 信封列 + payload jsonb);projects/canvases 退化为瘦全局唯一索引表
//    (id→owner→is_deleted;附录 A 草案这两表含 payload,实施去重——payload 留 persist_records,减少双写同步面,语义不变)。
//  - 全局唯一索引同步读(getProjectOwner/getCanvasOwner/projectLive 接口同步,route authz seam 同步调用)
//    → 内存缓存(projectIndex/canvasIndex),启动从 PG 预热(ready promise);写操作在事务提交后同步缓存。
//  - 乐观并发:UPDATE ... WHERE revision=$client;numUpdatedRows=0 → 409(#4/#5)。
//  - 原子 tree 软删/恢复:createCanvasWithCollection / softDelete*Tree / restore*Tree 用单事务(等效内存实现快照回滚)。
//  - contentVersion bump:原子 jsonb_set(payload,'{contentVersion}', +1)(#5,不动 metaRevision)。
//  - 幂等(#10):idempotency_index 独立表 UNIQUE(owner+method+resourceKind+key)+ fingerprint;软删命中真恢复。
//  - F1(parent live)/F4(canvas 全局唯一)在事务内 SELECT...FOR UPDATE 防跨事务 TOCTOU(等效内存同步临界区)。
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
 * PgPersistBackend:PG 持久化后端。drop-in 实现 PersistBackend;路由零改动。
 * 单实例 BFF 假设(缓存 in-process;多实例协作留 T1.4+,见 pg-backend-schema.md §4)。
 */
export class PgPersistBackend implements PersistBackend {
  private readonly db: Kysely<Database>
  /** 全局唯一索引内存缓存(同步读;启动预热;写操作事务提交后同步)。 */
  private readonly projectIndex = new Map<string, GlobalIndexEntry>()
  private readonly canvasIndex = new Map<string, GlobalIndexEntry>()
  /** ready:全局索引预热完成(memory backend 立即 resolve;PG 从 PG load projects/canvases)。app 启动 await 后再 serve。 */
  readonly ready: Promise<void>

  constructor(conn: PgConnectionConfig) {
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: conn.host,
          port: conn.port,
          database: conn.database,
          user: conn.user,
          password: conn.password,
          max: conn.maxConnections,
          idleTimeoutMillis: conn.idleTimeoutMs,
        }),
      }),
    })
    this.ready = this.warm()
  }

  /** 预热全局唯一索引(projects/canvases 全量 load;瘦表,单实例量级小)。 */
  private async warm(): Promise<void> {
    const projects = await this.db.selectFrom('projects').select(['id', 'owner_id', 'is_deleted']).execute()
    for (const p of projects) this.projectIndex.set(p.id, { ownerId: p.owner_id, isDeleted: Boolean(p.is_deleted) })
    const canvases = await this.db.selectFrom('canvases').select(['id', 'owner_id', 'is_deleted']).execute()
    for (const c of canvases) this.canvasIndex.set(c.id, { ownerId: c.owner_id, isDeleted: Boolean(c.is_deleted) })
  }

  /** 优雅关闭连接池(app shutdown 用)。 */
  async destroy(): Promise<void> {
    await this.db.destroy()
  }

  /** 对本 backend 的 db 跑 migrateToLatest(可重放)。测试 beforeAll + 生产 runbook 用。 */
  async migrate(): Promise<void> {
    await runMigrations(this.db)
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

  /** 事务内读 canvas meta contentVersion(缺省 0)。 */
  private async canvasContentVersionInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string): Promise<Revision> {
    const r = await trx
      .selectFrom('persist_records')
      .select(sql`payload->>'contentVersion'`.as('content_version'))
      .where('owner_id', '=', ownerId)
      .where('type', '=', 'canvas')
      .where('id', '=', canvasId)
      .executeTakeFirst()
    return r ? Number(r.content_version ?? 0) : 0
  }

  /** 事务内 nextOrderKey:MAX(order_key)+1(子资源不软删,无需 is_deleted 过滤)。 */
  private async nextOrderKeyInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string, type: PersistType): Promise<number> {
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

  /** 事务内写幂等条目(UNIQUE 冲突 = 跨事务同 key race,由调用方 retry / reuse-conflict 处理)。 */
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
    await trx
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
      .onConflict((oc) => oc.columns(['owner_id', 'method', 'resource_kind', 'key']).doUpdateSet({ fingerprint, envelope_owner: envelopeOwner, envelope_type: envelopeType, envelope_id: envelopeId }))
      .execute()
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
              const restored = await this.restoreMetaInTrx(trx, ownerId, type, id, payload, opts)
              await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
              return { kind: 'restored', record: this.withIdem(restored, opts) }
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
        // N2:backend 原子 create-or-restore-tree。
        const restored = await this.restoreMetaInTrx(trx, ownerId, type, id, payload, opts)
        await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
        return { kind: 'restored', record: this.withIdem(restored, opts) }
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
      // 全局索引赢了 → INSERT persist_records。
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
        .returningAll()
        .executeTakeFirst()
      if (!created) throw new Error(`ensureCreate: insert failed for ${type}:${id}`)
      await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
      // 缓存同步由 post-commit re-warm(见方法末;不在提交前改缓存)。
      return { kind: 'created', record: this.withIdem(rowToRecord(created), opts) }
    })
    // post-commit re-warm:project/canvas create/restore 改了全局索引 → 缓存匹配已提交 DB(Greptile P1)。
    if ((result.kind === 'created' || result.kind === 'restored') && (type === 'project' || type === 'canvas')) await this.warm()
    return result
  }

  /** 给返回 record 回填 idempotencyKey/fingerprint(内存实现把它们存 record 行;PG 不持久化在 record 行,从 opts 回填以匹配契约测试断言)。 */
  private withIdem(rec: PersistRecord, opts: { idempotencyKey?: string; bodyFingerprint?: string }): PersistRecord {
    return { ...rec, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint }
  }

  /**
   * N2 私有 helper(事务内):meta record(project/canvas/chat-collection)恢复。
   * project/canvas → restoreProjectTree/restoreCanvasTreeInTrx(单 record + 子树);chat-collection → 单 record undelete+bump+payload。
   */
  private async restoreMetaInTrx(
    trx: Kysely<Database>,
    ownerId: string,
    type: PersistType,
    id: string,
    payload: unknown,
    opts: { canvasId?: string | null; scope?: PersistScope; idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<PersistRecord> {
    if (type === 'project') {
      const { count } = await this.restoreProjectTreeInTrx(trx, ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
      void count
    } else if (type === 'canvas') {
      const { count } = await this.restoreCanvasTreeInTrx(trx, ownerId, id, { payload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
      void count
    } else {
      // chat-collection / leaf meta:单 record undelete + bump + payload。
      await trx
        .updateTable('persist_records')
        .set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: opts.canvasId ?? sql`canvas_id`, scope: opts.scope ?? sql`scope` })
        .where('owner_id', '=', ownerId)
        .where('type', '=', type)
        .where('id', '=', id)
        .execute()
    }
    const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
    if (!r) throw new Error(`restoreMetaInTrx: ${type}:${id} missing post-restore`)
    return rowToRecord(r)
  }

  async createCanvasWithCollection(
    ownerId: string,
    canvasId: string,
    canvasPayload: unknown,
    opts: { idempotencyKey?: string; method: string; resourceKind: string; bodyFingerprint?: string },
  ): Promise<EnsureCreateResult> {
    await this.ready
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
              const restored = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
              await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
              await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
              const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
              if (!rec) throw new Error('createCanvasWithCollection: post-restore canvas missing')
              void restored
              return { kind: 'restored', record: this.withIdem(rowToRecord(rec), opts) }
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
        // N2/F1:parent live(已验 F1)→ restored(事务内 restore + ensureCollectionLive)。
        const restored = await this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, { payload: canvasPayload, idempotencyKey: opts.idempotencyKey, fingerprint: opts.bodyFingerprint })
        await this.ensureCollectionLiveInTrx(trx, ownerId, canvasId)
        await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
        void restored
        const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
        if (!rec) throw new Error('createCanvasWithCollection: post-restore canvas missing')
        return { kind: 'restored', record: this.withIdem(rowToRecord(rec), opts) }
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
      }
      await trx.insertInto('persist_records').values({ id: canvasId, owner_id: ownerId, canvas_id: null, type: 'canvas', scope: 'document', revision: 0, order_key: 0, is_deleted: false, payload: JSON.stringify(canvasPayload) }).execute()
      await trx.insertInto('persist_records').values({ id: canvasId, owner_id: ownerId, canvas_id: canvasId, type: 'chat-collection', scope: 'document', revision: 0, order_key: 0, is_deleted: false, payload: JSON.stringify({}) }).execute()
      await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, 'canvas', canvasId)
      // 缓存同步由 post-commit re-warm(见方法末;不在提交前改缓存)。
      const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).executeTakeFirst()
      if (!rec) throw new Error('createCanvasWithCollection: post-create canvas missing')
      return { kind: 'created', record: this.withIdem(rowToRecord(rec), opts) }
    })
    // post-commit re-warm:canvas create/restore 改了 canvases 全局索引 → 缓存匹配已提交 DB(Greptile P1)。
    if (result.kind === 'created' || result.kind === 'restored') await this.warm()
    return result
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
    return this.db.transaction().execute(async (trx) => {
      if (opts.idempotencyKey) {
        const entry = await this.idempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey)
        if (entry) {
          const r = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', entry.envelope_owner).where('type', '=', entry.envelope_type).where('id', '=', entry.envelope_id).executeTakeFirst()
          if (r) {
            if (r.canvas_id !== canvasId) return { kind: 'cross-canvas' }
            if (opts.bodyFingerprint && entry.fingerprint !== opts.bodyFingerprint) return { kind: 'reuse-conflict' }
            if (r.is_deleted) {
              await trx.updateTable('persist_records').set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: canvasId }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).execute()
              await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
              await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
              const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
              if (!rec) throw new Error('ensureCreateChild: post-restore missing')
              return { kind: 'restored', record: this.withIdem(rowToRecord(rec), opts) }
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
        await trx.updateTable('persist_records').set({ payload: JSON.stringify(payload), is_deleted: false, revision: sql`revision + 1`, updated_at: new Date(), canvas_id: canvasId }).where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).execute()
        await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
        await this.bumpCanvasContentVersionInTrx(trx, ownerId, canvasId)
        const rec = await trx.selectFrom('persist_records').selectAll().where('owner_id', '=', ownerId).where('type', '=', type).where('id', '=', id).executeTakeFirst()
        if (!rec) throw new Error('ensureCreateChild: post-restore missing')
        return { kind: 'restored', record: this.withIdem(rowToRecord(rec), opts) }
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
        if (type === 'project') await trx.insertInto('projects').values({ id, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.doUpdateSet({ is_deleted: false, updated_at: new Date() })).execute()
        if (type === 'canvas') await trx.insertInto('canvases').values({ id, owner_id: ownerId, is_deleted: false }).onConflict((oc) => oc.doUpdateSet({ is_deleted: false, updated_at: new Date() })).execute()
        await this.setIdempotencyEntryInTrx(trx, ownerId, opts.method, opts.resourceKind, opts.idempotencyKey, opts.bodyFingerprint ?? '', ownerId, type, id)
        // 缓存同步由 post-commit re-warm(见方法末;不在提交前改缓存)。
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
    // post-commit re-warm:project/canvas create(missing/软删→create)改了全局索引 → 缓存匹配已提交 DB(Greptile P1)。
    if (result.kind === 'created' && (type === 'project' || type === 'canvas')) await this.warm()
    return result
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
        // project/canvas 软删占位在全局索引表(canvases/projects);缓存同步由 post-commit re-warm。
        return { deleted: true, record: rowToRecord(updated ?? existing) }
      }
      return { deleted: true, record: rowToRecord(existing) }
    })
    // post-commit re-warm:project/canvas 全局索引可能变(软删);其他 type 无全局索引,跳过。
    if (res.deleted && (type === 'project' || type === 'canvas')) await this.warm()
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
      // N8/F5:If-Match(contentVersion base)必填——stale → 409(两并发一成一 409)。
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

  // ── 列表(返修 #6 ORDER BY order_key;#8 枚举)──────────────────────────────────────────

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
      // canvases 全局索引表软删;缓存同步由 post-commit re-warm。
      await trx.updateTable('canvases').set({ is_deleted: true, updated_at: new Date() }).where('id', '=', canvasId).where('is_deleted', '=', false).execute()
      const count = Number((r?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((c?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
      return { count }
    })
    await this.warm() // post-commit re-warm
    return res
  }

  async softDeleteProjectTree(ownerId: string, projectId: string): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => {
      // project meta
      const p = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', false).executeTakeFirst()
      // 其所有 canvas meta + chat-collection(canvas meta payload->>projectId = projectId)
      const cv = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', false).executeTakeFirst()
      // chat-collection:canvas_id 属 project 的 canvas(子查询)
      const cc = await trx.updateTable('persist_records').set({ is_deleted: true, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', 'in', (qb) => qb.selectFrom('persist_records').select('id').where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)).where('is_deleted', '=', false).executeTakeFirst()
      // projects 全局索引表软删;缓存同步由 post-commit re-warm。
      await trx.updateTable('projects').set({ is_deleted: true, updated_at: new Date() }).where('id', '=', projectId).where('is_deleted', '=', false).execute()
      // 注:project tree cascade 软删只标 project + 其 canvas meta + chat-collection;children 保持活记录(#2)。
      const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number(cv?.numUpdatedRows ?? 0n) + Number(cc?.numUpdatedRows ?? 0n)
      return { count }
    })
    await this.warm() // post-commit re-warm
    return res
  }

  /** 事务内:恢复 canvas 子树(canvas meta + chat-collection;原子,N2)。opts.payload 更新 canvas meta 域字段(保留 contentVersion)。缓存同步由调用方 top-level 方法在事务提交后 re-warm(Greptile P1:不在提交前改缓存)。 */
  private async restoreCanvasTreeInTrx(trx: Kysely<Database>, ownerId: string, canvasId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    const r = await trx.updateTable('persist_records').set({
      payload: opts.payload !== undefined ? sql`jsonb_set(${JSON.stringify(opts.payload)}::jsonb, '{contentVersion}', COALESCE(payload->'contentVersion', '0'::jsonb), true)` : sql`payload`,
      is_deleted: false,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where('id', '=', canvasId).where('is_deleted', '=', true).executeTakeFirst()
    const c = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', '=', canvasId).where('is_deleted', '=', true).executeTakeFirst()
    await trx.updateTable('canvases').set({ is_deleted: false, updated_at: new Date() }).where('id', '=', canvasId).execute()
    const count = Number((r?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number((c?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n)
    return { count }
  }

  /** 事务内:恢复 project 子树(project + 其 canvas meta + chat-collection;原子,N2)。缓存同步由调用方 re-warm。 */
  private async restoreProjectTreeInTrx(trx: Kysely<Database>, ownerId: string, projectId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    const p = await trx.updateTable('persist_records').set({
      payload: opts.payload !== undefined ? JSON.stringify(opts.payload) : sql`payload`,
      is_deleted: false,
      revision: sql`revision + 1`,
      updated_at: new Date(),
    }).where('owner_id', '=', ownerId).where('type', '=', 'project').where('id', '=', projectId).where('is_deleted', '=', true).executeTakeFirst()
    const cv = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId).where('is_deleted', '=', true).executeTakeFirst()
    const cc = await trx.updateTable('persist_records').set({ is_deleted: false, revision: sql`revision + 1`, updated_at: new Date() }).where('owner_id', '=', ownerId).where('type', '=', 'chat-collection').where('canvas_id', 'in', (qb) => qb.selectFrom('persist_records').select('id').where('owner_id', '=', ownerId).where('type', '=', 'canvas').where(sql`payload->>'projectId'`, '=', projectId)).where('is_deleted', '=', true).executeTakeFirst()
    await trx.updateTable('projects').set({ is_deleted: false, updated_at: new Date() }).where('id', '=', projectId).execute()
    void opts.idempotencyKey; void opts.fingerprint
    const count = Number((p?.numUpdatedRows ?? 0n) > 0n ? 1n : 0n) + Number(cv?.numUpdatedRows ?? 0n) + Number(cc?.numUpdatedRows ?? 0n)
    return { count }
  }

  async restoreCanvasTree(ownerId: string, canvasId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => this.restoreCanvasTreeInTrx(trx, ownerId, canvasId, opts))
    await this.warm() // post-commit re-warm:缓存匹配已提交的 DB(Greptile P1;失败不预热)
    return res
  }

  async restoreProjectTree(ownerId: string, projectId: string, opts: { payload?: unknown; idempotencyKey?: string; fingerprint?: string } = {}): Promise<{ count: number }> {
    await this.ready
    const res = await this.db.transaction().execute(async (trx) => this.restoreProjectTreeInTrx(trx, ownerId, projectId, opts))
    await this.warm() // post-commit re-warm
    return res
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
}

// re-export(供 app 注入 + routes 类型消费)
export type { Envelope, PersistScope, PersistType, Revision } from '../../shared/persist-contract.ts'
export { fingerprintOfBody } from './backend'
