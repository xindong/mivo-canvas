// src/lib/serverPersistAdapter.ts
// T1.3 前置:PersistAdapter 接口(syncToServer 按 scope 路由的 TS 面)—— 返修版。
// 权威:docs/decisions/api-surface.md(返修版)。**不接线**——真正切换在 PG(T1.1)落地 + 服务器部署后
// (S6b persist adapter swap 同型)。本文件只冻结接口 + 与服务端契约的类型互锁。
//
// 类型共享互锁(lead §3 任务 #3 选项一):本接口的请求/响应类型直接引用 shared/
// persist-contract.ts——服务端路由(server/routes/*)也引用同一 shared 模块。任一侧改
// wire shape → 编译期 break(server↔client 互锁)。契约测试见 .contract.test.ts(返修 #5 Kernel↔Server 往返)。
//
// scope 路由(§0/§4):
//   document scope 方法 → /api/canvas(画布 record + chat 子资源)
//   user scope 方法     → /api/user-state(per-user KV)
//   asset scope         → /api/assets(T1.5 #195,返修 #8 seam 引用真实 shape)
//
// 返修要点:
//  - #5 fetchCanvas 返 metaRevision/contentVersion 分名;upsertNode baseRevision = envelope revision(If-Match)。
//  - #8 补 edge/anchor delete + canvas 枚举 + asset seam(引 #195 CreateAssetResponse/AssetRef,不重复实现)。

import type {
  CreateAssetResponse,
  GetCanvasResponse,
  ListCanvasResponse,
  ListProjectsResponse,
  Project,
  ResolvedAsset,
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
  /** 返修 #5:hydrate GET /api/canvas/:id(全量 meta + nodes/edges/anchors)。返 metaRevision + contentVersion。null=404。 */
  fetchCanvas(canvasId: string): Promise<GetCanvasResponse | null>
  /** 返修 #8:canvas 枚举(按 project/owner)。 */
  listCanvas(projectId?: string): Promise<ListCanvasResponse>
  /** 节点级 PATCH(FX-4);baseRevision = client 读到的 envelope revision(If-Match,返修 #4)。 */
  upsertNode(canvasId: string, node: NodeRecord, baseRevision?: Revision): Promise<UpsertResponse>
  upsertEdge(canvasId: string, edge: EdgeRecord, baseRevision?: Revision): Promise<UpsertResponse>
  upsertAnchor(canvasId: string, anchor: AnchorRecord, baseRevision?: Revision): Promise<UpsertResponse>
  /** 返修 #8:edge/anchor delete(硬删,对齐 #2)。 */
  deleteNode(canvasId: string, nodeId: string): Promise<void>
  deleteEdge(canvasId: string, edgeId: string): Promise<void>
  deleteAnchor(canvasId: string, anchorId: string): Promise<void>
  /**
   * 返修 #6/F5:重排子资源顺序(持久化 orderKey)。**If-Match(contentVersion base)必填**——
   * baseContentVersion = client 最近读到的 canvas contentVersion(若-Match);并发同 base 一成一 409。
   * 响应返新 contentVersion(client 据此作下次 reorder 的 If-Match base)。
   */
  reorderChildren(
    canvasId: string,
    type: 'node' | 'edge' | 'anchor' | 'chat-message',
    orderedIds: string[],
    baseContentVersion?: Revision,
  ): Promise<{ reordered: number; contentVersion: Revision }>

  // ── document scope → /api/canvas/:id/chat(DP-6)──
  appendChatMessage(canvasId: string, message: unknown): Promise<UpsertResponse>

  // ── user scope → /api/user-state(DP-1 selection / DP-7 排除)──
  putUserState(key: string, value: unknown, baseRevision?: Revision): Promise<UpsertResponse>
  getUserState(key: string): Promise<UserStateEntry | null>
  deleteUserState(key: string): Promise<void>

  // ── asset scope → /api/assets(T1.5 #195,返修 #8/N9 seam 引用真实 shape,不重复实现)──
  /**
   * POST /api/assets → CreateAssetResponse(#195 已实现真实 shape;内容寻址:同 content hash → 同 assetId,
   * refcount=references.length,bytes 复用)。
   */
  uploadAsset(bytes: Uint8Array, meta: { mimeType: string; originalName: string }): Promise<CreateAssetResponse>
  /**
   * 返修 N9:GET /api/assets/:id → 内容寻址 bytes + mime(**不返 AssetRef 元数据**)。
   * #195 head(0b945f4)真相:env gate(MIVO_ENABLE_ASSET_SERVICE=1,默认关 → 404)、owner 404(跨 owner GET → 404
   * 无泄漏)、Cache-Control: private、refcount=references.length。null=404(env off / 不存在 / 跨 owner)。
   */
  resolveAsset(assetId: string): Promise<ResolvedAsset | null>
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
  listCanvas: () => notWired('listCanvas'),
  upsertNode: () => notWired('upsertNode'),
  upsertEdge: () => notWired('upsertEdge'),
  upsertAnchor: () => notWired('upsertAnchor'),
  deleteNode: () => notWired('deleteNode'),
  deleteEdge: () => notWired('deleteEdge'),
  deleteAnchor: () => notWired('deleteAnchor'),
  reorderChildren: () => notWired('reorderChildren'),
  appendChatMessage: () => notWired('appendChatMessage'),
  putUserState: () => notWired('putUserState'),
  getUserState: () => notWired('getUserState'),
  deleteUserState: () => notWired('deleteUserState'),
  uploadAsset: () => notWired('uploadAsset'),
  resolveAsset: () => notWired('resolveAsset'),
}
