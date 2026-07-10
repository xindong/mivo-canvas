// src/kernel/sessionStore.ts
// T1.2 S1 纯脚手架:SessionStore 域骨架(interface,不实现)。S2 落内存实现。
// 权威:docs/decisions/record-schema.md(§4.1 DP-1、§4.3 DP-8 tasks)+ platform §13.1 user 域。
// 本文件只钉接口形状 + scope 标注;不接线 selectionSlice/cameraFocusStore,legacy 零行为变化。

/**
 * SessionStore:user/session 域(platform §13.1)。
 * 跨设备同步、按人隔离:简单 KV + LWW,不进 CRDT。
 *
 * 归属(裁决):
 * - selection(DP-1):从 CanvasDocument 迁出,归 session/per-user,不双写 document。键 canvasId+userId。
 * - tasks(DP-8):document record 无 tasks 字段;tasks 迁服务端 registry(FX-2 per-user)。
 *   S1 只留 tasks 接口形状占位(实际由 S2/S3 + 服务端 registry 实现)。
 * - 相机/最近打开/工具偏好/面板开合/聊天草稿:同 user 域,本接口不展开(S2/S3 按需扩)。
 *
 * S1 只钉接口;S2 实现内存 store(经 ?kernel=new 才被消费,legacy 不读)。
 */
export interface SessionStore {
  // ── selection(DP-1)──
  getSelection(canvasId: string, userId: string): string[] | undefined
  setSelection(canvasId: string, userId: string, nodeIds: string[]): void
  clearSelection(canvasId: string, userId: string): void

  // ── tasks(DP-8,占位:实际迁服务端 registry,S2/S3 + FX-2 细化)──
  // tasks 不进 document record;此处只钉 scope 标注,实现随 T1.3 + FX-2。
  readonly tasksScopeNote: 'tasks → server registry (FX-2); not in document record (DP-8)'
}

/**
 * 工厂:S2 提供内存实现。S1 占位 throw(同 createDocKernel,确保 legacy 不误用)。
 */
export const createSessionStore = (): SessionStore => {
  throw new Error('createSessionStore: T1.2 S2 未实现(S1 仅脚手架)。kernel=legacy 默认不消费本路径。')
}
