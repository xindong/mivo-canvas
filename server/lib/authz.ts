// server/lib/authz.ts
// T1.3 授权 seam(返修 #1)。
// 权威:docs/decisions/api-surface.md §1(返修版)+ platform §13.5(归属模型)。
//
// 返修 #1:拆 actorUserId 与 resourceOwnerId;get/list 经 owner/member/share 授权 seam 后取资源。
// seam 先只实现 owner===actor(T1.3);接口/查询路径按授权模型建,T1.4 只扩不改(加 project_members/share_links)。
// 未授权统一 404(无存在泄漏,§1);授权 seam 进契约测试(cross-owner 404、actor===resourceOwner allow)。
//
// 决策模型(platform §13.5):projects(ownerId) + project_members(role) + share_links(token,permission)。
// T1.3 只判 owner===actor;T1.4 扩 member/editor/viewer + share_link permission。

export type AuthzDecision = 'allow' | 'deny'

/**
 * project 访问授权(返修 #1)。
 * @param actor 调用方 user id(resolveActor)
 * @param projectOwnerId 资源归属 owner(backend project record.ownerId;project id 全局唯一)
 * T1.3:owner===actor → allow;T1.4 扩 project_members(role=editor/viewer)/share_links。
 */
export const canAccessProject = (actor: string, projectOwnerId: string | undefined): AuthzDecision =>
  projectOwnerId !== undefined && projectOwnerId === actor ? 'allow' : 'deny'

/**
 * canvas 访问授权(返修 #1)。
 * T1.3:canvas.ownerId === actor → allow;T1.4 扩(经 project member/share)。
 */
export const canAccessCanvas = (actor: string, canvasOwnerId: string): AuthzDecision =>
  actor === canvasOwnerId ? 'allow' : 'deny'

/**
 * user-state 访问授权(返修 #1)。
 * per-owner KV:actor === ownerId → allow(T1.4 不扩,user-state 永不 share)。
 */
export const canAccessUserState = (actor: string, ownerId: string): AuthzDecision =>
  actor === ownerId ? 'allow' : 'deny'
