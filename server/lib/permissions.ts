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
  /**
   * cascadeRevokedAt:P-6 marker——区分"级联 revoke"(project 软删/恢复级联)vs"手工 revoke"(用户主动吊销)。
   * revokeAllForProject(project 软删级联)置非空;unRevokeAllForProject(restore 级联)仅恢复此标记非空且 30 天窗内的
   * 链接并清空标记;手工 revokeShareLink 不置此列 → restore 补偿永不动手工吊销(防误恢复)。
   */
  cascadeRevokedAt: string | null
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
 *
 * 返修 P1-2/P2-1(2026-07-12):
 *  - generation:project 级单调递增 desired-state 代际;新 transition record 时 bump,旧 pending 对立 op
 *    被 markSuperseded——sweep/attempt 据最新代际决断(防 restore-fail→delete 后旧 restore 晚到重开链接)。
 *  - status 'superseded':被对立 op 的新代际取代;保留行做可观察历史,不再被 sweep/attempt 处理。
 *  - claimedAt/claimedUntil:attempt 租约(P2-1);并发 attempt 原子 claim,loser 返 already-claimed。
 */
export type CompensationIntent = {
  id: string
  projectId: string
  op: CompensationOp
  status: 'pending' | 'done' | 'superseded'
  generation: number
  attemptCount: number
  lastError: string | null
  lastAttemptedAt: string | null
  claimedAt: string | null
  claimedUntil: string | null
  createdAt: string
  updatedAt: string
}

/** attemptCompensation 的结果（可观察；route 用于日志）。 */
export type CompensationOutcome =
  | { kind: 'nothing-pending'; op: CompensationOp }
  | { kind: 'completed'; op: CompensationOp; count: number; attempts: number; intentId: string }
  | { kind: 'failed'; op: CompensationOp; error: string; attempts: number; intentId: string }
  | { kind: 'already-claimed'; op: CompensationOp; intentId: string } // P2-1:并发 attempt 输家
  | { kind: 'superseded'; op: CompensationOp; intentId?: string } // R3-F1:晚到 stale op（被更新代际/is_deleted 否决）→ 不重建、不执行副作用

/** FX-7 §5.9 un-revoke 30 天保留窗(超期不可恢复,purge 由 FX-7 定时落地)。 */
export const UNREVOKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 返修 P1-2/P2-1(2026-07-12):attempt 租约时长。并发 attempt 时,赢家 claim 后在此窗内输家返
 * already-claimed;到期后租约释放,可被 sweep/重试重新 claim(防赢家崩溃留永久 claimed 死锁)。
 * 取 15s:远大于单次 unRevoke/revoke 级联耗时(单语句,ms 级),又短到赢家崩溃后能快速被回收。
 */
export const COMPENSATION_CLAIM_LEASE_MS = 15 * 1000

/**
 * 返修 P1-2:有界 sweep——每条 pending 意图最多重试此次后放弃(超限 mark done 留 last_error)。
 * 防"永久 pending 黑洞":故障持续不退时,sweep 不会无限重打;留 last_error 给运维定位。
 */
export const COMPENSATION_MAX_SWEEP_ATTEMPTS = 10

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

  /**
   * 返修 P1-2:可观察 pending 信号——列全局(或某 project)未收敛补偿意图(含租约信息)。
   * 供 /readyz 类指标 / sweep driver 调度用;形态你定(memory: 同步过滤;PG: SELECT status='pending')。
   */
  listPendingCompensations(projectId?: string): Promise<CompensationIntent[]>

  /**
   * 返修 P1-2:有界后台 sweep driver——启动恢复 + 周期退避重试的收敛入口。遍历 pending 意图(跳过
   * superseded + 未到期租约),逐条 attemptCompensation 收敛。返处理统计 {processed, converged, failed}。
   * memory: 同步遍历(无重启语义,主要供测试);PG: 跨重启恢复(pending 跨请求/重启存活)。
   * 有界:每条意图有最大重试上限(超限 mark done 留 last_error,不再重试)。
   */
  sweepCompensations(): Promise<{ processed: number; converged: number; failed: number }>

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
  /** Test-only:op → 剩余 recordCompensation 强制失败次数(P1-1 验收:record 崩溃后 attempt 据 marker 收敛)。 */
  private readonly compensationRecordFault: Partial<Record<CompensationOp, number>> = {}
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
      cascadeRevokedAt: null, // P-6 marker:仅级联 revoke 置非空;新建链接无标记
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
    const unrevoked: ShareLink = { ...link, revokedAt: null, cascadeRevokedAt: null, updatedAt: nowIso() }
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
        // 级联 revoke:置 revoked_at + cascade_revoked_at(marker)。restore 补偿只动此标记非空的链接。
        this.links.set(id, { ...link, revokedAt: now, cascadeRevokedAt: now, updatedAt: now })
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
      // P-6 marker:仅恢复"级联 revoke"标记(cascadeRevokedAt 非空)且 30 天窗内的链接,并清空 marker。
      // 手工 revoke(cascadeRevokedAt IS NULL)永不被 restore 补偿动 → 防误恢复用户主动吊销的链接。
      if (link && link.cascadeRevokedAt && Date.now() - Date.parse(link.cascadeRevokedAt) <= UNREVOKE_WINDOW_MS) {
        this.links.set(id, { ...link, revokedAt: null, cascadeRevokedAt: null, updatedAt: now })
        count++
      }
    }
    return { count }
  }

  // ── P-6 saga 补偿(实现)──
  // 返修 P1-1/P1-2/P2-1(2026-07-12 双审):marker-driven + supersede + claim/lease + sweep。
  //   - marker:cascade_revoked_at(级联 revoke 标记)是 desired-state 的可重建载体,落在 share_links
  //     (随第一步级联一起提交);record 步骤即使崩溃,marker 已 durable 提交 → 重启/重试据 marker 收敛。
  //   - supersede:record 新 op 时 bump generation 并把 pending 对立 op markSuperseded —— sweep/attempt
  //     只认 pending(跳过 superseded),防 restore-fail→delete 后旧 restore 晚到重开链接(P1-2 代际)。
  //   - claim/lease:attempt 原子 claim(单线程 JS 同步段内 check+set);并发输家返 already-claimed(P2-1)。
  //   - sweep:有界遍历 pending(跳过未到期租约 + 超限放弃),逐条 attempt 收敛(P1-2 driver)。

  /** 找 (projectId, op) 最近一条 pending 意图(无 → undefined)。 */
  private findPendingCompensation(projectId: string, op: CompensationOp): CompensationIntent | undefined {
    const ids = this.compensationsByProject.get(projectId) ?? []
    for (const id of ids) {
      const it = this.compensations.get(id)
      if (it && it.op === op && it.status === 'pending') return it
    }
    return undefined
  }

  /**
   * R3-F1: (projectId, op) 是否存在被显式 supersede 的意图(对立 op 的新代际曾 record 并 supersede 它)。
   * 用于晚到 attemptCompensation 的 stale-op 判定:若 op 已被对立 op 取代,晚到重试不得仅凭 marker 重建
   * 旧 op intent(会把更新代际的 revoked/active 终态翻转回来)。memory 无 projects.is_deleted,以此信号
   * 替代——它精确区分"被显式 supersede 的 stale 重试(F1)"与"record 崩溃后的 marker 自恢复(P1-1,无 supersede 行)"。
   */
  private hasSupersededCompensation(projectId: string, op: CompensationOp): boolean {
    const ids = this.compensationsByProject.get(projectId) ?? []
    for (const id of ids) {
      const it = this.compensations.get(id)
      if (it && it.op === op && it.status === 'superseded') return true
    }
    return false
  }

  /** project 级下一代际 = 现存全部意图(任意状态)max(generation)+1。单调递增,保证新 transition 代际 > 旧。 */
  private nextGeneration(projectId: string): number {
    const ids = this.compensationsByProject.get(projectId) ?? []
    let max = 0
    for (const id of ids) {
      const it = this.compensations.get(id)
      if (it && it.generation > max) max = it.generation
    }
    return max + 1
  }

  /** 把 (projectId, 对立 op) 的 pending 意图 markSuperseded(保留行做历史;不再被 sweep/attempt 处理)。 */
  private supersedeOppositePending(projectId: string, op: CompensationOp): void {
    const opposite: CompensationOp = op === 'restore' ? 'delete' : 'restore'
    const stale = this.findPendingCompensation(projectId, opposite)
    if (!stale) return
    const now = nowIso()
    this.compensations.set(stale.id, {
      ...stale,
      status: 'superseded',
      lastError: `superseded by ${op} generation`,
      claimedAt: null,
      claimedUntil: null,
      updatedAt: now,
    })
  }

  /** 建 pending 意图(内部:不查幂等,调用方负责)。 */
  private createPendingIntent(projectId: string, op: CompensationOp, generation: number): CompensationIntent {
    const now = nowIso()
    const intent: CompensationIntent = {
      id: randomUUID(),
      projectId,
      op,
      status: 'pending',
      generation,
      attemptCount: 0,
      lastError: null,
      lastAttemptedAt: null,
      claimedAt: null,
      claimedUntil: null,
      createdAt: now,
      updatedAt: now,
    }
    this.compensations.set(intent.id, intent)
    const arr = this.compensationsByProject.get(projectId) ?? []
    arr.unshift(intent.id) // newest first
    this.compensationsByProject.set(projectId, arr)
    return intent
  }

  /**
   * marker-driven need:restore → 存在 cascade 标记(cascadeRevokedAt 非空)且 30 天窗内的链接(需 unRevoke);
   * delete → 存在 active 链接(revokedAt IS NULL,需 revoke;调用方 route/sweep 保证 project 已软删)。
   * 用于"record 崩溃后重试/重启"场景:无 pending 意图但 marker 表明补偿未完成 → attempt 自建意图收敛。
   * 普通幂等 POST(existing,从未级联)→ 无 marker → need=false → nothing-pending,不动手工 revoked link。
   */
  private compensationNeed(projectId: string, op: CompensationOp): boolean {
    const ids = this.linksByProject.get(projectId) ?? []
    for (const id of ids) {
      const link = this.links.get(id)
      if (!link) continue
      if (op === 'restore') {
        if (link.cascadeRevokedAt && Date.now() - Date.parse(link.cascadeRevokedAt) <= UNREVOKE_WINDOW_MS) return true
      } else {
        if (!link.revokedAt) return true
      }
    }
    return false
  }

  async recordCompensation(projectId: string, op: CompensationOp): Promise<CompensationIntent> {
    // P1-1 Test-only:record 故障注入(模拟"第一步提交后、record 前崩溃")。route 已 try/catch 包裹 →
    // 不阻断主操作;attempt 据 cascade_revoked_at marker 自收敛(无 pending 意图也能 derive)。
    const rf = this.compensationRecordFault[op] ?? 0
    if (rf > 0) {
      this.compensationRecordFault[op] = rf - 1
      throw new Error(`[compensation-record-fault] ${op} record forced failure (was ${rf})`)
    }
    // 幂等:已有 pending 同 op → 返之(不重复),防重入 POST restored 重复建意图。
    const pending = this.findPendingCompensation(projectId, op)
    if (pending) return pending
    // P1-2 supersede:新 transition 取代旧 pending 对立 op(防旧 restore 晚到重开链接)。
    this.supersedeOppositePending(projectId, op)
    return this.createPendingIntent(projectId, op, this.nextGeneration(projectId))
  }

  async attemptCompensation(projectId: string, op: CompensationOp): Promise<CompensationOutcome> {
    const now = nowIso()
    let intent = this.findPendingCompensation(projectId, op)
    // R3-F1: stale-op gate。晚到的 attemptCompensation 不得仅凭 compensationNeed 重建旧 op intent——
    // 那会把更新代际对立 op 的 revoked/active 终态翻转回来(权限边界破坏)。durable desired state 决断:
    //   memory 无 projects.is_deleted → 用"op 是否被对立 op 的新代际显式 supersede"(hasSuperseded)。
    //   仅在无 fresh pending intent 时判 stale(pending intent 存在 = op 是当前代际,非 stale)。
    //   P1-1 marker 自恢复(无 supersede 行)不受影响:hasSuperseded=false → 继续据 marker derive。
    if (!intent && this.hasSupersededCompensation(projectId, op)) {
      return { kind: 'superseded', op }
    }
    // P1-1 crash-recovery:record 崩溃未建意图,但 marker 表明补偿未完成 → 自建 pending 收敛。
    const need = this.compensationNeed(projectId, op)
    if (!intent && !need) return { kind: 'nothing-pending', op }
    if (!intent) intent = this.createPendingIntent(projectId, op, this.nextGeneration(projectId))
    // P2-1 claim/lease:已被未到期租约占用 → 输家返 already-claimed(单线程 JS:check+set 同步段原子)。
    if (intent.claimedUntil && Date.parse(intent.claimedUntil) > Date.now()) {
      return { kind: 'already-claimed', op, intentId: intent.id }
    }
    const leaseUntil = new Date(Date.now() + COMPENSATION_CLAIM_LEASE_MS).toISOString()
    const claimed: CompensationIntent = { ...intent, claimedAt: now, claimedUntil: leaseUntil, updatedAt: now }
    this.compensations.set(intent.id, claimed)
    const attempts = claimed.attemptCount + 1
    // Test-only 故障注入:在 attempt 内消费,不污染 unRevokeAllForProject / revokeAllForProject 本身。
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
        ...claimed, status: 'done', attemptCount: attempts,
        lastError: null, lastAttemptedAt: now, claimedAt: null, claimedUntil: null, updatedAt: now,
      }
      this.compensations.set(intent.id, done)
      return { kind: 'completed', op, count: r.count, attempts: done.attemptCount, intentId: intent.id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const failed: CompensationIntent = {
        ...claimed, attemptCount: attempts,
        lastError: msg, lastAttemptedAt: now, claimedAt: null, claimedUntil: null, updatedAt: now,
      }
      this.compensations.set(intent.id, failed)
      return { kind: 'failed', op, error: msg, attempts: failed.attemptCount, intentId: intent.id }
    }
  }

  async listCompensations(projectId: string): Promise<CompensationIntent[]> {
    const ids = this.compensationsByProject.get(projectId) ?? []
    return ids.map((id) => this.compensations.get(id)).filter((x): x is CompensationIntent => x !== undefined)
  }

  async listPendingCompensations(projectId?: string): Promise<CompensationIntent[]> {
    const out: CompensationIntent[] = []
    const projects = projectId ? [projectId] : [...this.compensationsByProject.keys()]
    for (const pid of projects) {
      const ids = this.compensationsByProject.get(pid) ?? []
      for (const id of ids) {
        const it = this.compensations.get(id)
        if (it && it.status === 'pending') out.push(it)
      }
    }
    return out
  }

  async sweepCompensations(): Promise<{ processed: number; converged: number; failed: number }> {
    let processed = 0
    let converged = 0
    let failed = 0
    // 有界:snapshot pending 列表后逐条 attempt(跳过未到期租约——并发 attempt/sweep 不抢)。
    const pending = await this.listPendingCompensations()
    for (const it of pending) {
      if (it.claimedUntil && Date.parse(it.claimedUntil) > Date.now()) continue // 租约未到期,跳过
      if (it.attemptCount >= COMPENSATION_MAX_SWEEP_ATTEMPTS) {
        // 超限放弃:mark done 留 last_error(防永久 pending 黑洞;运维据 lastError 定位)。
        const now = nowIso()
        this.compensations.set(it.id, { ...it, status: 'done', lastError: it.lastError ?? 'sweep max attempts exceeded', lastAttemptedAt: now, updatedAt: now })
        failed++
        continue
      }
      const r = await this.attemptCompensation(it.projectId, it.op)
      processed++
      if (r.kind === 'completed') converged++
      else if (r.kind === 'failed') failed++
      // already-claimed / nothing-pending:不计入 processed 的收敛/失败(sweep 视角非错误)
    }
    return { processed, converged, failed }
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
    delete this.compensationRecordFault.restore
    delete this.compensationRecordFault.delete
  }

  /** Test-only:把某 link 的 revokedAt 设为指定 ISO(测 30 天 un-revoke 窗;FX-7 §5.9)。 */
  __setLinkRevokedAtForTest(linkId: string, revokedAtIso: string): boolean {
    const link = this.links.get(linkId)
    if (!link) return false
    this.links.set(linkId, { ...link, revokedAt: revokedAtIso })
    return true
  }
  /** Test-only:把某 link 的 cascadeRevokedAt(P-6 marker)设为指定 ISO(测 cascade restore 30 天窗)。 */
  __setLinkCascadeRevokedAtForTest(linkId: string, iso: string): boolean {
    const link = this.links.get(linkId)
    if (!link) return false
    this.links.set(linkId, { ...link, cascadeRevokedAt: iso })
    return true
  }

  /**
   * Test-only:设置 project 的 is_deleted durable desired state。
   * memory backend 不持有 projects 表(is_deleted 不归权限层),此 helper 为 no-op——
   * memory 的 stale-op 判定走 hasSuperseded(见 attemptCompensation)。PG 对偶实现真正改 projects.is_deleted。
   * 双后端契约套件对两后端同形调用,保证对称性(memory 忽略、PG 生效,结果一致)。
   */
  __setProjectDeletedForTest(_projectId: string, _isDeleted: boolean): void {
    /* no-op: memory 无 projects 表 */
  }

  /** Test-only:注入 op 补偿步骤强制失败 N 次(消费在 attemptCompensation;不污染 unRevoke/revoke 本身)。 */
  __setCompensationFaultForTest(op: CompensationOp, throwCount: number): void {
    this.compensationFault[op] = throwCount
  }
  /** Test-only:清除 op 补偿故障注入。 */
  __clearCompensationFaultForTest(op: CompensationOp): void {
    delete this.compensationFault[op]
  }
  /** Test-only:注入 op recordCompensation 强制失败 N 次(P1-1:第一步提交后 record 崩溃)。 */
  __setRecordFaultForTest(op: CompensationOp, throwCount: number): void {
    this.compensationRecordFault[op] = throwCount
  }
  /** Test-only:清除 op record 故障注入。 */
  __clearRecordFaultForTest(op: CompensationOp): void {
    delete this.compensationRecordFault[op]
  }
}

export const createPermissionBackend = (): PermissionBackend => new InMemoryPermissionBackend()

// 运行时校验 helper(供 route 解码 member body 时复用,对齐 persistHttp decode* 模式)。
export { isProjectRole, isSharePermission }
