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
  AttachAssetResult,
  CreateAssetResponse,
  CreateCanvasResponse,
  DetachAssetResult,
  GetCanvasResponse,
  ListCanvasResponse,
  ListChatMessagesResponse,
  ListProjectsResponse,
  Project,
  ResolvedAsset,
  Revision,
  UpdateCanvasRequest,
  UpsertResponse,
  UserStateEntry,
} from '../../shared/persist-contract.ts'
import type { AnchorRecord, EdgeRecord, NodeRecord } from '../kernel/records'
// G1-a:wire 期需要的 runtime 常量(纯数据,无副作用)。IF_MATCH/IDEMPOTENCY_KEY 用于构造请求头;
// 不改契约语义,只按 shared 既有常量拼 wire shape(防字符串漂移,与 server/lib/persistHttp 同源)。
import { IF_MATCH_HEADER, IDEMPOTENCY_KEY_HEADER } from '../../shared/persist-contract.ts'

/**
 * ServerPersistAdapter:client → server sync 接口,按 scope 路由(lead §3 任务 #3)。
 * 不接线(PG + 部署后兑现"换电脑原样在");本接口冻结 wire 面,与服务端契约类型共享互锁。
 */
export interface ServerPersistAdapter {
  // ── document scope → /api/projects ──
  listProjects(): Promise<ListProjectsResponse>
  createProject(name: string, id?: string): Promise<Project>
  /** G1-a P1-2:GET /api/projects/:id → Project;404(unknown/unauthorized)→ null。 */
  getProject(id: string): Promise<Project | null>
  /** G1-a P1-2:PATCH /api/projects/:id,body { name },If-Match = revision base;返更新后 Project。 */
  updateProject(id: string, name: string, baseRevision?: Revision): Promise<Project>
  /** G1-a P1-2:DELETE /api/projects/:id → 204(幂等);404 → 视为已删(void,幂等)。 */
  deleteProject(id: string): Promise<void>

  // ── document scope → /api/canvas ──
  /** 返修 #5:hydrate GET /api/canvas/:id(全量 meta + nodes/edges/anchors)。返 metaRevision + contentVersion。null=404。 */
  fetchCanvas(canvasId: string): Promise<GetCanvasResponse | null>
  /** 返修 #8:canvas 枚举(按 project/owner)。 */
  listCanvas(projectId?: string): Promise<ListCanvasResponse>
  /** G1-a P1-2:POST /api/canvas → 201/200 CanvasMeta(createCanvas meta CRUD)。 */
  createCanvas(input: { projectId: string; id?: string; title?: string; sourceTemplateId?: string }): Promise<CreateCanvasResponse>
  /** G1-a P1-2:PUT /api/canvas/:id,body { payload: CanvasPayload },If-Match = metaRevision base;返更新后 CanvasMeta。 */
  updateCanvas(id: string, patch: { projectId: string; title?: string; sourceTemplateId?: string }, baseRevision?: Revision): Promise<CreateCanvasResponse>
  /** G1-a P1-2:DELETE /api/canvas/:id → 204(幂等);404 → 视为已删(void,幂等)。 */
  deleteCanvas(id: string): Promise<void>
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
   * F5 seam 必填:不传 baseContentVersion 编译失败(见 contract test @ts-expect-error 互锁)。
   * 响应返新 contentVersion(client 据此作下次 reorder 的 If-Match base)。
   */
  reorderChildren(
    canvasId: string,
    type: 'node' | 'edge' | 'anchor' | 'chat-message',
    orderedIds: string[],
    baseContentVersion: Revision,
  ): Promise<{ reordered: number; contentVersion: Revision }>

  // ── document scope → /api/canvas/:id/chat(G1-a chat 接线,DP-6R per-actor)──
  /**
   * G1-a chat 接线(DP-6R P1-1):GET /api/canvas/:id/chat → ListChatMessagesResponse(messages=RecordEntry[],
   * payload=opaque ChatMessage)。per-actor:服务端返当前 actor 的 collection(dp6r;匿名 → 401 require-login)。
   */
  listChatMessages(canvasId: string): Promise<ListChatMessagesResponse>
  /**
   * G1-a chat 接线(DP-6R P1-1):POST /api/canvas/:id/chat,body { message } → 201/200 UpsertResponse。
   * 幂等(idempotency-key);per-actor:写入当前 actor 的 collection。
   */
  appendChatMessage(canvasId: string, message: unknown): Promise<UpsertResponse>
  /**
   * G1-a chat 接线(DP-6R P1-1):PATCH /api/canvas/:id/chat/:msgId,body { payload } → 200 UpsertResponse。
   * If-Match = msg envelope revision(missing → 428 / stale → 409)。per-actor:只能改自己的 collection。
   */
  updateChatMessage(canvasId: string, msgId: string, payload: unknown, baseRevision?: Revision): Promise<UpsertResponse>
  /**
   * G1-a chat 接线(DP-6R P1-1):DELETE /api/canvas/:id/chat/:msgId → 204(硬删);404 → 视为已删(void,幂等)。
   * per-actor:只能删自己的 collection(跨 actor → 404 无泄漏)。
   */
  deleteChatMessage(canvasId: string, msgId: string): Promise<void>

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
  /**
   * G1-a P1-2 seam:POST /api/assets/:assetId/attach,body { nodeId } → AttachAssetResult。ownerFp 服务端派生
   * (client 不传)。节点生命周期调用方属 G1-c(node mutation),本轮只冻结 wire seam。
   * 404(missing asset)→ 抛 HttpError(executor 映射 rejected)。
   */
  attachAsset(assetId: string, nodeId: string): Promise<AttachAssetResult>
  /**
   * G1-a P1-2 seam:POST /api/assets/:assetId/detach,body { nodeId } → DetachAssetResult。ownerFp 服务端派生;
   * 跨 owner detach → 403(owner-mismatch,decidable,不静默)。节点生命周期调用方属 G1-c,本轮只冻结 wire seam。
   * 404(missing)→ 抛 HttpError(executor 幂等 success)。
   */
  detachAsset(assetId: string, nodeId: string): Promise<DetachAssetResult>
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
  getProject: () => notWired('getProject'),
  updateProject: () => notWired('updateProject'),
  deleteProject: () => notWired('deleteProject'),
  fetchCanvas: () => notWired('fetchCanvas'),
  listCanvas: () => notWired('listCanvas'),
  createCanvas: () => notWired('createCanvas'),
  updateCanvas: () => notWired('updateCanvas'),
  deleteCanvas: () => notWired('deleteCanvas'),
  upsertNode: () => notWired('upsertNode'),
  upsertEdge: () => notWired('upsertEdge'),
  upsertAnchor: () => notWired('upsertAnchor'),
  deleteNode: () => notWired('deleteNode'),
  deleteEdge: () => notWired('deleteEdge'),
  deleteAnchor: () => notWired('deleteAnchor'),
  reorderChildren: () => notWired('reorderChildren'),
  appendChatMessage: () => notWired('appendChatMessage'),
  listChatMessages: () => notWired('listChatMessages'),
  updateChatMessage: () => notWired('updateChatMessage'),
  deleteChatMessage: () => notWired('deleteChatMessage'),
  putUserState: () => notWired('putUserState'),
  getUserState: () => notWired('getUserState'),
  deleteUserState: () => notWired('deleteUserState'),
  uploadAsset: () => notWired('uploadAsset'),
  resolveAsset: () => notWired('resolveAsset'),
  attachAsset: () => notWired('attachAsset'),
  detachAsset: () => notWired('detachAsset'),
}

// ─────────────────────────────────────────────────────────────────────────────
// G1-a 非画布域接线(v6 §4):真 fetch adapter + fetch 底座。默认 mode=local 时
// getServerPersistAdapter() 返回 unwiredServerPersistAdapter(上面),生产零变化;
// ?persist=server|shadow 切到下面的 createFetchServerPersistAdapter。
//
// 接线范围(G1-a 非画布域,不受合并模型影响):
//   project     → listProjects / createProject          (POST/GET /api/projects)
//   canvas-meta → fetchCanvas / listCanvas              (GET /api/canvas[:id],hydrate 读路径)
//   user-state  → putUserState / getUserState / deleteUserState (PUT/GET/DELETE /api/user-state/:key)
//   asset       → uploadAsset / resolveAsset            (POST/GET /api/assets,G1.6 seam 为 N2-3 铺底)
//
// 不接线(留 seam 注释,见 notWiredG1c / notWiredDP6R):
//   画布域写 upsertNode/Edge/Anchor + deleteNode/Edge/Anchor + reorderChildren → G1-c 挂 N2-0 决议
//   chat appendChatMessage → DP-6R(另一 worker)
// 不改契约语义:wire body 不带 id/revision;revision base 走 If-Match header(shared 常量);
// 幂等 key 走 Idempotency-Key header。HttpError 供 writeRetryQueue executor 用 classifyHttpStatus 分类。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HttpError:非 2xx 响应抛出,携带 status + parsed body。writeRetryQueue 的 executor
 * catch 后用 classifyHttpStatus(status, body, {isDelete}) 分类成 WriteOutcome
 * (409→conflict / 422→reuse-conflict / 413→too-large / 401→unauthorized /
 * 5xx·408·429→transient 重试 / 4xx→rejected terminal / 404-on-delete→success)。
 * 直接(非队列)调用方据 status 自行处理(如 404→null 已在方法内吃掉)。
 */
export class HttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/** fetch 底座用的 fetch 形态(同全局 fetch 签名;测试可注入 app.request 驱动真实 Hono route)。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** getAuthHeaders 可 sync 或 async(生产走 lazy dynamic import authHeaders,避免把 settingsSlice 拉进每个 importer)。 */
export type GetAuthHeaders = () => Record<string, string> | Promise<Record<string, string>>

export type FetchAdapterOptions = {
  /** fetch 实现;默认全局 fetch。测试注入 Hono app.request 驱动真实 route。 */
  fetch?: FetchLike
  /** BFF base URL;默认 ''(同源 /api/...)。 */
  baseUrl?: string
  /** 鉴权头(X-Mivo-Api-Key 等);生产 lazy import authHeaders,测试注入 {x-mivo-api-key: KEY_A}。 */
  getAuthHeaders: GetAuthHeaders
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const isJsonResponse = (res: Response): boolean => {
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json')
}

/** 解析响应体:JSON 响应 → JSON.parse;否则返文本。空体 → null。永不抛(供 HttpError.body 用)。 */
const readResponseBody = async (res: Response): Promise<unknown> => {
  const text = await res.text()
  if (!text) return null
  if (isJsonResponse(res)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/**
 * fetch 底座(G1.1):构造 JSON 请求(auth + Content-Type + If-Match + Idempotency-Key 头)、
 * 调 fetch、非 2xx 抛 HttpError(status + body)、2xx 返 parsed JSON(204 → undefined)。
 * 不改契约语义:revision base 经 If-Match(shared IF_MATCH_HEADER),幂等 key 经
 * IDEMPOTENCY_KEY_HEADER。与 server/lib/persistHttp 同源常量,防字符串漂移。
 *
 * 导出供 persistWriteExecutor 复用 —— 队列重试路径走同一 fetch 底座(不重复实现 fetch),
 * executor 仅在 catch HttpError 后用 classifyHttpStatus 映射成 WriteOutcome。
 */
export const requestJson = async <T>(args: {
  fetch: FetchLike
  baseUrl: string
  getAuthHeaders: GetAuthHeaders
  method: string
  path: string
  body?: unknown
  ifMatch?: Revision
  idempotencyKey?: string
  signal?: AbortSignal
}): Promise<T> => {
  const headers: Record<string, string> = { ...(await args.getAuthHeaders()) }
  if (args.body !== undefined) headers['Content-Type'] = 'application/json'
  if (args.ifMatch !== undefined) headers[IF_MATCH_HEADER] = String(args.ifMatch)
  if (args.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = args.idempotencyKey
  const res = await args.fetch(args.baseUrl + args.path, {
    method: args.method,
    headers,
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    signal: args.signal,
  })
  if (res.status === 204) return undefined as T
  const body = await readResponseBody(res)
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(res.status, body, `ServerPersistAdapter HTTP ${res.status} ${args.method} ${args.path}`)
  }
  return body as T
}

/** 画布域写方法 seam reject(G1-c 挂 N2-0 决议;不在 G1-a 非画布域范围)。 */
const notWiredG1c = (method: string): Promise<never> =>
  Promise.reject(
    new Error(
      `ServerPersistAdapter.${method} not wired — canvas domain (node/edge/anchor) waits on N2-0 decision (G1-c); G1-a only wires non-canvas domains`,
    ),
  )

/**
 * 真 fetch ServerPersistAdapter(G1-a 非画布域接线)。工厂式:测试注入 fetch=getAppRequest +
 * getAuthHeaders=()=>({x-mivo-api-key:KEY_A}) 驱动 buildPersistApp 的真实 Hono route;生产由
 * serverPersistAdapterSelector 提供(默认全局 fetch + '' baseUrl + lazy authHeaders)。
 *
 * 409/422/428/413 等以 HttpError 抛出(契约 ApiErrorBody 体);404 在 fetchCanvas/getUserState/
 * resolveAsset 内吃掉返 null,deleteUserState 内吃掉返 void(幂等删)。401 等鉴权态由 executor
 * 分类,这里原样抛 HttpError(401)。
 */
export const createFetchServerPersistAdapter = (opts: FetchAdapterOptions): ServerPersistAdapter => {
  const doFetch = opts.fetch ?? defaultFetch
  const baseUrl = opts.baseUrl ?? ''
  const getAuthHeaders = opts.getAuthHeaders

  return {
    // ── project(document scope)──
    listProjects: () =>
      requestJson<ListProjectsResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'GET',
        path: '/api/projects',
      }),
    createProject: (name, id) =>
      requestJson<Project>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'POST',
        path: '/api/projects',
        body: { name, ...(id ? { id } : {}) },
      }),
    // G1-a P1-2:project CRUD 单 get / rename / delete(对齐 server/routes/projects.ts:163/185/263)
    getProject: async (id) => {
      try {
        return await requestJson<Project>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'GET',
          path: `/api/projects/${encodeURIComponent(id)}`,
        })
      } catch (error) {
        // 404(unknown / 跨 owner unauthorized 统一 404 无泄漏)→ null;其他 HttpError 原样抛。
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      }
    },
    updateProject: (id, name, baseRevision) =>
      requestJson<Project>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'PATCH',
        path: `/api/projects/${encodeURIComponent(id)}`,
        body: { name },
        ...(baseRevision !== undefined ? { ifMatch: baseRevision } : {}),
      }),
    deleteProject: async (id) => {
      try {
        await requestJson<void>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'DELETE',
          path: `/api/projects/${encodeURIComponent(id)}`,
        })
      } catch (error) {
        // 幂等删:404(已删 / 不存在)视为成功 void(对齐 server DELETE 204 幂等 + 404 unknown 统一吃掉)。
        if (error instanceof HttpError && error.status === 404) return
        throw error
      }
    },

    // ── canvas-meta(hydrate 读路径;写路径 node/edge/anchor 走 G1-c seam)──
    fetchCanvas: async (canvasId) => {
      try {
        return await requestJson<GetCanvasResponse>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'GET',
          path: `/api/canvas/${encodeURIComponent(canvasId)}`,
        })
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      }
    },
    listCanvas: (projectId) => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return requestJson<ListCanvasResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'GET',
        path: `/api/canvas${qs}`,
      })
    },
    // G1-a P1-2:canvas-meta CRUD(对齐 server/routes/canvas.ts:224/284/380)
    createCanvas: (input) =>
      requestJson<CreateCanvasResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'POST',
        path: '/api/canvas',
        body: {
          projectId: input.projectId,
          ...(input.id ? { id: input.id } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.sourceTemplateId !== undefined ? { sourceTemplateId: input.sourceTemplateId } : {}),
        },
      }),
    updateCanvas: (id, patch, baseRevision) =>
      requestJson<CreateCanvasResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'PUT',
        path: `/api/canvas/${encodeURIComponent(id)}`,
        body: {
          payload: {
            projectId: patch.projectId,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.sourceTemplateId !== undefined ? { sourceTemplateId: patch.sourceTemplateId } : {}),
          },
        } satisfies UpdateCanvasRequest,
        ...(baseRevision !== undefined ? { ifMatch: baseRevision } : {}),
      }),
    deleteCanvas: async (id) => {
      try {
        await requestJson<void>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'DELETE',
          path: `/api/canvas/${encodeURIComponent(id)}`,
        })
      } catch (error) {
        // 幂等删:404(已删 / 不存在)视为成功 void。
        if (error instanceof HttpError && error.status === 404) return
        throw error
      }
    },

    // ── canvas-domain 写(G1-c 挂 N2-0;seam reject,不接)──
    upsertNode: () => notWiredG1c('upsertNode'),
    upsertEdge: () => notWiredG1c('upsertEdge'),
    upsertAnchor: () => notWiredG1c('upsertAnchor'),
    deleteNode: () => notWiredG1c('deleteNode'),
    deleteEdge: () => notWiredG1c('deleteEdge'),
    deleteAnchor: () => notWiredG1c('deleteAnchor'),
    reorderChildren: () => notWiredG1c('reorderChildren'),

    // ── chat(G1-a chat 接线,DP-6R per-actor;wire shape 与旧版/新版 route 一致,owner 语义服务端管)──
    listChatMessages: (canvasId) =>
      requestJson<ListChatMessagesResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'GET',
        path: `/api/canvas/${encodeURIComponent(canvasId)}/chat`,
      }),
    appendChatMessage: (canvasId, message) =>
      requestJson<UpsertResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'POST',
        path: `/api/canvas/${encodeURIComponent(canvasId)}/chat`,
        body: { message },
      }),
    updateChatMessage: (canvasId, msgId, payload, baseRevision) =>
      requestJson<UpsertResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'PATCH',
        path: `/api/canvas/${encodeURIComponent(canvasId)}/chat/${encodeURIComponent(msgId)}`,
        body: { payload },
        ...(baseRevision !== undefined ? { ifMatch: baseRevision } : {}),
      }),
    deleteChatMessage: async (canvasId, msgId) => {
      try {
        await requestJson<void>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'DELETE',
          path: `/api/canvas/${encodeURIComponent(canvasId)}/chat/${encodeURIComponent(msgId)}`,
        })
      } catch (error) {
        // 幂等删:404(已删 / 不存在 / 跨 actor)视为成功 void。
        if (error instanceof HttpError && error.status === 404) return
        throw error
      }
    },

    // ── user-state(user scope)──
    putUserState: (key, value, baseRevision) =>
      requestJson<UpsertResponse>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'PUT',
        path: `/api/user-state/${encodeURIComponent(key)}`,
        body: { value },
        ...(baseRevision !== undefined ? { ifMatch: baseRevision } : {}),
      }),
    getUserState: async (key) => {
      try {
        return await requestJson<UserStateEntry>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'GET',
          path: `/api/user-state/${encodeURIComponent(key)}`,
        })
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      }
    },
    deleteUserState: async (key) => {
      try {
        await requestJson<void>({
          fetch: doFetch,
          baseUrl,
          getAuthHeaders,
          method: 'DELETE',
          path: `/api/user-state/${encodeURIComponent(key)}`,
        })
      } catch (error) {
        // 幂等删:404(已删 / 不存在)视为成功,不抛(对齐 server DELETE 已删→204 语义;
        // 跨 owner/不存在 server 统一 404 unknown-key,此处吃掉免误报)。
        if (error instanceof HttpError && error.status === 404) return
        throw error
      }
    },

    // ── asset(G1.6 seam,T1.5 #195 真实 wire shape;为 N2-3 协作生图铺底)──
    uploadAsset: async (bytes, meta) => {
      // multipart/form-data 'image' file(对齐 server/routes/assets.ts POST)。
      // 不设 Content-Type —— fetch/FormData 自带 boundary;手设会缺 boundary 致解析失败。
      // Uint8Array → Blob:TS lib 5.7+ 的 Uint8Array<ArrayBufferLike> 与 BlobPart 的 ArrayBuffer
      // 收窄有类型摩擦(runtimes 均接受 Uint8Array 作 BlobPart),此处 cast 跨过类型层。
      const blob = new Blob([bytes as unknown as BlobPart], { type: meta.mimeType })
      const form = new FormData()
      form.append('image', blob, meta.originalName)
      const headers = { ...(await getAuthHeaders()) }
      const res = await doFetch(`${baseUrl}/api/assets`, {
        method: 'POST',
        headers,
        body: form,
      })
      const body = await readResponseBody(res)
      if (res.status < 200 || res.status >= 300) {
        throw new HttpError(res.status, body, `ServerPersistAdapter HTTP ${res.status} POST /api/assets`)
      }
      return body as CreateAssetResponse
    },
    resolveAsset: async (assetId) => {
      const res = await doFetch(`${baseUrl}/api/assets/${encodeURIComponent(assetId)}`, {
        method: 'GET',
        headers: { ...(await getAuthHeaders()) },
      })
      if (res.status === 404) return null
      if (res.status < 200 || res.status >= 300) {
        throw new HttpError(res.status, await readResponseBody(res), `ServerPersistAdapter HTTP ${res.status} GET /api/assets/:id`)
      }
      const ab = await res.arrayBuffer()
      return {
        bytes: new Uint8Array(ab),
        mimeType: res.headers.get('content-type') || 'application/octet-stream',
      }
    },
    // G1-a P1-2 seam:asset attach/detach wire(节点生命周期调用方属 G1-c,本轮只冻结 wire)。
    // ownerFp 服务端派生(client 不传);route:200(attached/already-attached)/404(missing)。
    attachAsset: (assetId, nodeId) =>
      requestJson<AttachAssetResult>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'POST',
        path: `/api/assets/${encodeURIComponent(assetId)}/attach`,
        body: { nodeId },
      }),
    // route:200(detached/already-detached)/404(missing)/403(owner-mismatch)。404 由 executor 幂等 success。
    detachAsset: (assetId, nodeId) =>
      requestJson<DetachAssetResult>({
        fetch: doFetch,
        baseUrl,
        getAuthHeaders,
        method: 'POST',
        path: `/api/assets/${encodeURIComponent(assetId)}/detach`,
        body: { nodeId },
      }),
  }
}
