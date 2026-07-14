// persistWriteExecutor — G1-a retry 接线:writeRetryQueue 的真实 executor(dispatch by op.kind
// → 共享 requestJson fetch 底座 + idempotency-key header + classifyHttpStatus 分类)。
//
// 计划 §7:writeRetryQueue 只接"提交网络失败重试",不是执行队列。本 executor 是队列 drain
// 时调用的 WriteExecutor —— 把 QueuedWrite.op 经 requestJson 重发到 BFF,失败按
// classifyHttpStatus 映射成 WriteOutcome(409→conflict / 422→reuse-conflict / 413→too-large /
// 401→unauthorized 暂停 / 5xx·408·429→transient 重试 / 4xx→rejected terminal /
// 404-on-delete→success)。成功 → {status:'success'}(队列删记录)。
//
// 复用 requestJson(serverPersistAdapter 的 fetch 底座),不重复实现 fetch —— adapter 的直接
// 写路径与队列重试路径走同一 wire 逻辑,防双实现漂移。
//
// G1-a P1-3 类型拆分:executor 只接受 NonCanvasWriteOp(project/canvas-meta/user-state/asset)。
// 画布域写(node/edge/anchor/reorder)与 chat 不在 G1-a 范围(G1-c 挂 N2-0 / DP-6R 另一 worker)——
// 这些 op 经 isNonCanvasWriteOp 守卫返 unsupported-retained(drain 标 deferred 留存,不删不发请求,
// 等 G1-c/DP-6R 升级 executor 后显式 flip deferred→pending 再 drain)。terminal 仅留给真正的
// 不可恢复错误(executor 不应再对 canvas/chat 返 terminal —— 那会 deleteWrite 永久删 durable 记录)。

import {
  classifyHttpStatus,
  isDeleteKind,
  isNonCanvasWriteOp,
  migrateLegacyOp,
  type MigratedOp,
  type WriteExecutor,
  type WriteOp,
  type WriteOutcome,
} from './writeRetryQueue'
import { HttpError, requestJson, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'
import { debugLogger } from '../store/debugLogStore'
import type {
  AttachAssetResult,
  DetachAssetResult,
  Project,
  CanvasMeta,
  LegacyReplaceRequest,
  UpsertResponse,
} from '../../shared/persist-contract.ts'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

/**
 * F2:legacy-envelope 发送前本地完整校验(复刻 server validateLegacyReplaceRequest 的 shape 语义,不 import
 *   server;OUT 边界禁动 server/)。本地非法/腐败 → rejected fail-visible(不发送,400 根本轮不到歧义)。
 *   本地合法 + 收到 400 → 只剩 gate 关 / server 漂移 → gate-blocked 数据保全(见 classifyLegacyDrain)。
 * 校验:kind='legacy-replace' + canvasId/nodeId 非空 string + version===1 + payload object(非 null/array)+
 *   baseRevision 非负 safe integer。scope 在 client 侧平凡(path 从 env 自身构造,canvasId/nodeId 必匹配)。
 */
const validateLegacyEnvelopeLocal = (env: LegacyReplaceRequest): { ok: true } | { ok: false; reason: string } => {
  if (env == null || typeof env !== 'object' || Array.isArray(env)) return { ok: false, reason: 'legacy-replace must be object' }
  const e = env as Record<string, unknown>
  if (e.kind !== 'legacy-replace') return { ok: false, reason: 'kind must be legacy-replace' }
  if (typeof e.canvasId !== 'string' || e.canvasId.length === 0) return { ok: false, reason: 'canvasId must be non-empty string' }
  if (typeof e.nodeId !== 'string' || e.nodeId.length === 0) return { ok: false, reason: 'nodeId must be non-empty string' }
  if (e.version !== 1) return { ok: false, reason: 'version must be 1' }
  if (e.payload == null || typeof e.payload !== 'object' || Array.isArray(e.payload)) return { ok: false, reason: 'payload must be object' }
  if (typeof e.baseRevision !== 'number' || !Number.isSafeInteger(e.baseRevision) || (e.baseRevision as number) < 0) return { ok: false, reason: 'baseRevision must be non-negative safe integer' }
  return { ok: true }
}

/**
 * A2-S4 Block 4:§14.3 legacy drain 状态码分类(**不走通用 classifyHttpStatus**)。
 *
 * 为何独立分类(而非复用 classifyHttpStatus):
 *  1. **envelope 400 → gate-blocked(数据保全,非 terminal)**:drainMigrated 发送前 validateLegacyEnvelopeLocal
 *     已校验 envelope 合法 → 收到 400 不可能是 payload-rejection(那需 envelope 非法,本地已拒不发送)→ 只剩
 *     gate 关(LEGACY_DRAIN env 默认关,canvas.ts:544)或 server 漂移 → 都不该丢数据 → gate-blocked(drain 标
 *     gate-blocked + gateAttempts 独立退避,不消耗 maxAttempts、无紧循环;gate 开后重 drain 出队,见
 *     writeRetryQueue drain gate-blocked case)。全等匹配 `error==='bad-request' && message==='legacy drain gate closed'`
 *     (非 includes,防相似文本误判)作诊断区分 gate-closed vs server-drift。
 *  2. **legacy 409 → rejected dead-letter(非 conflict)**:legacy-stale-conflict / reorder-conflict /
 *     delete-race 的 409 一律 terminal rejected(不触发 onConflict 自动 rebase——legacy 记录的
 *     refetch+resubmit 是 G1-c 的活,本 block 只 surface dead-letter fail-visible)。
 *
 * 权威:server/routes/canvas.ts legacyDrainEnvelope(L521-579,200/409/400-gate/400-scope/403/404/422)+
 *   deleteChildCascadeHandler(L728-781,200/404/409/428)+ reorder(L447-513,200/400/409/428)。
 * fail-visible:terminal/rejected 由 drain switch 经 recordTerminal + debugLogger.error + toast 留痕
 *   (docs/development-logging.md),executor 只返 outcome;gate-blocked 由 drain debugLogger.warn(数据保全)。
 */
const classifyLegacyDrain = (
  status: number,
  body: unknown,
  path: 'envelope' | 'delete' | 'reorder',
): WriteOutcome => {
  if (status >= 200 && status < 300) return { status: 'success' }
  if (status === 401) return { status: 'unauthorized' }
  if (status === 409) {
    // legacy-stale-conflict(envelope)/ reorder revision-conflict / delete-race → terminal dead-letter(fail-visible)
    return { status: 'rejected', body }
  }
  if (status === 400) {
    if (path === 'envelope') {
      // F2:drainMigrated 发送前已 validateLegacyEnvelopeLocal 校验 envelope 合法 → 400 不可能是
      //   payload-rejection(那需 envelope 非法,本地已拒不发送)→ 只剩 gate 关 / server 漂移 → 数据保全
      //   gate-blocked(不丢数据)。全等匹配 gate-closed 作诊断区分(非 includes,防相似文本误判)。
      const b = body as { error?: string; message?: string }
      const gateClosed = b?.error === 'bad-request' && b?.message === 'legacy drain gate closed'
      return {
        status: 'gate-blocked',
        message: gateClosed
          ? 'legacy drain gate closed (LEGACY_DRAIN off)'
          : `legacy-envelope 400 post-local-validate (server drift?): ${JSON.stringify(body).slice(0, 160)}`,
      }
    }
    // delete/reorder 400 = 真实 payload 问题(delete bad base cursor / reorder bad-orderedIds)→ rejected terminal
    return { status: 'rejected', body }
  }
  if (status === 403) return { status: 'rejected', body } // authz deny terminal
  if (status === 404) {
    if (path === 'delete') return { status: 'success' } // idempotent(已删 / cross-canvas —— delete 意图已满足)
    return { status: 'rejected', body } // unknown-node / cross-canvas(envelope/reorder)→ terminal
  }
  if (status === 422) {
    const b = body as { key?: string }
    return { status: 'reuse-conflict', key: typeof b?.key === 'string' ? b.key : '' }
  }
  if (status === 428) return { status: 'rejected', body } // delete 缺 BaseCursor / reorder 缺 base → terminal fail-visible
  if (status >= 500 || status === 408 || status === 429) return { status: 'transient', message: `http_${status}` }
  return { status: 'terminal', message: `http_${status}` }
}

/**
 * 造一个 WriteExecutor(队列 drain 用)。opts 与 createFetchServerPersistAdapter 同源
 * (fetch / baseUrl / getAuthHeaders),保证直接写与重试写走同一 BFF + 同一鉴权。
 */
export const createAdapterWriteExecutor = (opts: FetchAdapterOptions): WriteExecutor => {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch
  const baseUrl = opts.baseUrl ?? ''
  const getAuthHeaders: GetAuthHeaders = opts.getAuthHeaders
  const base = { fetch: doFetch, baseUrl, getAuthHeaders }

  /**
   * A2-S4 Block 4:drain 迁移产物(三路真发 server,§14.3 drain-only 兼容通道)。
   * 闭包 `base`(同 createFetchServerPersistAdapter 的 fetch/baseUrl/auth),保证直接写与重试写走同一 BFF。
   * HttpError → classifyLegacyDrain(gate-off 400 retained / 409 dead-letter / 其余按 path 分类);
   * 非 HTTP throw → transient(带 backoff 重试,同主 switch 约定)。
   */
  const drainMigrated = async (migrated: MigratedOp, idempotencyKey: string): Promise<WriteOutcome> => {
    let path: 'envelope' | 'delete' | 'reorder' = 'envelope'
    try {
      switch (migrated.kind) {
        case 'legacy-envelope': {
          path = 'envelope'
          const env = migrated.envelope
          // F2:发送前本地完整校验 envelope shape(本地非法/腐败 → rejected,不发送;400 根本轮不到歧义)。
          //   本地合法 + 收到 400 → gate-blocked(数据保全,见 classifyLegacyDrain envelope-400)。
          const v = validateLegacyEnvelopeLocal(env)
          if (!v.ok) return { status: 'rejected', body: { error: 'bad-request', message: v.reason } }
          // PATCH /api/canvas/:canvasId/nodes/:nodeId,body = LegacyReplaceRequest 信封(baseRevision
          //   在信封内,**非 If-Match header**);§14.3 decoder wire:gate 关→400 / scope mismatch→400 /
          //   stale base→409 legacy-stale-conflict / fresh(existing+base=rev / missing+base=0→create)→200 replace。
          const result = await requestJson<UpsertResponse>({
            ...base,
            method: 'PATCH',
            path: `/api/canvas/${encodeURIComponent(env.canvasId)}/nodes/${encodeURIComponent(env.nodeId)}`,
            body: env,
            idempotencyKey,
          })
          // 回捕 revision(UpsertResponse{id,revision,seq}),drain 经 onSuccess 回灌 store 下一次 strict
          //   update 用 fresh base(同 createProject/createCanvas 模式;若上层未接 upsertNode onSuccess 则 no-op)。
          return { status: 'success', revision: result.revision }
        }
        case 'delete': {
          const cmd = migrated.cmd
          // 仅 node-delete-cascade 经 §10.4 实证(§14.5);group-reparent/result-asset-attach 非本迁移产物,
          //   防御性返 unsupported-retained(不应发生;migrateLegacyOp 只产 node-delete-cascade)。
          if (cmd.kind !== 'node-delete-cascade') {
            return {
              status: 'unsupported-retained',
              message: `legacy delete cmd ${cmd.kind} not wired; record retained`,
            }
          }
          path = 'delete'
          // DELETE /api/canvas/:canvasId/nodes/:nodeId(§10.4 cascade)。**队列 deleteNode op 无 base 字段**,
          //   server deleteChildCascadeHandler 要求 If-Match=签名 BaseCursor(canvas.ts:748 decodeBase),
          //   missing→428 / bare→400。legacy delete 无法提供签名 base → server 返 428 → classifyLegacyDrain
          //   分类 rejected terminal(fail-visible:drain recordTerminal 留痕 + debugLogger.error + toast,
          //   不静默丢;一发即终态,不重试不 busy-loop)。legacy delete 缺 base 无法安全 drain,需 G1-c base
          //   获取或新路径重删——本 block 只 surface fail-visible(lead 裁定 1:不做半截/不接受永远 deferred,
          //   428 terminal 是 definitive fail-visible 非"悬空 deferred")。
          await requestJson({
            ...base,
            method: 'DELETE',
            path: `/api/canvas/${encodeURIComponent(cmd.canvasId)}/nodes/${encodeURIComponent(cmd.nodeId)}`,
            idempotencyKey,
          })
          return { status: 'success' }
        }
        case 'reorder': {
          path = 'reorder'
          const r = migrated
          // POST /api/canvas/:canvasId/reorder,body {type, orderedIds},If-Match = bare contentVersion
          //   (parseIfMatch 路径,非 decodeBase——reorder 端点收 bare revision)。队列 reorderChildren
          //   .baseContentVersion 是必填 bare Revision → If-Match 有值,428 不会发生。
          //   200→success / 400 bad-orderedIds→rejected / 409 revision-conflict→rejected dead-letter。
          await requestJson({
            ...base,
            method: 'POST',
            path: `/api/canvas/${encodeURIComponent(r.canvasId)}/reorder`,
            body: { type: r.childType, orderedIds: r.orderedIds },
            ifMatch: r.baseContentVersion,
            idempotencyKey,
          })
          // reorder 200 响应 {reordered,contentVersion,base}——无 per-record revision,onSuccess 不回灌(跳过)。
          return { status: 'success' }
        }
      }
    } catch (error) {
      if (error instanceof HttpError) return classifyLegacyDrain(error.status, error.body, path)
      return { status: 'transient', message: `executor threw: ${msg(error)}` }
    }
  }

  const exec: WriteExecutor = async (op, idempotencyKey) => {
    // A2-S4 Block 4:旧队列画布域写(upsertNode/deleteNode/reorderChildren)→ §14.3 迁移信封,真发 server。
    //   迁移在 drain 时内存计算(IDB pristine,不写回);非三类 kind 返 null → 落下面 unsupported-retained /
    //   wired 路径(新格式记录零影响)。migrateLegacyOp 不 throw(生产 null 表 passthrough)。
    const migrated = migrateLegacyOp(op)
    if (migrated !== null) return drainMigrated(migrated, idempotencyKey)

    // G1-a P1-3:canvas/chat op 不在 G1-a executor 支持范围 → unsupported-retained(留存不删)。
    // 防御性:绝不返 terminal(否则 drain deleteWrite 永久删 G1-c/DP-6R 上线前的遗留 durable 记录)。
    // 注:三类 legacy 画布域 op(upsertNode/deleteNode/reorderChildren)已被上面 migrateLegacyOp 接走,
    //   这里只命中非三类画布域 op(upsertEdge/upsertAnchor/deleteEdge/deleteAnchor)→ retained 等 G1-c。
    if (!isNonCanvasWriteOp(op)) {
      return {
        status: 'unsupported-retained',
        message: `${op.kind} not wired (canvas domain G1-c/N2-0 or chat DP-6R; another worker); record retained for executor upgrade`,
      }
    }
    // F3:旧 durable 记录(Block 3 seam 加 canvasId 前入队)读出 attach/detach 的 canvasId===undefined →
    // server attach 路由 required canvasId 会 400 → rejected 删记录 → intent 静默丢。廉价防线:缺 canvasId →
    // fail-visible retain(unsupported-retained:不发不删,deferred 留存不重发),debugLogger 记失败路径。
    // 不做 migration 推导(canvasId 推不出,别猜)。
    if ((op.kind === 'attachAsset' || op.kind === 'detachAsset') && !op.canvasId) {
      debugLogger.error(
        'PersistWriteExecutor',
        `${op.kind} missing canvasId (legacy durable record; canvasId required since Block 3 — retained, not derivable, not sent): assetId=${op.assetId} nodeId=${op.nodeId}`,
      )
      return {
        status: 'unsupported-retained',
        message: 'missing canvasId (legacy durable record; canvasId required in Block 3 — retained, not derivable)',
      }
    }

    try {
      switch (op.kind) {
        case 'createProject': {
          // G1-a R2 F1:回捕服务端 Project.revision,drain 经 onSuccess 回灌 store,下一次 rename 用 fresh base。
          const result = await requestJson<Project>({
            ...base,
            method: 'POST',
            path: '/api/projects',
            body: { name: op.name, ...(op.id ? { id: op.id } : {}) },
            idempotencyKey,
          })
          return { status: 'success', revision: result.revision }
        }

        case 'updateProject': {
          // PATCH /api/projects/:id,body { name },If-Match = Project.revision base。
          const result = await requestJson<Project>({
            ...base,
            method: 'PATCH',
            path: `/api/projects/${encodeURIComponent(op.projectId)}`,
            body: { name: op.name },
            ...(op.baseRevision !== undefined ? { ifMatch: op.baseRevision } : {}),
            idempotencyKey,
          })
          return { status: 'success', revision: result.revision }
        }

        case 'deleteProject': {
          // DELETE /api/projects/:id — 204 幂等;404(已删/不存在)→ isDelete → success。
          try {
            await requestJson({
              ...base,
              method: 'DELETE',
              path: `/api/projects/${encodeURIComponent(op.projectId)}`,
              idempotencyKey,
            })
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) return { status: 'success' }
            throw error
          }
          return { status: 'success' }
        }

        case 'putUserState': {
          await requestJson({
            ...base,
            method: 'PUT',
            path: `/api/user-state/${encodeURIComponent(op.key)}`,
            body: { value: op.value },
            ...(op.baseRevision !== undefined ? { ifMatch: op.baseRevision } : {}),
            idempotencyKey,
          })
          return { status: 'success' }
        }

        case 'deleteUserState': {
          try {
            await requestJson({
              ...base,
              method: 'DELETE',
              path: `/api/user-state/${encodeURIComponent(op.key)}`,
              idempotencyKey,
            })
          } catch (error) {
            // 404 = 已删 / 不存在,幂等视为成功(对齐 adapter.deleteUserState 语义)。
            if (error instanceof HttpError && error.status === 404) return { status: 'success' }
            throw error
          }
          return { status: 'success' }
        }

        case 'createCanvas': {
          // POST /api/canvas,body CreateCanvasRequest → 201/200 CanvasMeta。
          // G1-a R2 F1:回捕 CanvasMeta.metaRevision,drain 经 onSuccess 回灌 store.canvases[id].metaRevision。
          // P1-1(sol 返修):服务端 createCanvasWithCollection 对同 owner live existing 返原 record 不应用
          //   incoming title/projectId(backend.ts existing → clone(existing),pgBackend.ts 同)→ POST 200 但
          //   rename/move 静默回退(刷新后 hydrate 取 server 旧值覆盖本地,applyServerRevision 只回灌
          //   metaRevision 不比对值)。修:createCanvas op 改 create-or-update——POST 返回 CanvasMeta 后比对
          //   title/projectId,不等则用返回的 metaRevision 立即 PUT If-Match 写目标值(POST 返 existing 时
          //   metaRevision 是该 record 当前 base,PUT 用它不 428 missing / 不 409 stale)。真 create/fresh id →
          //   POST created,title/projectId 一致,无 PUT(零回归)。PUT 在单 op 内 drain,不进 combineOps
          //   (combineOps 的 create+update 合并 / create+delete 净消针对批内未 drain op,本 PUT 已 drain)。
          const result = await requestJson<CanvasMeta>({
            ...base,
            method: 'POST',
            path: '/api/canvas',
            body: {
              projectId: op.projectId,
              ...(op.canvasId ? { id: op.canvasId } : {}),
              ...(op.title !== undefined ? { title: op.title } : {}),
              ...(op.sourceTemplateId !== undefined ? { sourceTemplateId: op.sourceTemplateId } : {}),
            },
            idempotencyKey,
          })
          // P1-1:POST 返 existing(未应用 incoming)→ 比对 title/projectId,不等则 PUT 补写目标值。
          //   op.title undefined(纯 move 不改名)只比对 projectId;两边一致 → 无 PUT(create 真命中/幂等)。
          const titleMismatch = op.title !== undefined && result.title !== op.title
          const projectMismatch = result.projectId !== op.projectId
          if (titleMismatch || projectMismatch) {
            const updated = await requestJson<CanvasMeta>({
              ...base,
              method: 'PUT',
              path: `/api/canvas/${encodeURIComponent(op.canvasId)}`,
              body: {
                payload: {
                  projectId: op.projectId,
                  ...(op.title !== undefined ? { title: op.title } : {}),
                  ...(op.sourceTemplateId !== undefined ? { sourceTemplateId: op.sourceTemplateId } : {}),
                },
              },
              ifMatch: result.metaRevision,
              idempotencyKey,
            })
            return { status: 'success', revision: updated.metaRevision }
          }
          return { status: 'success', revision: result.metaRevision }
        }

        case 'updateCanvas': {
          // PUT /api/canvas/:id,body { payload: CanvasPayload },If-Match = metaRevision base。
          const result = await requestJson<CanvasMeta>({
            ...base,
            method: 'PUT',
            path: `/api/canvas/${encodeURIComponent(op.canvasId)}`,
            body: {
              payload: {
                projectId: op.projectId,
                ...(op.title !== undefined ? { title: op.title } : {}),
                ...(op.sourceTemplateId !== undefined ? { sourceTemplateId: op.sourceTemplateId } : {}),
              },
            },
            ...(op.baseRevision !== undefined ? { ifMatch: op.baseRevision } : {}),
            idempotencyKey,
          })
          return { status: 'success', revision: result.metaRevision }
        }

        case 'deleteCanvas': {
          // DELETE /api/canvas/:id — 204 幂等;404 → isDelete → success。
          try {
            await requestJson({
              ...base,
              method: 'DELETE',
              path: `/api/canvas/${encodeURIComponent(op.canvasId)}`,
              idempotencyKey,
            })
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) return { status: 'success' }
            throw error
          }
          return { status: 'success' }
        }

        case 'attachAsset': {
          // POST /api/assets/:assetId/attach,body { nodeId, canvasId } → 200 AttachAssetResult。
          // 200 = attached/already-attached → success;404(missing asset)→ isDelete=false → rejected。
          await requestJson<AttachAssetResult>({
            ...base,
            method: 'POST',
            path: `/api/assets/${encodeURIComponent(op.assetId)}/attach`,
            body: { nodeId: op.nodeId, canvasId: op.canvasId },
            idempotencyKey,
          })
          return { status: 'success' }
        }

        case 'detachAsset': {
          // POST /api/assets/:assetId/detach,body { nodeId, canvasId } → 200 DetachAssetResult。
          // 200 = detached/already-detached → success;404(missing)→ isDelete=true → success(幂等);
          // 403(owner-mismatch)→ isDelete=true → classifyHttpStatus(403) → rejected(跨 owner 非法,不静默成功)。
          try {
            await requestJson<DetachAssetResult>({
              ...base,
              method: 'POST',
              path: `/api/assets/${encodeURIComponent(op.assetId)}/detach`,
              body: { nodeId: op.nodeId, canvasId: op.canvasId },
              idempotencyKey,
            })
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) return { status: 'success' }
            throw error
          }
          return { status: 'success' }
        }

        case 'appendChatMessage': {
          // POST /api/canvas/:id/chat,body { message } → 201/200 UpsertResponse(per-actor:写入当前 actor collection)。
          await requestJson({
            ...base,
            method: 'POST',
            path: `/api/canvas/${encodeURIComponent(op.canvasId)}/chat`,
            body: { message: op.message },
            idempotencyKey,
          })
          return { status: 'success' }
        }

        case 'updateChatMessage': {
          // PATCH /api/canvas/:id/chat/:msgId,body { payload },If-Match = msg envelope revision。
          await requestJson({
            ...base,
            method: 'PATCH',
            path: `/api/canvas/${encodeURIComponent(op.canvasId)}/chat/${encodeURIComponent(op.msgId)}`,
            body: { payload: op.payload },
            ...(op.baseRevision !== undefined ? { ifMatch: op.baseRevision } : {}),
            idempotencyKey,
          })
          return { status: 'success' }
        }

        case 'deleteChatMessage': {
          // DELETE /api/canvas/:id/chat/:msgId → 204(硬删);404(已删 / 跨 actor)→ isDelete → success(幂等)。
          try {
            await requestJson({
              ...base,
              method: 'DELETE',
              path: `/api/canvas/${encodeURIComponent(op.canvasId)}/chat/${encodeURIComponent(op.msgId)}`,
              idempotencyKey,
            })
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) return { status: 'success' }
            throw error
          }
          return { status: 'success' }
        }
      }
      // 上述 switch 穷尽 NonCanvasWriteOp(isNonCanvasWriteOp 守卫后 op 已窄化为 NonCanvasWriteOp);
      // noFallthroughCasesInSwitch + 穷尽性保证:TS 在新增 kind 未处理时报错(编译期 fail-visible)。
    } catch (error) {
      // HttpError → classifyHttpStatus 映射成 WriteOutcome(供队列 drain 状态机处理)。
      if (error instanceof HttpError) {
        return classifyHttpStatus(error.status, error.body, { isDelete: isDeleteKind(op.kind) })
      }
      // 非 HTTP 抛出(fetch 网络层 throw / AbortError 等)→ transient(带 backoff 重试)。
      return { status: 'transient', message: `executor threw: ${msg(error)}` }
    }
  }

  return exec
}

/** 仅类型占位:确保 WriteOutcome 全分支被 switch 覆盖的编译期提示(非运行时)。 */
export type { WriteOp, WriteOutcome }
