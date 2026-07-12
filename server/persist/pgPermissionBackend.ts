// server/persist/pgPermissionBackend.ts
// T1.4 PgPermissionBackend:PG 权限层后端(Kysely + pg),drop-in 实现 PermissionBackend 接口。
// 权威:docs/decisions/permission-schema.md + docs/decisions/dp4-identity-alignment.md + soft-delete-semantics.md(FX-7)。
// 与 PgPersistBackend 对偶:同一 MIVO_PERSIST_BACKEND=pg 开关在 app.ts 组合注入(两者连同一 DB;各自跑 migrations,
// kysely_migration 追踪表幂等,已建库重放安全)。
//
// 设计(对齐 #202 PgPersistBackend 血泪原则):
//  - 数据源只准事务 returning/rowCount,无 SELECT-then-act race(create/revoke/unRevoke 全在单事务内)。
//  - 无乐观锁 revision(权限表非 CRDT LWW,owner 权威写,§13.5)。
//  - 无全局唯一索引缓存(权限无同步 seam:resolveMemberRole/resolveShareLink 全 async,直查 DB)。
//  - share_links 软删 = revoked_at(FX-7 §2);un-revoke 30 天窗(FX-7 §5.9,SQL INTERVAL 判定,与内存 Date.now 等价)。
//  - FK:project_id REFERENCES projects(id) ON DELETE CASCADE(project purge → members/links 清;projects 表由 001 建于本 002 之前)。
//  - created flag:INSERT ON CONFLICT DO NOTHING returning → 返行=created;空=已存在→UPDATE returning=updated(无 xmax 复杂度)。
// swap 不改路由/契约:server/app.ts 注入点从 InMemoryPermissionBackend 换 PgPermissionBackend(env 开关),路由零改动。

import { randomUUID, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql, type Generated, type Selectable } from 'kysely'
import { Migrator, type MigrationProvider, type Migration } from 'kysely/migration'
import { migrations } from './migrations'
import type { PgConnectionConfig } from './pgConfig'
import type {
  PermissionBackend,
  ProjectMember,
  ShareLink,
  ShareResolution,
  UpsertMemberResult,
  RemoveMemberResult,
  RevokeResult,
  UnRevokeResult,
  CompensationOp,
  CompensationIntent,
  CompensationOutcome,
} from '../lib/permissions'
import {
  UNREVOKE_WINDOW_MS,
  COMPENSATION_CLAIM_LEASE_MS,
  COMPENSATION_MAX_SWEEP_ATTEMPTS,
} from '../lib/permissions'
import type { ProjectRole, SharePermission } from '../lib/authz'

// ── Kysely Database 类型(权限两表)──────────────────────────────────────────────────
interface ProjectMembersTable {
  id: string
  project_id: string
  user_id: string
  role: string // 'owner'|'editor'|'viewer'(DB CHECK 强制;读出后 cast)
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
interface ShareLinksTable {
  id: string
  token: string
  project_id: string
  permission: string // 'view'|'edit'(DB CHECK 强制)
  created_by: string
  created_at: Generated<Date>
  updated_at: Generated<Date>
  revoked_at: Date | null
  expires_at: Date | null
  // P-6 marker(005 migration ALTER 加列):级联 revoke 标记。区分 project 软删级联 vs 手工吊销。
  cascade_revoked_at: Date | null
}
// P-6 saga 补偿意图表(005 migration 建 + 006 加 'failed' 终态)。无 revision(owner 权威写);attempt_count/last_error/last_attempted_at=可观察。
// 返修 P1-2/P1-3/P2-1:generation(代际 supersede)+ claimed_at/claimed_until(租约)+ status 'superseded' + partial unique index。
// 返修 R3-F2:status 'failed'(sweep 超限 dead-letter,不占 partial unique 槽,006 ALTER CHECK 加)。
interface ShareLinkCompensationsTable {
  id: string
  project_id: string
  op: string // 'restore'|'delete'(DB CHECK 强制;读出后 cast)
  status: string // 'pending'|'done'|'superseded'|'failed'(DB CHECK 强制;006 加 'failed';读出后 cast)
  generation: number
  attempt_count: number
  last_error: string | null
  last_attempted_at: Date | null
  claimed_at: Date | null
  claimed_until: Date | null
  // R3-F4: claim fencing token(007 migration 加列)。claim 写入;done/failed/supersede 清空。
  claim_token: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
interface PermissionDatabase {
  project_members: ProjectMembersTable
  share_links: ShareLinksTable
  share_link_compensations: ShareLinkCompensationsTable
}

/** 密码学随机 token(256-bit,base64url ≈ 43 chars;不可枚举,§1.2)。与内存实现同算法,route 测试断言一致。 */
const generateShareToken = (): string => randomBytes(32).toString('base64url')

/** DB 行 → ProjectMember。 */
const rowToMember = (row: Selectable<ProjectMembersTable>): ProjectMember => ({
  id: row.id,
  projectId: row.project_id,
  userId: row.user_id,
  role: row.role as ProjectRole,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
})

/** DB 行 → ShareLink。 */
const rowToShareLink = (row: Selectable<ShareLinksTable>): ShareLink => ({
  id: row.id,
  token: row.token,
  projectId: row.project_id,
  permission: row.permission as SharePermission,
  createdBy: row.created_by,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  revokedAt: row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at.toISOString() : String(row.revoked_at)) : null,
  expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at)) : null,
  cascadeRevokedAt: row.cascade_revoked_at ? (row.cascade_revoked_at instanceof Date ? row.cascade_revoked_at.toISOString() : String(row.cascade_revoked_at)) : null,
})

/** DB 行 → P-6 CompensationIntent。 */
const rowToCompensation = (row: Selectable<ShareLinkCompensationsTable>): CompensationIntent => ({
  id: row.id,
  projectId: row.project_id,
  op: row.op as CompensationOp,
  status: row.status as 'pending' | 'done' | 'superseded' | 'failed',
  generation: row.generation,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  lastAttemptedAt: row.last_attempted_at instanceof Date ? row.last_attempted_at.toISOString() : (row.last_attempted_at ? String(row.last_attempted_at) : null),
  claimedAt: row.claimed_at instanceof Date ? row.claimed_at.toISOString() : (row.claimed_at ? String(row.claimed_at) : null),
  claimedUntil: row.claimed_until instanceof Date ? row.claimed_until.toISOString() : (row.claimed_until ? String(row.claimed_until) : null),
  claimToken: row.claim_token ?? null,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
})

// ── Migration provider(静态列表,免 FileMigrationProvider 路径解析;与 PgPersistBackend 同模式)──────────
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
 * runPermissionMigrations:对 db 跑 migrateToLatest(可重放;migrator 自带 kysely_migration 追踪表)。
 * migrations 记录含 persist(001)+ permission(002)两 schema;PgPersistBackend 已跑过则追踪表显全 applied → no-op,
 * fresh DB 则按字典序 apply(001 建 projects→002 建 project_members/share_links,FK 目标先于引用存在)。
 */
export const runPermissionMigrations = async (db: Kysely<PermissionDatabase>): Promise<void> => {
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
 * PgPermissionBackend:PG 权限层后端。drop-in 实现 PermissionBackend;路由零改动。
 * 单实例 BFF 假设(无全局缓存;多实例协作留 T1.4+,同 PgPersistBackend)。
 */
export class PgPermissionBackend implements PermissionBackend {
  private readonly db: Kysely<PermissionDatabase>
  /** ready:migrations 完成建表(无 warm cache——权限无同步 seam)。app 启动 await 后再 serve。 */
  readonly ready: Promise<void>
  /** P-6 Test-only 故障注入:op → 剩余强制失败次数(attemptCompensation 内消费,不污染 unRevoke/revoke 本身)。 */
  private readonly compensationFault: Partial<Record<CompensationOp, number>> = {}
  /** R3-F4 Test-only:op → claim 后 side effect 前的 await 暂停点(模拟赢家超过 lease 暂停,供 race 验收)。 */
  private readonly compensationClaimPauseForTest: Partial<Record<CompensationOp, () => Promise<void>>> = {}

  constructor(conn: PgConnectionConfig) {
    this.db = new Kysely<PermissionDatabase>({
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
    this.ready = this.init()
  }

  /** migrate-then-ready(可重放;migrator 自带 kysely_migration 追踪表)。 */
  private async init(): Promise<void> {
    await this.migrate()
  }

  /** 优雅关闭连接池(app shutdown 用)。 */
  async destroy(): Promise<void> {
    await this.db.destroy()
  }

  /** 对本 backend 的 db 跑 migrateToLatest(可重放)。测试 beforeAll + 生产 runbook 用。 */
  async migrate(): Promise<void> {
    await runPermissionMigrations(this.db)
  }

  // ── 成员资格(project_members)──────────────────────────────────────────────────────────

  async resolveMemberRole(projectId: string, userId: string, ownerUserId: string): Promise<ProjectRole | undefined> {
    await this.ready
    // 派生 owner(§3;T1.3 owner===actor 自归属)——TS 层判定,不查 DB。
    if (userId === ownerUserId) return 'owner'
    const row = await this.db
      .selectFrom('project_members')
      .select('role')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    return row ? (row.role as ProjectRole) : undefined
  }

  async listMembers(projectId: string, ownerUserId: string): Promise<ProjectMember[]> {
    await this.ready
    const rows = await this.db.selectFrom('project_members').selectAll().where('project_id', '=', projectId).execute()
    // 合成 owner 派生行(§3);explicit 行不含 owner(upsert 拒绝插 owner),故无重复。与内存实现同形。
    const ownerRow: ProjectMember = {
      id: `derived:${projectId}:${ownerUserId}`,
      projectId,
      userId: ownerUserId,
      role: 'owner',
      createdAt: '', // owner 派生无独立时间;空串表"派生"
      updatedAt: '',
    }
    return [ownerRow, ...rows.map(rowToMember)]
  }

  async upsertMember(projectId: string, userId: string, role: ProjectRole): Promise<UpsertMemberResult> {
    await this.ready
    // 拒绝显式 'owner' 行(owner 派生,§3);要改 owner 见 P-2。
    if (role === 'owner') return { ok: false, reason: 'is-owner' }
    return this.db.transaction().execute(async (trx) => {
      // INSERT ON CONFLICT DO NOTHING → returning 非空 = created(原子;无 SELECT-then-INSERT race)。
      const ins = await trx
        .insertInto('project_members')
        .values({ id: randomUUID(), project_id: projectId, user_id: userId, role })
        .onConflict((oc) => oc.columns(['project_id', 'user_id']).doNothing())
        .returningAll()
        .executeTakeFirst()
      if (ins) return { ok: true, member: rowToMember(ins), created: true }
      // 已存在 → UPDATE role(returning;事务内原子)。
      const upd = await trx
        .updateTable('project_members')
        .set({ role, updated_at: new Date() })
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirst()
      if (upd) return { ok: true, member: rowToMember(upd), created: false }
      // 并发删了 member(anomaly)→ 契约无此态;visible fail,不静默返 not-found 假成功。
      throw new Error(`upsertMember: member vanished between INSERT-conflict and UPDATE (${projectId}:${userId})`)
    })
  }

  async removeMember(projectId: string, userId: string): Promise<RemoveMemberResult> {
    await this.ready
    // DELETE returning → 非空 = removed;空 = not-found(原子;rowCount 定输赢)。
    const row = await this.db
      .deleteFrom('project_members')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst()
    return row ? { ok: true, removed: rowToMember(row) } : { ok: false, reason: 'not-found' }
  }

  async listSharedProjects(userId: string): Promise<{ projectId: string; role: ProjectRole }[]> {
    await this.ready
    const rows = await this.db.selectFrom('project_members').select(['project_id', 'role']).where('user_id', '=', userId).execute()
    return rows.map((r) => ({ projectId: r.project_id, role: r.role as ProjectRole }))
  }

  // ── 分享链接(share_links)──────────────────────────────────────────────────────────────

  async createShareLink(projectId: string, permission: SharePermission, createdBy: string): Promise<ShareLink> {
    await this.ready
    // token 密码学随机(TS 生成,与内存同算法);INSERT returning 全行(含 DB 默认 created_at/updated_at/revoked_at/expires_at)。
    const row = await this.db
      .insertInto('share_links')
      .values({ id: randomUUID(), token: generateShareToken(), project_id: projectId, permission, created_by: createdBy })
      .returningAll()
      .executeTakeFirst()
    if (!row) throw new Error('createShareLink: insert failed (FK violation — project missing?)')
    return rowToShareLink(row)
  }

  async resolveShareLink(token: string, projectId: string): Promise<ShareResolution | undefined> {
    await this.ready
    const row = await this.db.selectFrom('share_links').selectAll().where('token', '=', token).executeTakeFirst()
    if (!row) return undefined // 未知 token → undefined(route 返 404,无存在泄漏)
    if (row.project_id !== projectId) return undefined // token 不属此 project → 当未知处理(404,无泄漏)
    if (row.revoked_at) return { kind: 'revoked' } // FX-7 §5.9:revoke → 410
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return { kind: 'expired' }
    return { kind: 'active', permission: row.permission as SharePermission }
  }

  async resolveShareLinkByToken(token: string): Promise<(ShareResolution & { projectId: string }) | undefined> {
    await this.ready
    const row = await this.db.selectFrom('share_links').selectAll().where('token', '=', token).executeTakeFirst()
    if (!row) return undefined
    if (row.revoked_at) return { kind: 'revoked', projectId: row.project_id }
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return { kind: 'expired', projectId: row.project_id }
    return { kind: 'active', projectId: row.project_id, permission: row.permission as SharePermission }
  }

  async listShareLinks(projectId: string): Promise<ShareLink[]> {
    await this.ready
    const rows = await this.db.selectFrom('share_links').selectAll().where('project_id', '=', projectId).execute()
    return rows.map(rowToShareLink)
  }

  async revokeShareLink(linkId: string, projectId: string): Promise<RevokeResult> {
    await this.ready
    return this.db.transaction().execute(async (trx) => {
      // UPDATE WHERE id+project_id+revoked_at IS NULL → returning 非空 = ok(原子;WHERE project_id 防 A 吊销 B 的 link)。
      const row = await trx
        .updateTable('share_links')
        .set({ revoked_at: new Date(), updated_at: new Date() })
        .where('id', '=', linkId)
        .where('project_id', '=', projectId)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst()
      if (row) return { ok: true, link: rowToShareLink(row) }
      // returning 空 → 二分:not-found(link 不存在/跨项目)vs already-revoked。SELECT 定因(无泄漏:跨项目与不存在都 not-found)。
      const existing = await trx.selectFrom('share_links').select('revoked_at').where('id', '=', linkId).where('project_id', '=', projectId).executeTakeFirst()
      if (!existing) return { ok: false, reason: 'not-found' }
      return existing.revoked_at ? { ok: false, reason: 'already-revoked' } : { ok: false, reason: 'not-found' }
    })
  }

  async unRevokeShareLink(linkId: string, projectId: string): Promise<UnRevokeResult> {
    await this.ready
    return this.db.transaction().execute(async (trx) => {
      // FOR UPDATE 锁行 → 读 revoked_at → 窗校验 → UPDATE(全在同一事务,原子;无 TOCTOU)。
      const row = await trx
        .selectFrom('share_links')
        .selectAll()
        .where('id', '=', linkId)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst()
      if (!row) return { ok: false, reason: 'not-found' } // 跨项目/不存在 → not-found(无泄漏)
      // FX-7 §5.9:un-revoke 30 天窗;超期不可恢复。
      if (row.revoked_at && Date.now() - row.revoked_at.getTime() > UNREVOKE_WINDOW_MS) {
        return { ok: false, reason: 'window-closed' }
      }
      // revoked(窗内)或 active(幂等)→ SET revoked_at=null(returning;原子)。P-6:同步清 cascade_revoked_at marker。
      const upd = await trx
        .updateTable('share_links')
        .set({ revoked_at: null, cascade_revoked_at: null, updated_at: new Date() })
        .where('id', '=', linkId)
        .where('project_id', '=', projectId)
        .returningAll()
        .executeTakeFirst()
      if (!upd) return { ok: false, reason: 'not-found' } // 防御:并发删了 link
      return { ok: true, link: rowToShareLink(upd) }
    })
  }

  // ── FX-7 级联(project 软删/恢复)──────────────────────────────────────────────────────

  async revokeAllForProject(projectId: string): Promise<{ count: number }> {
    await this.ready
    return this.revokeAllForProjectInConn(this.db, projectId)
  }

  async unRevokeAllForProject(projectId: string): Promise<{ count: number }> {
    await this.ready
    return this.unRevokeAllForProjectInConn(this.db, projectId)
  }

  /**
   * R5-F1: revoke 级联的 connection-aware 实现(conn=this.db 走 autocommit;conn=trx 走 attemptCompensation
   * 的 critical 事务,与 projects FOR UPDATE + done CAS 同事务原子,消除 TOCTOU)。
   * 单语句原子:UPDATE WHERE project_id+revoked_at IS NULL RETURNING id → count=返行数(只 revoke 活的)。
   * P-6 marker:同步置 cascade_revoked_at(级联 revoke 标记,restore 补偿只动此标记非空的链接)。
   */
  private async revokeAllForProjectInConn(conn: Kysely<PermissionDatabase>, projectId: string): Promise<{ count: number }> {
    const now = new Date()
    const rows = await conn
      .updateTable('share_links')
      .set({ revoked_at: now, cascade_revoked_at: now, updated_at: now })
      .where('project_id', '=', projectId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute()
    return { count: rows.length }
  }

  /**
   * R5-F1: unRevoke 级联的 connection-aware 实现(同上,conn=trx 时与 critical 事务同事务)。
   * P-6 marker:仅恢复"级联 revoke"标记(cascade_revoked_at 非空)且 30 天窗内的链接,清空 marker + revoked_at。
   * 手工 revoke(cascade_revoked_at IS NULL)永不被 restore 补偿动 → 防误恢复用户主动吊销的链接。
   */
  private async unRevokeAllForProjectInConn(conn: Kysely<PermissionDatabase>, projectId: string): Promise<{ count: number }> {
    const cutoff = new Date(Date.now() - UNREVOKE_WINDOW_MS)
    const rows = await conn
      .updateTable('share_links')
      .set({ revoked_at: null, cascade_revoked_at: null, updated_at: new Date() })
      .where('project_id', '=', projectId)
      .where('cascade_revoked_at', 'is not', null)
      .where('cascade_revoked_at', '>=', cutoff)
      .returning('id')
      .execute()
    return { count: rows.length }
  }

  // ── P-6 saga 补偿(返修 P1-1/P1-2/P1-3/P2-1:marker + supersede + claim/lease + sweep)──
  // 设计:
  //  - marker:cascade_revoked_at(级联 revoke 标记)随 unRevokeAll/revokeAll 提交 durable;record 崩溃后,
  //    marker 已 durable → 重启 sweep(据 projects.is_deleted + share_links.cascade_revoked_at derive)或
  //    重试 attempt(据 compensationNeed)自动收敛。手工 revoke(cascade_revoked_at IS NULL)永不动。
  //  - record:advisory_xact_lock(projectId,op) 串行化并发首建 + partial unique index 兜底 → 恰一条 pending。
  //  - attempt:原子 UPDATE...WHERE status='pending' AND lease-free RETURNING claim(P2-1);loser 返 already-claimed。
  //  - sweep:启动 reconcileFromProjectState(derive pending from projects.is_deleted)+ 周期 attempt pending(有界)。

  /** op → advisory lock key2(restore=1,delete=2)。 */
  private static opLockKey(op: CompensationOp): number {
    return op === 'restore' ? 1 : 2
  }

  /** project 级下一代际 = 现存全部意图 max(generation)+1。 */
  private async nextGenerationInTrx(trx: Kysely<PermissionDatabase>, projectId: string): Promise<number> {
    const row = await trx.selectFrom('share_link_compensations')
      .select((eb) => eb.fn.max('generation').as('g'))
      .where('project_id', '=', projectId)
      .executeTakeFirst()
    const g = (row as { g?: number | string | null } | undefined)?.g
    return (Number(g ?? 0) || 0) + 1
  }

  async recordCompensation(projectId: string, op: CompensationOp): Promise<CompensationIntent> {
    await this.ready
    return this.db.transaction().execute(async (trx) => {
      // P1-3:pg_advisory_xact_lock 串行化同 (projectId,op) 的并发 record → 恰一条 pending(FOR UPDATE 对空结果不锁,
      // 原bug:两首建都 INSERT→多条 pending)。partial unique index UNIQUE(project_id,op) WHERE status='pending' 兜底。
      await sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}), ${PgPermissionBackend.opLockKey(op)}::integer)`.execute(trx)
      // R6 锁序统一(R5 verdict Step 4 暴露的 P2 反向锁环):先锁 project 行 FOR UPDATE,再写/插 compensations。
      //   未修前 record 先 UPDATE supersede 持 compensation 行锁,再 INSERT 新 generation 触发 FK(project_id
      //   REFERENCES projects(id))对 project 行请求 KEY SHARE;而 attemptCompensation critical section 先持
      //   project FOR UPDATE 后持 compensation FOR UPDATE——形成 compensation→project 与 project→compensation 的
      //   反向锁环,真 PG 确定性触发 40P01 deadlock。此处与 attempt critical section(project→compensation)统一同序,
      //   消除环;INSERT 的 FK KEY SHARE 被已持的 FOR UPDATE(强锁)覆盖,无需额外获取。project 行不存在 → SELECT
      //   返 0 行(无锁),后续 INSERT 仍按原逻辑抛 FK violation(line 487),行为不变。不得削弱 F1 TOCTOU 语义
      //   (attempt critical 的 is_deleted 重读仍在自身 project FOR UPDATE 锁内,不受影响)。
      // [R6-RED-PROOF] 已还原:40P01 在旧代码(摘掉此行)确定性复现,加回后绿(见 R6 barrier 测试)。
      await sql`SELECT 1 FROM projects WHERE id = ${projectId} FOR UPDATE`.execute(trx)
      // P1-2 supersede:把 pending 对立 op mark superseded(保留行做历史;不再被 sweep/attempt 处理)。
      const opposite: CompensationOp = op === 'restore' ? 'delete' : 'restore'
      await trx.updateTable('share_link_compensations')
        .set({ status: 'superseded', last_error: `superseded by ${op} generation`, claimed_at: null, claimed_until: null, claim_token: null, updated_at: new Date() })
        .where('project_id', '=', projectId)
        .where('op', '=', opposite)
        .where('status', '=', 'pending')
        .execute()
      // 幂等:已有 pending 同 op → 返之(不重复),防重入 POST restored 重复建意图。
      const existing = await trx.selectFrom('share_link_compensations').selectAll()
        .where('project_id', '=', projectId)
        .where('op', '=', op)
        .where('status', '=', 'pending')
        .executeTakeFirst()
      if (existing) return rowToCompensation(existing)
      // R5-F2:新 generation record 时把同 project 全部历史 failed dead-letter 标 superseded(不计当前未收敛)。
      //   新 generation(同 op 重试 / 对立 op 翻转)意味 desired state 已翻篇,旧 dead-letter 不再代表当前未收敛
      //   → counts.failed 归零(/readyz 可用性恢复,不再永久 503)。保留行于 listCompensations 供审计。
      //   与 memory supersedeOldFailedForProject 对偶;同事务 + advisory lock 保证与并发 record 串行。
      await trx.updateTable('share_link_compensations')
        .set({ status: 'superseded', last_error: 'superseded by newer generation (reopen)', claimed_at: null, claimed_until: null, claim_token: null, updated_at: new Date() })
        .where('project_id', '=', projectId)
        .where('status', '=', 'failed')
        .execute()
      const gen = await this.nextGenerationInTrx(trx, projectId)
      const row = await trx.insertInto('share_link_compensations')
        .values({
          id: randomUUID(),
          project_id: projectId,
          op,
          status: 'pending',
          generation: gen,
          attempt_count: 0,
          last_error: null,
          last_attempted_at: null,
          claimed_at: null,
          claimed_until: null,
          claim_token: null,
        })
        .returningAll()
        .executeTakeFirst()
      if (!row) throw new Error('recordCompensation: insert failed (FK violation — project missing?)')
      return rowToCompensation(row)
    })
  }

  /** 找 (projectId, op) 最近一条 pending 意图(无 → undefined;按 generation desc 取最新代际)。 */
  private async findPendingCompensationPg(projectId: string, op: CompensationOp): Promise<CompensationIntent | undefined> {
    const row = await this.db.selectFrom('share_link_compensations').selectAll()
      .where('project_id', '=', projectId)
      .where('op', '=', op)
      .where('status', '=', 'pending')
      .orderBy('generation', 'desc')
      .executeTakeFirst()
    return row ? rowToCompensation(row) : undefined
  }

  /** marker-driven need:restore → 存在 cascade 标记且 30 天窗内的链接;delete → 存在 active 链接。 */
  private async compensationNeedPg(projectId: string, op: CompensationOp): Promise<boolean> {
    const cutoff = new Date(Date.now() - UNREVOKE_WINDOW_MS)
    let q
    if (op === 'restore') {
      q = this.db.selectFrom('share_links').select('id')
        .where('project_id', '=', projectId)
        .where('cascade_revoked_at', 'is not', null)
        .where('cascade_revoked_at', '>=', cutoff)
        .limit(1)
    } else {
      q = this.db.selectFrom('share_links').select('id')
        .where('project_id', '=', projectId)
        .where('revoked_at', 'is', null)
        .limit(1)
    }
    const row = await q.executeTakeFirst()
    return !!row
  }

  /**
   * R3-F1: 查 project 的 durable desired state(projects.is_deleted)。primary ensureCreate(restore→false)/
   * softDeleteProjectTree(delete→true)先于 recordCompensation 提交 → is_deleted 即最新 desired state 的 ground truth。
   * project 行不存在 → undefined(权限层 fallback 到 hasSupersededCompensationPg,与 memory 对偶)。
   */
  private async getProjectIsDeleted(projectId: string): Promise<boolean | undefined> {
    const result = await sql`SELECT is_deleted FROM projects WHERE id = ${projectId}`.execute(this.db)
    const row = (result.rows as { is_deleted?: boolean }[])[0]
    return row === undefined ? undefined : !!row.is_deleted
  }

  /** R3-F1: (projectId, op) 是否存在被显式 supersede 的意图(对立 op 新代际曾 record 并 supersede 它)。 */
  private async hasSupersededCompensationPg(projectId: string, op: CompensationOp): Promise<boolean> {
    const row = await this.db.selectFrom('share_link_compensations').select('id')
      .where('project_id', '=', projectId).where('op', '=', op).where('status', '=', 'superseded')
      .limit(1).executeTakeFirst()
    return !!row
  }

  async attemptCompensation(projectId: string, op: CompensationOp): Promise<CompensationOutcome> {
    await this.ready
    // 1. find or create pending intent(P1-1 crash-recovery:record 崩溃后无 pending,marker 表明需补偿 → 自建)。
    let intent = await this.findPendingCompensationPg(projectId, op)
    // R3-F1: stale-op gate。晚到的 attemptCompensation 不得仅凭 compensationNeed 重建旧 op intent——
    // 那会把更新代际对立 op 的 revoked/active 终态翻转回来(权限边界破坏:已删项目重开链接/已恢复项目再吊销)。
    // durable desired state 决断:PG 的 projects.is_deleted 是 ground truth(primary ensureCreate/softDelete
    //   先于 recordCompensation 提交,is_deleted 即最新 desired state)。is_deleted 已知且与 op 矛盾 → stale。
    //   is_deleted 未知(project 行不存在)→ 退化到 hasSuperseded(仅 !intent 时,与 memory 对偶)。
    // stale → 标 superseded 返回,不重建、不执行副作用(含 intent 仍 pending 的 sweep 残留也挡)。
    const isDeleted = await this.getProjectIsDeleted(projectId)
    let stale = false
    let staleReason = ''
    if (isDeleted !== undefined) {
      const desiredByState: CompensationOp = isDeleted ? 'delete' : 'restore'
      if (desiredByState !== op) { stale = true; staleReason = `durable desired state (is_deleted=${isDeleted})` }
    } else if (!intent && await this.hasSupersededCompensationPg(projectId, op)) {
      stale = true; staleReason = 'superseded by newer opposing generation'
    }
    if (stale) {
      if (intent) {
        await this.db.updateTable('share_link_compensations')
          .set({ status: 'superseded', last_error: `superseded by ${staleReason}`, claimed_at: null, claimed_until: null, updated_at: new Date() })
          .where('id', '=', intent.id).where('status', '=', 'pending').execute()
      }
      return { kind: 'superseded', op, intentId: intent?.id }
    }
    const need = await this.compensationNeedPg(projectId, op)
    if (!intent && !need) return { kind: 'nothing-pending', op }
    if (!intent) intent = await this.recordCompensation(projectId, op)
    // 2. P2-1 atomic claim + R3-F4 fencing token:UPDATE WHERE status='pending' AND lease-free
    //   SET claim_token=randomUUID(), claimed_until RETURNING;0 行 → already-claimed。
    //   UPDATE 行锁串行化并发 claim:赢家 set token+lease 返行;输家等锁后重检 WHERE(lease 已占)→ 0 行。
    //   token 用于 side-effect 前预校验 + done/failed UPDATE 的 ownership 校验:lease 过期被新 worker 抢走后,
    //   旧 owner 的 pre-check 失败/done UPDATE 0 行 → stale-claim(不执行副作用、不 mark done、不 bump attemptCount)。
    const claimToken = randomUUID()
    const leaseUntil = new Date(Date.now() + COMPENSATION_CLAIM_LEASE_MS)
    const claimed = await this.db.updateTable('share_link_compensations')
      .set({ claim_token: claimToken, claimed_at: new Date(), claimed_until: leaseUntil, updated_at: new Date() })
      .where('id', '=', intent.id)
      .where('status', '=', 'pending')
      .where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<', new Date())]))
      .returningAll()
      .executeTakeFirst()
    if (!claimed) return { kind: 'already-claimed', op, intentId: intent.id }
    const cl = rowToCompensation(claimed)
    const attempts = cl.attemptCount + 1
    // Test-only pause(F4 race 验收 + R5-F1 TOCTOU 复现):claim 后、side effect 前注入 await,模拟赢家超过 lease
    //   暂停(F4)或 primary 在 record 前崩溃、durable state 在 claim 后翻转的 TOCTOU 窗口(R5-F1)。
    const pauseFn = this.compensationClaimPauseForTest[op]
    if (pauseFn) await pauseFn()
    // Test-only 故障注入:decrement 后 throw(语义等价"第二步抛错");不污染 unRevoke/revoke 本身。
    const fault = this.compensationFault[op] ?? 0
    // R5-F1 FIX: critical section —— claim 后、side effect 前在同一事务内锁 projects 行 FOR UPDATE 并重读
    //   is_deleted,与 primary softDelete/ensureCreate 的 projects.is_deleted 写串行化(消除 TOCTOU:primary
    //   提交后、record 前崩溃时 durable state 已翻,旧 worker 不得执行副作用重开已删/吊销已恢复链接)。
    //   同时锁 compensations 行 FOR UPDATE 确认 claim ownership(lease 过期被新 worker 抢 → stale-claim,
    //   不执行副作用、不 mark done、不 bump attemptCount)。stale(is_deleted 翻转)→ supersede 不执行副作用;
    //   否则 side-effect + done CAS 同事务原子。对齐 pgBackend chat CAS 单语句原子先例(同事务串行化)。
    try {
      return await this.db.transaction().execute(async (trx) => {
        // 1. 锁 projects 行 FOR UPDATE + 重读 is_deleted(与 primary is_deleted 写串行化;持锁期间 primary
        //   softDelete/ensureCreate 的 UPDATE projects.is_deleted 阻塞至本事务提交 → is_deleted 稳定,无 TOCTOU)。
        const projRes = await sql`SELECT is_deleted FROM projects WHERE id = ${projectId} FOR UPDATE`.execute(trx)
        const projRow = (projRes.rows as { is_deleted?: boolean }[])[0]
        const isDeletedAfter = projRow === undefined ? undefined : !!projRow.is_deleted
        if (isDeletedAfter !== undefined) {
          const desiredAfter: CompensationOp = isDeletedAfter ? 'delete' : 'restore'
          if (desiredAfter !== op) {
            // stale:durable desired state 在 claim 后翻转 → supersede(WHERE token=ours,不执行副作用)。
            //   project 锁保证重读稳定;WHERE claim_token=ours 防止 clobber lease 过期后被新 worker 抢的 owner。
            await trx.updateTable('share_link_compensations')
              .set({ status: 'superseded', last_error: `superseded by durable desired state (is_deleted=${isDeletedAfter}) after claim`, claimed_at: null, claimed_until: null, claim_token: null, updated_at: new Date() })
              .where('id', '=', intent.id)
              .where('claim_token', '=', claimToken)
              .where('status', '=', 'pending')
              .execute()
            return { kind: 'superseded', op, intentId: intent.id }
          }
        }
        // 2. 锁 compensations 行 FOR UPDATE + 确认 ownership(token=ours、status=pending)。
        //   lease 过期被新 worker 重 claim(token 变/status 变)→ 0 行 → stale-claim(不执行副作用、不 mark done)。
        const ownerRow = await trx.selectFrom('share_link_compensations').select('id')
          .where('id', '=', intent.id)
          .where('claim_token', '=', claimToken)
          .where('status', '=', 'pending')
          .forUpdate()
          .executeTakeFirst()
        if (!ownerRow) return { kind: 'stale-claim', op, intentId: intent.id }
        // 故障注入(decrement 后 throw):事务回滚 side effect + done,catch 在事务外 bump 可观察字段。
        if (fault > 0) {
          this.compensationFault[op] = fault - 1
          throw new Error(`[compensation-fault] ${op} step forced failure (was ${fault})`)
        }
        // 3. side effect(同事务;revoke/unRevoke 级联,connection-aware InConn 跑在 trx 上)。
        const r = op === 'restore'
          ? await this.unRevokeAllForProjectInConn(trx, projectId)
          : await this.revokeAllForProjectInConn(trx, projectId)
        // 4. done CAS WHERE claim_token=ours(同事务;持 compensations 行锁保证成功,WHERE 仍兜底防异常)。
        const doneRow = await trx.updateTable('share_link_compensations')
          .set({ status: 'done', attempt_count: attempts, last_error: null, last_attempted_at: new Date(), claimed_at: null, claimed_until: null, claim_token: null, updated_at: new Date() })
          .where('id', '=', intent.id)
          .where('status', '=', 'pending')
          .where('claim_token', '=', claimToken)
          .returning('id')
          .executeTakeFirst()
        if (!doneRow) return { kind: 'stale-claim', op, intentId: intent.id }
        return { kind: 'completed', op, count: r.count, attempts, intentId: intent.id }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 失败(事务回滚:side effect + done 未提交):保持 pending,bump 可观察字段,清 lease+token。
      //   WHERE claim_token=ours 防止 clobber 新 owner(若执行中 lease 过期被抢,本 UPDATE 0 行 → 不影响新 owner;
      //   本 worker 仍报 failed,attemptCount 不 bump)。
      await this.db.updateTable('share_link_compensations')
        .set({ attempt_count: attempts, last_error: msg, last_attempted_at: new Date(), claimed_at: null, claimed_until: null, claim_token: null, updated_at: new Date() })
        .where('id', '=', intent.id)
        .where('status', '=', 'pending')
        .where('claim_token', '=', claimToken)
        .execute()
      return { kind: 'failed', op, error: msg, attempts, intentId: intent.id }
    }
  }

  async listCompensations(projectId: string): Promise<CompensationIntent[]> {
    await this.ready
    const rows = await this.db.selectFrom('share_link_compensations').selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute()
    return rows.map(rowToCompensation)
  }

  async listPendingCompensations(projectId?: string): Promise<CompensationIntent[]> {
    await this.ready
    let q = this.db.selectFrom('share_link_compensations').selectAll().where('status', '=', 'pending')
    if (projectId) q = q.where('project_id', '=', projectId)
    const rows = await q.orderBy('generation', 'desc').execute()
    return rows.map(rowToCompensation)
  }

  /** R3-F2:列 failed/dead-letter 意图(超限放弃;可告警的未收敛事实)。 */
  async listFailedCompensations(projectId?: string): Promise<CompensationIntent[]> {
    await this.ready
    let q = this.db.selectFrom('share_link_compensations').selectAll().where('status', '=', 'failed')
    if (projectId) q = q.where('project_id', '=', projectId)
    const rows = await q.orderBy('generation', 'desc').execute()
    return rows.map(rowToCompensation)
  }

  /** R3-F2:全局未收敛计数(供 /readyz + 响应 header;轻量聚合不计列详情)。 */
  async getCompensationCounts(): Promise<{ pending: number; failed: number }> {
    await this.ready
    const rows = await this.db.selectFrom('share_link_compensations')
      .select(['status', (eb) => eb.fn.count('id').as('n')])
      .where('status', 'in', ['pending', 'failed'])
      .groupBy('status')
      .execute() as { status: string; n: string | number | bigint }[]
    let pending = 0
    let failed = 0
    for (const r of rows) {
      const n = Number(r.n)
      if (r.status === 'pending') pending = n
      else if (r.status === 'failed') failed = n
    }
    return { pending, failed }
  }

  /**
   * P1-2 启动恢复 derive:从 projects.is_deleted + share_links.cascade_revoked_at 派生 pending
   * (record 崩溃未建意图的兜底——marker durable,重启据此补建 pending 供 sweep 收敛)。
   *  - is_deleted=true 且有 active 链接 → record 'delete'(若已有 pending 同 op 幂等不重复)。
   *  - is_deleted=false 且有 30 天窗内 cascade 标记链接 → record 'restore'。
   * 查 projects 表(persist schema,同 DB;permission 层已经 FK 引用 + __seedProjectForTest 触及)。
   */
  async reconcileFromProjectState(): Promise<{ deleteRecorded: number; restoreRecorded: number }> {
    await this.ready
    const deletedProj = await sql`SELECT DISTINCT p.id AS pid FROM projects p
      WHERE p.is_deleted = true
        AND EXISTS (SELECT 1 FROM share_links sl WHERE sl.project_id = p.id AND sl.revoked_at IS NULL)`.execute(this.db)
    for (const row of deletedProj.rows as { pid: string }[]) {
      await this.recordCompensation(row.pid, 'delete')
    }
    const liveProj = await sql`SELECT DISTINCT p.id AS pid FROM projects p
      WHERE p.is_deleted = false
        AND EXISTS (SELECT 1 FROM share_links sl WHERE sl.project_id = p.id
                    AND sl.cascade_revoked_at IS NOT NULL
                    AND sl.cascade_revoked_at >= now() - (${UNREVOKE_WINDOW_MS}::bigint || ' milliseconds')::interval)`.execute(this.db)
    for (const row of liveProj.rows as { pid: string }[]) {
      await this.recordCompensation(row.pid, 'restore')
    }
    return { deleteRecorded: (deletedProj.rows as unknown[]).length, restoreRecorded: (liveProj.rows as unknown[]).length }
  }

  async sweepCompensations(): Promise<{ processed: number; converged: number; failed: number }> {
    await this.ready
    let processed = 0
    let converged = 0
    let failed = 0
    // 有界:snapshot pending(跳过未到期租约 + 超限放弃)后逐条 attempt。
    const now = new Date()
    const rows = await this.db.selectFrom('share_link_compensations').selectAll()
      .where('status', '=', 'pending')
      .where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<', now)]))
      .orderBy('generation', 'desc')
      .execute()
    for (const row of rows) {
      const it = rowToCompensation(row)
      if (it.attemptCount >= COMPENSATION_MAX_SWEEP_ATTEMPTS) {
        // R3-F2:超限放弃 → 'failed' dead-letter(不再伪装 done);保留可告警的未收敛事实,运维据 lastError 定因。
        //   不占 partial unique 槽(WHERE status='pending'),下一生命周期 primary record 新 pending 自动重开。
        await this.db.updateTable('share_link_compensations')
          .set({ status: 'failed', last_error: it.lastError ?? 'sweep max attempts exceeded', last_attempted_at: new Date(), updated_at: new Date() })
          .where('id', '=', it.id).where('status', '=', 'pending').execute()
        failed++
        continue
      }
      const r = await this.attemptCompensation(it.projectId, it.op)
      processed++
      if (r.kind === 'completed') converged++
      else if (r.kind === 'failed') failed++
    }
    return { processed, converged, failed }
  }

  // ── Test-only helpers(与 InMemoryPermissionBackend 对偶;双后端契约测试用)──────────────

  /** Test-only:清空权限三表(projects 表归 persist backend,不动;TRUNCATE 等效 DELETE,异步)。 */
  async __reset(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('share_link_compensations').execute()
      await trx.deleteFrom('share_links').execute()
      await trx.deleteFrom('project_members').execute()
    })
    // 故障注入计数也清(防跨用例泄漏)。
    delete this.compensationFault.restore
    delete this.compensationFault.delete
    delete this.compensationClaimPauseForTest.restore
    delete this.compensationClaimPauseForTest.delete
  }

  /** Test-only:把某 link 的 revoked_at 设为指定 ISO(测 30 天 un-revoke 窗;FX-7 §5.9;与内存实现对偶)。 */
  async __setLinkRevokedAtForTest(linkId: string, revokedAtIso: string): Promise<boolean> {
    const r = await this.db.updateTable('share_links').set({ revoked_at: new Date(revokedAtIso) }).where('id', '=', linkId).returning('id').executeTakeFirst()
    return !!r
  }
  /** Test-only:把某 link 的 cascade_revoked_at(P-6 marker)设为指定 ISO(测 cascade restore 30 天窗;与内存对偶)。 */
  async __setLinkCascadeRevokedAtForTest(linkId: string, iso: string): Promise<boolean> {
    const r = await this.db.updateTable('share_links').set({ cascade_revoked_at: new Date(iso) }).where('id', '=', linkId).returning('id').executeTakeFirst()
    return !!r
  }

  /**
   * Test-only:seed project 行(projects 表)供 FK 用。PG 契约测试 beforeEach 调之(权限表 project_id FK→projects.id)。
   * 用 raw SQL(projects 表不属 PermissionDatabase 类型;但同 DB,sql 模板直执行)。ON CONFLICT DO UPDATE
   * 重置 is_deleted=false(R3-F1:测试间隔离——前一用例可能 setProjectDeleted(true),beforeEach 须还原)。
   */
  async __seedProjectForTest(projectId: string, ownerId: string): Promise<void> {
    await sql`INSERT INTO projects (id, owner_id, is_deleted) VALUES (${projectId}, ${ownerId}, false)
      ON CONFLICT (id) DO UPDATE SET is_deleted = false, updated_at = now()`.execute(this.db)
  }

  /**
   * Test-only:设置 project 的 is_deleted durable desired state(R3-F1 真 PG 双向晚到 retry 验收用)。
   * 模拟 primary ensureCreate/softDeleteProjectTree 已提交(is_deleted 先于 recordCompensation)。
   * 与 memory 对偶(memory __setProjectDeletedForTest 为 no-op,memory 走 hasSuperseded)。
   */
  async __setProjectDeletedForTest(projectId: string, isDeleted: boolean): Promise<void> {
    await sql`UPDATE projects SET is_deleted = ${isDeleted}, updated_at = now() WHERE id = ${projectId}`.execute(this.db)
  }

  /** Test-only:注入 op 补偿步骤强制失败 N 次(消费在 attemptCompensation;不污染 unRevoke/revoke 本身;与内存对偶)。 */
  __setCompensationFaultForTest(op: CompensationOp, throwCount: number): void {
    this.compensationFault[op] = throwCount
  }
  /** Test-only:清除 op 补偿故障注入。 */
  __clearCompensationFaultForTest(op: CompensationOp): void {
    delete this.compensationFault[op]
  }
  /**
   * R3-F4 Test-only:注入 op 在 claim 后、side effect 前的 await 暂停点。模拟赢家超过 lease 暂停(供 race 验收:
   * A 暂停期间手动过期 A 的 lease,B 重新 claim 并 done;A 恢复后 pre-check/done WHERE token 失败 → stale-claim)。
   */
  __setClaimPauseForTest(op: CompensationOp, pauseFn: () => Promise<void>): void {
    this.compensationClaimPauseForTest[op] = pauseFn
  }
  /** Test-only:清除 claim 暂停点。 */
  __clearClaimPauseForTest(op: CompensationOp): void {
    delete this.compensationClaimPauseForTest[op]
  }
  /** R3-F4 Test-only:手动过期 (projectId,op) pending 意图的 lease(claimed_until 置过去),模拟赢家超过 lease。 */
  async __expireClaimLeaseForTest(projectId: string, op: CompensationOp): Promise<void> {
    await this.db.updateTable('share_link_compensations')
      .set({ claimed_until: new Date(Date.now() - 1000) })
      .where('project_id', '=', projectId).where('op', '=', op).where('status', '=', 'pending')
      .execute()
  }
}
