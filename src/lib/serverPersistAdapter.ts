// src/lib/serverPersistAdapter.ts
// T1.3 前置:PersistAdapter 接口(syncToServer 按 scope 路由的 TS 面)。
// 权威:docs/decisions/api-surface.md。**不接线**——真正切换在 PG(T1.1)落地 + 服务器部署后
// (S6b persist adapter swap 同型)。本文件只冻结接口 + 与服务端契约的类型互锁。
//
// 类型共享互锁(lead §3 任务 #3 选项一):本接口的请求/响应类型直接引用 shared/
// persist-contract.ts——服务端路由(server/routes/*)也引用同一 shared 模块。任一侧改
// wire shape → 编译期 break(server↔client 互锁)。契约测试见 .contract.test.ts。
//
// scope 路由(§0/§4):
//   document scope 方法 → /api/canvas(画布 record + chat 子资源)
//   user scope 方法     → /api/user-state(per-user KV)
//   asset scope         → /api/assets(T1.5,本文件不占位;asset 同步由 T1.5 adapter 定)
//
// payload 不透明(服务端 DP-5 jsonb);客户端 payload 域类型(NodeRecord 等)在 src/kernel/records。
// revision:per-record envelope revision(canonical);client PATCH 带 baseRevision 作 If-Match(§2)。

import type {
  GetCanvasResponse,
  ListProjectsResponse,
  Project,
  Revision,
  UpsertResponse,
  UserStateEntry,
} from '../../shared/persist-contract.ts'
import type { AnchorRecord, EdgeRecord, NodeRecord } from '../kernel/records'

/**
 * ServerPersistAdapter:client → server sync 接口,按 scope 路由(lead §3 任务 #3)。
 * 不接线(PG + 部署后兑现"换电脑原样在");本接口冻结 wire 面,与服务端契约类型共享互锁。
 */
export interface ServerPersistAdapter {
  // ── document scope → /api/projects ──
  listProjects(): Promise<ListProjectsResponse>
  createProject(name: string, id?: string): Promise<Project>

  // ── document scope → /api/canvas ──
  /** hydrate:GET /api/canvas/:id(全量 meta + nodes/edges/anchors,跨设备原样在)。null=404。 */
  fetchCanvas(canvasId: string): Promise<GetCanvasResponse | null>
  /** 节点级 PATCH(FX-4);baseRevision = client 读到的 envelope revision(If-Match)。 */
  upsertNode(canvasId: string, node: NodeRecord, baseRevision?: Revision): Promise<UpsertResponse>
  upsertEdge(canvasId: string, edge: EdgeRecord, baseRevision?: Revision): Promise<UpsertResponse>
  upsertAnchor(canvasId: string, anchor: AnchorRecord, baseRevision?: Revision): Promise<UpsertResponse>
  deleteNode(canvasId: string, nodeId: string): Promise<void>

  // ── document scope → /api/canvas/:id/chat(DP-6)──
  appendChatMessage(canvasId: string, message: unknown): Promise<UpsertResponse>

  // ── user scope → /api/user-state(DP-1 selection / DP-7 排除)──
  putUserState(key: string, value: unknown, baseRevision?: Revision): Promise<UpsertResponse>
  getUserState(key: string): Promise<UserStateEntry | null>
  deleteUserState(key: string): Promise<void>
}

/**
 * 未接线的 placeholder 实现。所有方法 reject(Karpathy 规则 12:fail visibly, not silently)——
 * PG + 服务器部署后换真 fetch 实现(同 S6b swap)。本 impl 仅满足接口 + 给未来 wiring 位
 * 一个"占位即失败"的默认,绝不静默成功(防误以为已同步)。
 */
const notWired = (method: string): Promise<never> =>
  Promise.reject(new Error(`ServerPersistAdapter.${method} not wired (T1.3 contract freeze; PG + server deploy pending)`))

export const unwiredServerPersistAdapter: ServerPersistAdapter = {
  listProjects: () => notWired('listProjects'),
  createProject: () => notWired('createProject'),
  fetchCanvas: () => notWired('fetchCanvas'),
  upsertNode: () => notWired('upsertNode'),
  upsertEdge: () => notWired('upsertEdge'),
  upsertAnchor: () => notWired('upsertAnchor'),
  deleteNode: () => notWired('deleteNode'),
  appendChatMessage: () => notWired('appendChatMessage'),
  putUserState: () => notWired('putUserState'),
  getUserState: () => notWired('getUserState'),
  deleteUserState: () => notWired('deleteUserState'),
}
