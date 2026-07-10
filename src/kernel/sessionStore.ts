// src/kernel/sessionStore.ts
// T1.2 S2:SessionStore user/session 域内存实现(selection CRUD,per user+canvas 隔离)。
// S1 钉 interface + throw 占位;S2 落 MemorySessionStore(?kernel=new 才消费,legacy 不读)。
// 权威:docs/decisions/record-schema.md(§4.1 DP-1、§4.3 DP-8 tasks)+ platform §13.1 user 域。
// 不接线 selectionSlice/cameraFocusStore;legacy 零行为变化(kernel=legacy 默认无感)。
//
// selection(DP-1):per user+canvas,session scope,不双写 document。键 canvasId+userId(隔离)。
// tasks(DP-8):document record 无 tasks 字段;迁服务端 registry(FX-2)。本实现只留 scope 标注占位。

/**
 * SessionStore:user/session 域(platform §13.1)。跨设备同步、按人隔离:简单 KV + LWW,不进 CRDT。
 * scope:selection(DP-1)+ tasks(DP-8,占位,实际服务端 registry)+ 相机/偏好/草稿(S2 不展开)。
 */
export interface SessionStore {
  // ── selection(DP-1)──
  getSelection(canvasId: string, userId: string): string[] | undefined
  setSelection(canvasId: string, userId: string, nodeIds: string[]): void
  clearSelection(canvasId: string, userId: string): boolean
  // ── tasks(DP-8,占位:实际迁服务端 registry,S2/S3 + FX-2 细化)──
  readonly tasksScopeNote: 'tasks → server registry (FX-2); not in document record (DP-8)'
}

/** selection KV key(canvasId+userId 隔离;真实部署按 §5 加 ${BASE}:${userId} 命名空间)。 */
const selectionKey = (canvasId: string, userId: string): string => `${canvasId}:${userId}`

/**
 * MemorySessionStore:默认内存实现(S2)。selection Map(per user+canvas 隔离)。
 * ?kernel=new 路径消费(S5 接线);legacy 不调用。
 */
export class MemorySessionStore implements SessionStore {
  private readonly selections = new Map<string, string[]>()

  getSelection(canvasId: string, userId: string): string[] | undefined {
    const s = this.selections.get(selectionKey(canvasId, userId))
    return s ? [...s] : undefined
  }
  setSelection(canvasId: string, userId: string, nodeIds: string[]): void {
    this.selections.set(selectionKey(canvasId, userId), [...nodeIds])
  }
  clearSelection(canvasId: string, userId: string): boolean {
    return this.selections.delete(selectionKey(canvasId, userId))
  }

  readonly tasksScopeNote = 'tasks → server registry (FX-2); not in document record (DP-8)'
}

/** 工厂:默认 MemorySessionStore。?kernel=new 路径消费(S5 接线);legacy 不调用。 */
export const createSessionStore = (): SessionStore => new MemorySessionStore()
