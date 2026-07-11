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
// 范围:非画布域写(createProject / putUserState / deleteUserState)接通;画布域写
// (upsertNode/Edge/Anchor · deleteNode/Edge/Anchor · reorderChildren)与 chat
// (appendChatMessage)→ terminal,不重试不调 adapter(G1-c / DP-6R seam;在 server 模式这些
// op 不应入队,terminal 是防御性兜底,绝不静默成功)。

import { classifyHttpStatus, isDeleteKind, type WriteExecutor, type WriteOp, type WriteOutcome } from './writeRetryQueue'
import { HttpError, requestJson, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'

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
    try {
      switch (op.kind) {
        case 'createProject':
          await requestJson({
            ...base,
            method: 'POST',
            path: '/api/projects',
            body: { name: op.name, ...(op.id ? { id: op.id } : {}) },
            idempotencyKey,
          })
          return { status: 'success' }

        case 'putUserState':
          await requestJson({
            ...base,
            method: 'PUT',
            path: `/api/user-state/${encodeURIComponent(op.key)}`,
            body: { value: op.value },
            ...(op.baseRevision !== undefined ? { ifMatch: op.baseRevision } : {}),
            idempotencyKey,
          })
          return { status: 'success' }

        case 'deleteUserState':
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

        case 'upsertNode':
        case 'upsertEdge':
        case 'upsertAnchor':
        case 'deleteNode':
        case 'deleteEdge':
        case 'deleteAnchor':
        case 'reorderChildren':
          // 画布域写 — G1-c 挂 N2-0 决议,不接。terminal:不重试不调 adapter(绝不静默成功)。
          return { status: 'terminal', message: `${op.kind} not wired (canvas domain G1-c; N2-0 pending)` }

        case 'appendChatMessage':
          // chat — DP-6R per-user 重拆(另一 worker),不接。terminal。
          return { status: 'terminal', message: 'appendChatMessage not wired (chat DP-6R; another worker)' }
      }
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
