// server/lib/permissions.ts
// T1.4 权限层后端:project_members(成员资格 owner/editor/viewer)+ share_links(分享链接 token+permission)。
// 权威:docs/decisions/permission-schema.md + platform §13.5 + docs/decisions/dp4-identity-alignment.md。
//
// 边界(boundary 2/3):
//  - **不**改 #194 persist-contract.ts / PersistBackend(InMemoryPersistBackend)——权限表不是 envelope record,
//    独立 PermissionBackend 接口;PG DDL 在 server/persist/migrations/001_permissions.sql(T1.3 worker apply + PG 实现)。
//  - 身份载体 = maker user id(= SSO username,DP-4);actor 由 routes 经 resolveActor 注入(已切 x-mivo-auth-user)。
//  - 成员资格是 owner 权威写(§13.5"仅 owner 可邀请"),非 CRDT LWW;无 revision。
//  - share_links 的"软删"= revoke(revoked_at,FX-7 §2);30 天 purge 由 FX-7 落地(P-1),本层不实现定时 purge。
//
// 设计同 PersistBackend:接口 + InMemory 实现同文件;PG 实现由 T1.3 worker 补(InMemoryPermissionBackend ↔ PgPermissionBackend 对偶)。
// 接口方法 async(Promise),保 PG swap 时签名不变(InMemory 返 resolved promise)。

import { randomUUID, randomBytes } from 'node:crypto'
import type { ProjectRole, SharePermission } from './authz'

/** 成员资格行(project_members)。owner 可由 projects.ownerId 派生(§3 派生优先),explicit 行多为 editor/viewer。 */
export type ProjectMember = {
  id: string
  projectId: string
  userId: string
  role: ProjectRole
  createdAt: string
  updatedAt: string
}

/** 分享链接行(share_links)。token 密码学随机不可枚举;revoked_at = FX-7 revoke 软删标记。 */
export type ShareLink = {
  id: string
  token: string
  projectId: string
  permission: SharePermission
  createdBy: string
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  expiresAt: string | null
}

/** share token 解析结果(供 route 区分 404 / 410)。 */
export type ShareResolution =
  | { kind: 'active'; permission: SharePermission }
  | { kind: 'revoked' }
  | { kind: 'expired' }

/** upsert member 结果。 */
export type UpsertMemberResult =
  | { ok: true; member: ProjectMember; created: boolean }
  | { ok: false; reason: 'is-owner' } // 拒绝显式插 owner 行(owner 派生,§3)

export type RemoveMemberResult = { ok: true; removed: ProjectMember } | { ok: false; reason: 'not-found' }
export type RevokeResult = { ok: true; link: ShareLink } | { ok: false; reason: 'not-found' | 'already-revoked' }
export type UnRevokeResult =
  | { ok: true; link: ShareLink }
  | { ok: false; reason: 'not-found' | 'window-closed' } // window-closed:revoke 超 30 天,不可恢复(FX-7 §5.9)

// ── P-6 saga 补偿(restore/delete 两步写:persist 恢复/软删 + permission unRevoke/revoke)──
// 问题:第二步失败留永久 revoked(delete 方向是 active)链接;且 POST/DELETE 幂等成功后不再重试第二步。
// 解:补偿意图落持久层(非内存变量),第二步失败可重试收敛;幂等重入补跑而非跳过。从简:无任务框架/通用队列。

/** 补偿 op:restore → unRevokeAllForProject 级联;delete → revokeAllForProject 级联。 */
export type CompensationOp = 'restore' | 'delete'

/**
 * 可观察补偿意图(持久层:跨请求存活;InMemory 重启清空同其它权限数据,PG 跨重启)。
 * attemptCount / lastError / lastAttemptedAt 是"可观察状态"——saga 不是黑盒,可查可调试。
 */
export type CompensationIntent = {
  id: string
  projectId: string
  op: CompensationOp
  status: 'pending' | 'done'
  attemptCount: number
  lastError: string | null
  lastAttemptedAt: string | null
  createdAt: string
  updatedAt: string
}

/** attemptCompensation 结果(可观察;route 用于日志)。 */
export type CompensationOutcome =
  | { kind: 'nothing-pending'; op: CompensationOp }
  | { kind: 'completed'; op: CompensationOp; count: number; attempts: number; intentId: string }
  | { kind: 'failed'; op: CompensationOp; error: string; attempts: number; intentId: string }

/** FX-7 §5.9 un-revoke 30 天保留窗(超期不可恢复,purge 由 FX-7 定时落地)。 */
export const UNREVOKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 权限层后端接口(成员 + 分享链接)。
 * routes 注入实现(InMemory 现状 / PG T1.3 worker);permission 不动 PersistBackend envelope 数据。
 */
export interface PermissionBackend {
  // ── 成员资格(project_members)──
  /**
   * 解析 actor 在 project 里的 effective role(DP-4 §3 派生优先)。
   * - userId === ownerUserId → 'owner'(派生,无需 member 行;保 T1.3 owner===actor 自归属)
   * - 否则查 explicit member 行(editor/viewer);无 → undefined
   * @param ownerUserId project.ownerId(派生 owner 判据;canvas 路由传 canvas.ownerId = project owner)
   */
  resolveMemberRole(projectId: string, userId: string, ownerUserId: string): Promise<ProjectRole | undefined>
  /** 列 project 全部成员(合成 owner 派生行 + explicit editor/viewer 行)。 */
  listMembers(projectId: string, ownerUserId: string): Promise<ProjectMember[]>
  /**
   * 加成员 / 改 role(upsert:同 (project,user) 已存在 → 改 role;否则插)。
   * 拒绝显式 'owner' role(owner 派生,§3;要转 owner 见 P-2 未实现)。
   * 注:actor 身份由 route 在 authz(manage,仅 owner)阶段校验,本方法不重复收。
   */
  upsertMember(projectId: string, userId: string, role: ProjectRole): Promise<UpsertMemberResult>
  /** 移除成员(硬删行;member 不软删,FX-7 §5 矩阵未列 member 软删)。 */
  removeMember(projectId: string, userId: string): Promise<RemoveMemberResult>
  /** 列 actor 被分享的 project + role(供 GET /api/projects 合并 owned + shared;不含派生 owner,owner 走 listByOwner)。 */
  listSharedProjects(userId: string): Promise<{ projectId: string; role: ProjectRole }[]>

  // ── 分享链接(share_links)──
  /** 建分享链接(token 密码学随机;permission ≤ edit;createdBy 须为 owner,route 校验)。 */
  createShareLink(projectId: string, permission: SharePermission, createdBy: string): Promise<ShareLink>
  /** 解析 token(供带 token 写访问)。projectId 校验:token 须属该 project。 */
  resolveShareLink(token: string, projectId: string): Promise<ShareResolution | undefined>
  /** 按 token 全局解析(公开入口 /api/share/:token,无 projectId)。返 projectId + permission + 活/吊销/过期。 */
  resolveShareLinkByToken(token: string): Promise<(ShareResolution & { projectId: string }) | undefined>
  /** 列 project 全部分享链接(owner 管理用;含 revoked)。 */
  listShareLinks(projectId: string): Promise<ShareLink[]>
  /** revoke(置 revoked_at;FX-7 §5.9:revoke 后 GET /share/:token → 410)。projectId 校验:link 须属该 project(防跨项目吊销,Greptile)。 */
  revokeShareLink(linkId: string, projectId: string): Promise<RevokeResult>
  /** un-revoke(清 revoked_at;FX-7 §5.9 30 天保留窗内)。projectId 校验 + 窗校验:超 30 天 → window-closed。 */
  unRevokeShareLink(linkId: string, projectId: string): Promise<UnRevokeResult>

  // ── FX-7 接缝(供 persist backend softDeleteProjectTree / restoreProjectTree 级联调用;本 PR 在 projects 路由调用)──
  /** revoke 某 project 全部分享链接(FX-7 project 软删级联用)。 */
  revokeAllForProject(projectId: string): Promise<{ count: number }>
  /** un-revoke 某 project 全部分享链接(FX-7 project 恢复级联用;30 天窗内才恢复)。 */
  unRevokeAllForProject(projectId: string): Promise<{ count: number }>

  // ── P-6 saga 补偿(restore/delete 第二步失败可重试收敛)──
  /**
   * 记录一条 pending 补偿意图。幂等:(projectId, op) 已有 pending → 返之(不重复);否则新建。
   * route 命中"刚发生真实级联"(POST restored / DELETE 软删成功)时调。
   */
  recordCompensation(projectId: string, op: CompensationOp): Promise<CompensationIntent>
  /**
   * 尝试收敛 (projectId, op) 的 pending 意图:无 pending → nothing-pending;有 pending → 跑 step
   * (restore=unRevokeAllForProject,delete=revokeAllForProject),成功标记 done,失败 bump 可观察字段保持 pending。
   * 幂等重入调用它收敛(route 在 restored/existing + DELETE 两路径都调)。
   */
  attemptCompensation(projectId: string, op: CompensationOp): Promise<CompensationOutcome>
  /** 可观察:列 project 全部补偿意图(newest first;调试/检查/验收用)。 */
  listCompensations(projectId: string): Promise<CompensationIntent[]>

  /** Test-only:清空。memory 同步 void;PG 异步 TRUNCATE(Promise<void>)。返回类型放宽,两类 backend 共用接口。 */
  __reset(): void | Promise<void>

  /**
   * backend 就绪 promise(memory 立即 resolve;PG 跑 migrations 建表)。app 启动(server/index.ts serve 前)
   * await 之,确保权限表已建。additive 字段——内存实现 Promise.resolve(),PG 落地后新增,路由/契约零改动。
   */
  readonly ready: Promise<void>
}

const nowIso = (): string => new Date().toISOString()

/** 密码学随机 token(256-bit,base64url ≈ 43 chars;不可枚举,§1.2)。 */
const generateShareToken = (): string => randomBytes(32).toString('base64url')

const isProjectRole = (v: unknown): v is ProjectRole =>
  v === 'owner' || v === 'editor' || v === 'viewer'
const isSharePermission = (v: unknown): v is SharePermission => v === 'view' || v === 'edit'

/**
 * InMemoryPermissionBackend:默认内存实现(T1.4 现状;PG 落地前用)。
 * 重启清空;角色矩阵 + 分享链接全链路测试过;跨重启持久不在验收范围(同 InMemoryPersistBackend)。
 *
 * 数据结构:
 *  - members:Map<projectId, Map<userId, ProjectMember>>(explicit editor/viewer 行;owner 不存,派生)
 *  - sharedByUser:Map<userId, Set<projectId>>(反查"我被分享的",listSharedProjects 用)
 *  - links:Map<linkId, ShareLink>;linksByToken:Map<token, linkId>;linksByProject:Map<projectId, linkId[]>
 */
export class InMemoryPermissionBackend implements PermissionBackend {
  private readonly members = new Map<string, Map<string, ProjectMember>>()
  private readonly sharedByUser = new Map<string, Set<string>>()
  private readonly links = new Map<string, ShareLink>()
  private readonly linksByToken = new Map<string, string>()
  private readonly linksByProject = new Map<string, string[]>()
  // P-6 saga 补偿意图存储(持久层:跨请求存活;重启清空同其它权限数据)。
  private readonly compensations = new Map<string, CompensationIntent>()
  private readonly compensationsByProject = new Map<string, string[]>() // newest first
  /** Test-only 故障注入:op → 剩余强制失败次数(attemptCompensation 内消费,不污染 unRevoke/revoke 本身)。 */
  private readonly compensationFault: Partial<Record<CompensationOp, number>> = {}
  /** additive(PG 落地后接口新增):内存 backend 立即就绪。 */
  readonly ready: Promise<void> = Promise.resolve()

  private memberBucket(projectId: string): Map<string, ProjectMember> {
    let b = this.members.get(projectId)
    if (!b) {
      b = new Map()
      this.members.set(projectId, b)
    }
    return b
  }
  private indexShared(userId: string, projectId: string): void {
    let s = this.sharedByUser.get(userId)
    if (!s) {
      s = new Set()
      this.sharedByUser.set(userId, s)
    }
    s.add(projectId)
  }
  private unindexShared(userId: string, projectId: string): void {
    this.sharedByUser.get(userId)?.delete(projectId)
  }

  async resolveMemberRole(projectId: string, userId: string, ownerUserId: string): Promise<ProjectRole | undefined> {
    // 派生 owner(§3;T1.3 owner===actor 自归属)
    if (userId === ownerUserId) return 'owner'
    return this.memberBucket(projectId).get(userId)?.role
  }

  async listMembers(projectId: string, ownerUserId: string): Promise<ProjectMember[]> {
    const explicit = [...this.memberBucket(projectId).values()]
    // 合成 owner 派生行(§3);explicit 行不含 owner(upsert 拒绝插 owner),故无重复
    const ownerRow: ProjectMember = {
      id: `derived:${projectId}:${ownerUserId}`,
      projectId,
      userId: ownerUserId,
      role: 'owner',
      createdAt: '', // owner 派生无独立时间;空串表"派生"
      updatedAt: '',
    }
    return [ownerRow, ...explicit]
  }

  async upsertMember(projectId: string, userId: string, role: ProjectRole): Promise<UpsertMemberResult> {
    // 拒绝显式 'owner' 行(owner 派生,§3);要改 owner 见 P-2
    if (role === 'owner') return { ok: false, reason: 'is-owner' }
    const bucket = this.memberBucket(projectId)
    const existing = bucket.get(userId)
    const now = nowIso()
    if (existing) {
      const updated: ProjectMember = { ...existing, role, updatedAt: now }
      bucket.set(userId, updated)
      return { ok: true, member: updated, created: false }
    }
    const member: ProjectMember = {
      id: randomUUID(),
      projectId,
      userId,
      role,
      createdAt: now,
      updatedAt: now,
    }
    bucket.set(userId, member)
    this.indexShared(userId, projectId)
    return { ok: true, member, created: true }
  }

  async removeMember(projectId: string, userId: string): Promise<RemoveMemberResult> {
    const bucket = this.memberBucket(projectId)
    const existing = bucket.get(userId)
    if (!existing) return { ok: false, reason: 'not-found' }
    bucket.delete(userId)
    this.unindexShared(userId, projectId)
    return { ok: true, removed: existing }
  }

  async listSharedProjects(userId: string): Promise<{ projectId: string; role: ProjectRole }[]> {
    const ids = this.sharedByUser.get(userId)
    if (!ids) return []
    const out: { projectId: string; role: ProjectRole }[] = []
    for (const pid of ids) {
      const m = this.memberBucket(pid).get(userId)
      if (m) out.push({ projectId: pid, role: m.role })
    }
    return out
  }

  async createShareLink(projectId: string, permission: SharePermission, createdBy: string): Promise<ShareLink> {
    const now = nowIso()
    const link: ShareLink = {
      id: randomUUID(),
      token: generateShareToken(),
      projectId,
      permission,
      createdBy,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
      expiresAt: null,
    }
    this.links.set(link.id, link)
    this.linksByToken.set(link.token, link.id)
    let arr = this.linksByProject.get(projectId)
    if (!arr) {
      arr = []
      this.linksByProject.set(projectId, arr)
    }
    arr.push(link.id)
    return link
  }

  async resolveShareLink(token: string, projectId: string): Promise<ShareResolution | undefined> {
    const id = this.linksByToken.get(token)
    if (!id) return undefined // 未知 token → undefined(route 返 404,无存在泄漏)
    const link = this.links.get(id)
    if (!link) return undefined
    if (link.projectId !== projectId) return undefined // token 不属此 project → 当未知处理(404,无泄漏)
    if (link.revokedAt) return { kind: 'revoked' } // FX-7 §5.9:revoke → 410
    if (link.expiresAt && Date.parse(link.expiresAt) < Date.now()) return { kind: 'expired' }
    return { kind: 'active', permission: link.permission }
  }

  async resolveShareLinkByToken(token: string): Promise<(ShareResolution & { projectId: string }) | undefined> {
    const id = this.linksByToken.get(token)
    if (!id) return undefined
    const link = this.links.get(id)
    if (!link) return undefined
    if (link.revokedAt) return { kind: 'revoked', projectId: link.projectId }
    if (link.expiresAt && Date.parse(link.expiresAt) < Date.now()) return { kind: 'expired', projectId: link.projectId }
    return { kind: 'active', projectId: link.projectId, permission: link.permission }
  }

  async listShareLinks(projectId: string): Promise<ShareLink[]> {
    const ids = this.linksByProject.get(projectId) ?? []
    return ids.map((id) => this.links.get(id)).filter((l): l is ShareLink => l !== undefined)
  }

  async revokeShareLink(linkId: string, projectId: string): Promise<RevokeResult> {
    const link = this.links.get(linkId)
    if (!link || link.projectId !== projectId) return { ok: false, reason: 'not-found' } // 跨项目 → not-found(无泄漏)
    if (link.revokedAt) return { ok: false, reason: 'already-revoked' }
    const revoked: ShareLink = { ...link, revokedAt: nowIso(), updatedAt: nowIso() }
    this.links.set(linkId, revoked)
    return { ok: true, link: revoked }
  }

  async unRevokeShareLink(linkId: string, projectId: string): Promise<UnRevokeResult> {
    const link = this.links.get(linkId)
    if (!link || link.projectId !== projectId) return { ok: false, reason: 'not-found' } // 跨项目 → not-found
    // FX-7 §5.9:un-revoke 30 天窗;超期不可恢复(purge 由 FX-7 定时)
    if (link.revokedAt && Date.now() - Date.parse(link.revokedAt) > UNREVOKE_WINDOW_MS) {
      return { ok: false, reason: 'window-closed' }
    }
    const unrevoked: ShareLink = { ...link, revokedAt: null, updatedAt: nowIso() }
    this.links.set(linkId, unrevoked)
    return { ok: true, link: unrevoked }
  }

  async revokeAllForProject(projectId: string): Promise<{ count: number }> {
    const ids = this.linksByProject.get(projectId) ?? []
    let count = 0
    const now = nowIso()
    for (const id of ids) {
      const link = this.links.get(id)
      if (link && !link.revokedAt) {
        this.links.set(id, { ...link, revokedAt: now, updatedAt: now })
        count++
      }
    }
    return { count }
  }

  async unRevokeAllForProject(projectId: string): Promise<{ count: number }> {
    const ids = this.linksByProject.get(projectId) ?? []
    let count = 0
    const now = nowIso()
    for (const id of ids) {
      const link = this.links.get(id)
      // 仅恢复 30 天窗内的 revoked link(FX-7 §5.9);超期保持 revoked(purge 由 FX-7 定时)
      if (link && link.revokedAt && Date.now() - Date.parse(link.revokedAt) <= UNREVOKE_WINDOW_MS) {
        this.links.set(id, { ...link, revokedAt: null, updatedAt: now })
        count++
      }
    }
    return { count }
  }

  // ── P-6 saga 补偿(实现)──

  /** 找 (projectId, op) 最近一条 pending 意图(无 → undefined)。 */
  private findPendingCompensation(projectId: string, op: CompensationOp): CompensationIntent | undefined {
    const ids = this.compensationsByProject.get(projectId) ?? []
    for (const id of ids) {
      const it = this.compensations.get(id)
      if (it && it.op === op && it.status === 'pending') return it
    }
    return undefined
  }

  async recordCompensation(projectId: string, op: CompensationOp): Promise<CompensationIntent> {
    // 幂等:已有 pending → 返之(不重复),防重入 POST restored 重复建意图。
    const pending = this.findPendingCompensation(projectId, op)
    if (pending) return pending
    const now = nowIso()
    const intent: CompensationIntent = {
      id: randomUUID(),
      projectId,
      op,
      status: 'pending',
      attemptCount: 0,
      lastError: null,
      lastAttemptedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.compensations.set(intent.id, intent)
    const arr = this.compensationsByProject.get(projectId) ?? []
    arr.unshift(intent.id) // newest first
    this.compensationsByProject.set(projectId, arr)
    return intent
  }

  async attemptCompensation(projectId: string, op: CompensationOp): Promise<CompensationOutcome> {
    const intent = this.findPendingCompensation(projectId, op)
    if (!intent) return { kind: 'nothing-pending', op }
    const now = nowIso()
    // Test-only 故障注入:在 attempt 内消费,不污染 unRevokeAllForProject / revokeAllForProject 本身。
    // 语义等价于"第二步抛错":decrement 后 throw,被本方法 catch → 记 failCompensationAttempt 可观察字段。
    const fault = this.compensationFault[op] ?? 0
    try {
      if (fault > 0) {
        this.compensationFault[op] = fault - 1
        throw new Error(`[compensation-fault] ${op} step forced failure (was ${fault})`)
      }
      const r = op === 'restore'
        ? await this.unRevokeAllForProject(projectId)
        : await this.revokeAllForProject(projectId)
      const done: CompensationIntent = {
        ...intent, status: 'done', attemptCount: intent.attemptCount + 1,
        lastError: null, lastAttemptedAt: now, updatedAt: now,
      }
      this.compensations.set(intent.id, done)
      return { kind: 'completed', op, count: r.count, attempts: done.attemptCount, intentId: intent.id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const failed: CompensationIntent = {
        ...intent, attemptCount: intent.attemptCount + 1,
        lastError: msg, lastAttemptedAt: now, updatedAt: now,
      }
      this.compensations.set(intent.id, failed)
      return { kind: 'failed', op, error: msg, attempts: failed.attemptCount, intentId: intent.id }
    }
  }

  async listCompensations(projectId: string): Promise<CompensationIntent[]> {
    const ids = this.compensationsByProject.get(projectId) ?? []
    return ids.map((id) => this.compensations.get(id)).filter((x): x is CompensationIntent => x !== undefined)
  }

  __reset(): void {
    this.members.clear()
    this.sharedByUser.clear()
    this.links.clear()
    this.linksByToken.clear()
    this.linksByProject.clear()
    this.compensations.clear()
    this.compensationsByProject.clear()
    // 故障注入计数也清(防跨用例泄漏)。
    delete this.compensationFault.restore
    delete this.compensationFault.delete
  }

  /** Test-only:把某 link 的 revokedAt 设为指定 ISO(测 30 天 un-revoke 窗;FX-7 §5.9)。 */
  __setLinkRevokedAtForTest(linkId: string, revokedAtIso: string): boolean {
    const link = this.links.get(linkId)
    if (!link) return false
    this.links.set(linkId, { ...link, revokedAt: revokedAtIso })
    return true
  }

  /** Test-only:注入 op 补偿步骤强制失败 N 次(消费在 attemptCompensation;不污染 unRevoke/revoke 本身)。 */
  __setCompensationFaultForTest(op: CompensationOp, throwCount: number): void {
    this.compensationFault[op] = throwCount
  }
  /** Test-only:清除 op 补偿故障注入。 */
  __clearCompensationFaultForTest(op: CompensationOp): void {
    delete this.compensationFault[op]
  }
}

export const createPermissionBackend = (): PermissionBackend => new InMemoryPermissionBackend()

// 运行时校验 helper(供 route 解码 member body 时复用,对齐 persistHttp decode* 模式)。
export { isProjectRole, isSharePermission }
