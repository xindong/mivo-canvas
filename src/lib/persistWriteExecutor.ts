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
  type WriteExecutor,
  type WriteOp,
  type WriteOutcome,
} from './writeRetryQueue'
import { HttpError, requestJson, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'
import type {
  AttachAssetResult,
  DetachAssetResult,
  Project,
  CanvasMeta,
} from '../../shared/persist-contract.ts'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

/**
 * 造一个 WriteExecutor(队列 drain 用)。opts 与 createFetchServerPersistAdapter 同源
 * (fetch / baseUrl / getAuthHeaders),保证直接写与重试写走同一 BFF + 同一鉴权。
 */
export const createAdapterWriteExecutor = (opts: FetchAdapterOptions): WriteExecutor => {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch
  const baseUrl = opts.baseUrl ?? ''
  const getAuthHeaders: GetAuthHeaders = opts.getAuthHeaders
  const base = { fetch: doFetch, baseUrl, getAuthHeaders }

  const exec: WriteExecutor = async (op, idempotencyKey) => {
    // G1-a P1-3:canvas/chat op 不在 G1-a executor 支持范围 → unsupported-retained(留存不删)。
    // 防御性:绝不返 terminal(否则 drain deleteWrite 永久删 G1-c/DP-6R 上线前的遗留 durable 记录)。
    if (!isNonCanvasWriteOp(op)) {
      return {
        status: 'unsupported-retained',
        message: `${op.kind} not wired (canvas domain G1-c/N2-0 or chat DP-6R; another worker); record retained for executor upgrade`,
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
          // POST /api/assets/:assetId/attach,body { nodeId } → 200 AttachAssetResult。
          // 200 = attached/already-attached → success;404(missing asset)→ isDelete=false → rejected。
          await requestJson<AttachAssetResult>({
            ...base,
            method: 'POST',
            path: `/api/assets/${encodeURIComponent(op.assetId)}/attach`,
            body: { nodeId: op.nodeId },
            idempotencyKey,
          })
          return { status: 'success' }
        }

        case 'detachAsset': {
          // POST /api/assets/:assetId/detach,body { nodeId } → 200 DetachAssetResult。
          // 200 = detached/already-detached → success;404(missing)→ isDelete=true → success(幂等);
          // 403(owner-mismatch)→ isDelete=true → classifyHttpStatus(403) → rejected(跨 owner 非法,不静默成功)。
          try {
            await requestJson<DetachAssetResult>({
              ...base,
              method: 'POST',
              path: `/api/assets/${encodeURIComponent(op.assetId)}/detach`,
              body: { nodeId: op.nodeId },
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
