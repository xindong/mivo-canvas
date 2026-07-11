// server/lib/authz.ts
// T1.3 授权 seam(T1.4 扩 member/share + per-action 角色矩阵)。
// 权威:docs/decisions/api-surface.md §1(返修版)+ platform §13.5(归属模型)
// + docs/decisions/permission-schema.md §2(角色矩阵)+ docs/decisions/dp4-identity-alignment.md(身份载体)。
//
// T1.3:owner===actor → 所有 action allow(单资源 route resourceOwner 化)。
// T1.4:扩 project_members(role=editor/viewer)+ share_links(permission=view/edit)+ per-action 矩阵:
//   - owner:read/write/move/manage allow
//   - editor:read/write allow;move/manage deny
//   - viewer:read allow;write/move/manage deny
//   - share view:read allow;write/move/manage deny(≤ viewer)
//   - share edit:read/write allow;move/manage deny(≤ editor;链接不授 owner/manage/move)
//   - 非成员/无分享:deny(404 无存在泄漏;§1)
//
// 越权状态(boundary 3:不改 #194 wire 契约):
//   - 非成员/无分享 deny → 404 unknown-*(与 #194 一致,无存在泄漏)
//   - 成员/分享越权 deny → 403 forbidden(server-local body,不入 shared 契约;DP-4 R-4)
//
// canAccessProject/canAccessCanvas 是"检查点"——route 真调用(不许有定义无调用,N7);T1.4 扩其签名
// (接 AuthzInfo),route/契约 wire shape 不变(§1)。canAccessUserState 永不 share(§13.5),签名不变。

export type AuthzAction = 'read' | 'write' | 'move' | 'manage' // manage=T1.4 新增(member/share 管理 + delete,仅 owner)
export type AuthzDecision = 'allow' | 'deny'

const isKnownAction = (action: AuthzAction): boolean =>
  action === 'read' || action === 'write' || action === 'move' || action === 'manage'

// ── T1.4 角色与链接 permission(platform §13.5)──
export type ProjectRole = 'owner' | 'editor' | 'viewer'
export type SharePermission = 'view' | 'edit'

/**
 * 角色能否做某 action(permission-schema.md §2 矩阵)。
 * owner:全;editor:read/write;viewer:read。move/manage 仅 owner(FX-7 §5.12:editor 删 project → 403)。
 */
export const roleCan = (role: ProjectRole, action: AuthzAction): AuthzDecision => {
  if (!isKnownAction(action)) return 'deny'
  switch (role) {
    case 'owner':
      return 'allow'
    case 'editor':
      return action === 'read' || action === 'write' ? 'allow' : 'deny'
    case 'viewer':
      return action === 'read' ? 'allow' : 'deny'
    default:
      return 'deny'
  }
}

/**
 * 分享链接 permission 能否做某 action(≤ editor;永不授 owner/manage/move,§1.2 + 任务包"链接不授 owner")。
 * edit:read/write(≤ editor);view:read(≤ viewer)。
 */
export const shareCan = (perm: SharePermission, action: AuthzAction): AuthzDecision => {
  if (!isKnownAction(action)) return 'deny'
  switch (perm) {
    case 'edit':
      return action === 'read' || action === 'write' ? 'allow' : 'deny'
    case 'view':
      return action === 'read' ? 'allow' : 'deny'
    default:
      return 'deny'
  }
}

/**
 * T1.4 授权信息(route 经 PermissionBackend 解析后注入)。actor=null 表 share-only 访问(未认证,
 * 仅 share token)。ownerId = 资源 owner(project.ownerId / canvas.ownerId=project owner)。
 * memberRole:explicit member 行的 role(actor 模式);sharePermission:有效(非 revoked/expired)share token 的 permission。
 */
export type AuthzInfo = {
  actor: string | null
  ownerId: string
  memberRole?: ProjectRole
  sharePermission?: SharePermission
}

/**
 * 决策(派生 owner 优先 → member role → share permission → deny)。
 * 派生 owner:actor === ownerId(§3 派生优先;T1.3 owner===actor 自归属路径零变化,无需 member 行)。
 */
export const decideAccess = (info: AuthzInfo, action: AuthzAction): AuthzDecision => {
  if (!isKnownAction(action)) return 'deny'
  // 派生 owner(§3;保 T1.3 owner===actor 自归属:fallback 无 permission backend 时 owner 仍 allow)
  if (info.actor !== null && info.actor === info.ownerId) return roleCan('owner', action)
  if (info.memberRole) return roleCan(info.memberRole, action)
  if (info.sharePermission) return shareCan(info.sharePermission, action)
  return 'deny'
}

/**
 * deny 时的 HTTP 状态:成员/分享越权 → 403(知资源存在,缺角色);非成员/无分享 → 404(无存在泄漏,与 #194 一致)。
 */
export const denyStatus = (info: AuthzInfo): 403 | 404 =>
  info.memberRole !== undefined || info.sharePermission !== undefined ? 403 : 404

/**
 * project 访问授权(T1.4 扩:接 AuthzInfo,委托 decideAccess)。
 * @param info ownerId=project.ownerId;memberRole/sharePermission 由 route 经 PermissionBackend 解析。
 * route/契约 wire shape 不变(§1);检查点签名 T1.4 扩展(boundary:"权限在其 authz 检查点上扩展")。
 */
export const canAccessProject = (info: AuthzInfo, action: AuthzAction = 'read'): AuthzDecision =>
  decideAccess(info, action)

/**
 * canvas 访问授权(T1.4 扩:接 AuthzInfo)。canvas.ownerId === project.ownerId(画布随项目归属);
 * memberRole 经 project 查(projectId 从 canvas meta 取,见 routes/canvas.ts authzCanvas)。
 */
export const canAccessCanvas = (info: AuthzInfo, action: AuthzAction = 'read'): AuthzDecision =>
  decideAccess(info, action)

/**
 * user-state 访问授权(T1.4 不扩,§13.5 user-state 永不 share)。
 * per-owner KV:actor === ownerId → allow(签名不变,userState 路由不动)。
 */
export const canAccessUserState = (actor: string, ownerId: string, action: AuthzAction = 'read'): AuthzDecision =>
  actor === ownerId && isKnownAction(action) ? 'allow' : 'deny'
