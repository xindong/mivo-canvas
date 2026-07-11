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
} from '../lib/permissions'
import { UNREVOKE_WINDOW_MS } from '../lib/permissions'
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
}
interface PermissionDatabase {
  project_members: ProjectMembersTable
  share_links: ShareLinksTable
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
      // revoked(窗内)或 active(幂等)→ SET revoked_at=null(returning;原子)。
      const upd = await trx
        .updateTable('share_links')
        .set({ revoked_at: null, updated_at: new Date() })
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
    // 单语句原子:UPDATE WHERE project_id+revoked_at IS NULL RETURNING id → count=返行数(只 revoke 活的)。
    const rows = await this.db
      .updateTable('share_links')
      .set({ revoked_at: new Date(), updated_at: new Date() })
      .where('project_id', '=', projectId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute()
    return { count: rows.length }
  }

  async unRevokeAllForProject(projectId: string): Promise<{ count: number }> {
    await this.ready
    // 单语句原子:WHERE project_id + revoked 非空 + 窗内(revoked_at >= now-30d)→ SET revoked_at=null RETURNING id。
    // 窗判定用 TS 算的 cutoff 日期(Date.now()-30d,与内存 Date.now 等价),全 typed;无 raw SQL 布尔 where 类型坑。
    const cutoff = new Date(Date.now() - UNREVOKE_WINDOW_MS)
    const rows = await this.db
      .updateTable('share_links')
      .set({ revoked_at: null, updated_at: new Date() })
      .where('project_id', '=', projectId)
      .where('revoked_at', 'is not', null)
      .where('revoked_at', '>=', cutoff)
      .returning('id')
      .execute()
    return { count: rows.length }
  }

  // ── Test-only helpers(与 InMemoryPermissionBackend 对偶;双后端契约测试用)──────────────

  /** Test-only:清空权限两表(projects 表归 persist backend,不动;TRUNCATE 等效 DELETE,异步)。 */
  async __reset(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('share_links').execute()
      await trx.deleteFrom('project_members').execute()
    })
  }

  /** Test-only:把某 link 的 revoked_at 设为指定 ISO(测 30 天 un-revoke 窗;FX-7 §5.9;与内存实现对偶)。 */
  async __setLinkRevokedAtForTest(linkId: string, revokedAtIso: string): Promise<boolean> {
    const r = await this.db.updateTable('share_links').set({ revoked_at: new Date(revokedAtIso) }).where('id', '=', linkId).returning('id').executeTakeFirst()
    return !!r
  }

  /**
   * Test-only:seed project 行(projects 表)供 FK 用。PG 契约测试 beforeEach 调之(权限表 project_id FK→projects.id)。
   * 用 raw SQL(projects 表不属 PermissionDatabase 类型;但同 DB,sql 模板直执行)。ON CONFLICT DO NOTHING 幂等。
   */
  async __seedProjectForTest(projectId: string, ownerId: string): Promise<void> {
    await sql`INSERT INTO projects (id, owner_id, is_deleted) VALUES (${projectId}, ${ownerId}, false) ON CONFLICT (id) DO NOTHING`.execute(this.db)
  }
}
