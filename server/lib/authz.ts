// server/lib/authz.ts
// T1.3 授权 seam(返修 #1 + N7 真接线)。
// 权威:docs/decisions/api-surface.md §1(返修版)+ platform §13.5(归属模型)。
//
// 返修 #1/N7:拆 actorUserId 与 resourceOwnerId;get/list 经 owner/member/share 授权 seam 后取资源。
// N7:action-aware(read/write/move)authz,判 source + target(move 时)。T1.3 owner===actor → 所有 action allow
// (接口/查询路径按授权模型建,T1.4 只扩不改:加 member/share + per-action 差异)。
// 未授权统一 404(无存在泄漏,§1);授权 seam 进契约测试(cross-owner 404、actor===resourceOwner allow)。
// canAccess* 必须 route 真调用(不许有定义无调用,N7)。
//
// 决策模型(platform §13.5):projects(ownerId) + project_members(role) + share_links(token,permission)。
// T1.3 只判 owner===actor;T1.4 扩 member/editor/viewer + share_link permission + per-action。

export type AuthzAction = 'read' | 'write' | 'move'
export type AuthzDecision = 'allow' | 'deny'

const isKnownAction = (action: AuthzAction): boolean =>
  action === 'read' || action === 'write' || action === 'move'

/**
 * project 访问授权(返修 #1/N7 action-aware)。
 * @param actor 调用方 user id(resolveActor)
 * @param projectOwnerId 资源归属 owner(backend project record.ownerId;project id 全局唯一)
 * @param action read=get;write=PATCH/POST/DELETE;move=PUT canvas projectId 跨 project。
 * T1.3:owner===actor → allow(所有 known action);T1.4 扩 project_members(role=editor/viewer)/share_links + per-action。
 */
export const canAccessProject = (
  actor: string,
  projectOwnerId: string | undefined,
  action: AuthzAction = 'read',
): AuthzDecision =>
  projectOwnerId !== undefined && projectOwnerId === actor && isKnownAction(action) ? 'allow' : 'deny'

/**
 * canvas 访问授权(返修 #1/N7 action-aware)。
 * @param action read=get/list;write=PATCH child/POST chat/DELETE;move=PUT projectId 改(move 双端:source canvas + target project)。
 * T1.3:canvas.ownerId === actor → allow(所有 known action);T1.4 扩(经 project member/share)。
 */
export const canAccessCanvas = (actor: string, canvasOwnerId: string, action: AuthzAction = 'read'): AuthzDecision =>
  actor === canvasOwnerId && isKnownAction(action) ? 'allow' : 'deny'

/**
 * user-state 访问授权(返修 #1/N7)。
 * per-owner KV:actor === ownerId → allow(T1.4 不扩,user-state 永不 share)。
 */
export const canAccessUserState = (actor: string, ownerId: string, action: AuthzAction = 'read'): AuthzDecision =>
  actor === ownerId && isKnownAction(action) ? 'allow' : 'deny'
