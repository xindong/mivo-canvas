// src/lib/mivoTaskClient.ts
// P2-C1b: async tasks API client. generationSlice switches from the sync
// /api/mivo/generate|edit calls (editMivoImage/generateMivoImage) to this async
// flow: POST /api/mivo/tasks/generate|edit → 202 {taskId} → poll
// GET /api/mivo/tasks/:id for the server's real progress/stage → on done take
// result.images into commitGenerationResult; cancel = DELETE /tasks/:id.
//
// Why a separate client (not extending mivoImageClient): the tasks API has a
// different shape (202 + poll vs 200 + body) and a different lifecycle (taskId,
// monotonic progress, terminal-state semantics). Isolating it lets the contract
// test mock the tasks boundary without disturbing the mivoImageClient mock
// (assetBlobForNode stays wired). See server/contracts/tasks-async.md for the
// server side (P2-C1a, #27).
//
// Cancel: the action's AbortSignal is the cancel conduit (chatStore.cancelGeneration
// aborts it). The poll loop in generationSlice observes signal.aborted and calls
// cancelTask (DELETE) — best-effort, a 404 (task already terminal/evicted) is fine.
// A canceled task never commits a result (server-side completeTask/failTask short
// -circuit on 'canceled'; client-side the catch maps to canceledTask + rethrow).
//
// Failure classification (怪癖 6 alignment): the tasks API surfaces failure as
// {status:'failed', error:<string>} with no `kind` field. chatStore.errorInfoForChat
// reads err.kind to decide whether to show the '中质量重试' (lower-quality retry)
// button for high-quality timeouts. To preserve that, kindForFailedTask() infers
// 'upstream-timeout' from the error wording (same text-heuristic pattern chatStore
// uses for '已取消'); otherwise 'upstream-error'. The thrown MivoImageRequestError
// then carries the kind chatStore expects.

import type { MivoEditRequest, MivoGenerateRequest, VariationParam } from '../types/generation'
import { MivoImageRequestError, formatMivoClientError } from './mivoImageClient'
import { useAuthStore } from '../store/authSlice'
import { toastFeedback } from '../store/toastStore'
import { authHeaders } from './authHeaders'

const defaultModel = 'gpt-image-2'
const submitTimeoutMs = 30_000 // POST must return 202 quickly
const pollTimeoutMs = 15_000 // each GET
const defaultPollIntervalMs = 1000

// feat/auth-feishu-login: 受保护 AI/生图 API 401(未登录 / 会话过期)→ 置未登录态
// + toast 提示登录。幂等:仅在从未登录态转出时 toast 一次,避免批量 401 刷屏。
// 集中在 fetchWithTimeout 一处,E2 的 X-Mivo-Api-Key header 注入在调用方 headers,
// 两处改动落在不同行段,降低 app.ts/mivoTaskClient 合并冲突面。
const onProtectedApi401 = (): void => {
  const { status, markUnauthenticated } = useAuthStore.getState()
  if (status === 'unauthenticated') return
  markUnauthenticated()
  toastFeedback.warn('请先登录后再使用此功能。')
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed' | 'canceled' | 'unknown'
export type TaskKind = 'generate' | 'edit' | 'variations'
export type TaskFailure = { variationIndex: number; error: string }
export type TaskResultImage = { b64: string; variationIndex?: number }
export type TaskResult = { images: TaskResultImage[] }

export type TaskView = {
  id: string
  kind: TaskKind
  status: TaskStatus
  progress: number
  stage: string
  requestId: string
  model: string
  result?: TaskResult
  // P2-C2: variations-only — failures[] lists the variation indices that didn't
  // settle successfully (status='partial'); batchId groups the batch; count is the
  // requested variation count (success subset length = result.images.length).
  failures?: TaskFailure[]
  batchId?: string
  count?: number
  error?: string
}

// Poll interval, env-tunable (e2e sets VITE_MIVO_TASK_POLL_INTERVAL_MS=50 to keep
// the progressive-poll scenarios fast). Default 1s per server/contracts/tasks-async.md.
export const taskPollIntervalMs = (): number => {
  const raw = import.meta.env.VITE_MIVO_TASK_POLL_INTERVAL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : defaultPollIntervalMs
}

const fileNameForBlob = (blob: Blob, fallback: string) =>
  blob instanceof File && blob.name ? blob.name : fallback

// Minimal fetch-with-timeout that chains the caller's AbortSignal so cancel
// propagates. Throws MivoImageRequestError on abort (kind='canceled' for external
// abort, 'client-timeout' for our own timeout) so the action's catch can classify.
const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> => {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromParent = () => controller.abort()
  if (signal?.aborted) {
    controller.abort()
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true })
  }
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    // feat/auth-feishu-login: 401 = 会话失效/未登录,置未登录态 + toast(幂等)。
    // 响应仍原样返回,调用方 !response.ok 分支照常抛 MivoImageRequestError。
    if (response.status === 401) {
      onProtectedApi401()
    }
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MivoImageRequestError(
        timedOut ? '任务请求超时。' : '图片请求已取消。',
        timedOut ? 'client-timeout' : 'canceled',
        { cause: error },
      )
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromParent)
  }
}

const readSubmitError = async (response: Response): Promise<string> => {
  let rawMessage = `${response.status} ${response.statusText}`
  try {
    const payload = (await response.json()) as { error?: string; message?: string }
    rawMessage = payload.error || payload.message || rawMessage
  } catch {
    // Keep the status text fallback.
  }
  return formatMivoClientError(response.status, rawMessage, 'Mivo Task')
}

// POST /api/mivo/tasks/generate → 202 {taskId}. Body is the same JSON as /generate.
// Idempotency-Key is generated one-time per generation call by the caller.
export const submitGenerationTask = async (
  request: MivoGenerateRequest & { idempotencyKey: string },
): Promise<string> => {
  const response = await fetchWithTimeout(
    '/api/mivo/tasks/generate',
    {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        'Idempotency-Key': request.idempotencyKey,
      },
      body: JSON.stringify({
        prompt: request.prompt,
        imgRatio: request.imgRatio,
        quality: request.quality,
        n: request.n ?? 1,
        model: request.model || defaultModel,
      }),
    },
    submitTimeoutMs,
    request.signal,
  )
  if (!response.ok) {
    throw new MivoImageRequestError(
      await readSubmitError(response),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  const body = (await response.json()) as { taskId?: string }
  if (!body.taskId) throw new MivoImageRequestError('任务提交响应无效。', 'upstream-error')
  return body.taskId
}

// POST /api/mivo/tasks/edit → 202 {taskId}. Multipart body is the same as /edit.
export const submitEditTask = async (
  request: MivoEditRequest & { idempotencyKey: string },
): Promise<string> => {
  const formData = new FormData()
  formData.append('image', request.image, fileNameForBlob(request.image, 'source.png'))
  if (request.mask) formData.append('mask', request.mask, fileNameForBlob(request.mask, 'mask.png'))
  // P2-C2: annotation area-edit — maskBounds (+ sourceSize) let the BFF synthesize
  // the area mask PNG when no brush mask blob is present. Mask-edit dual-model:
  // bounds are ALSO sent alongside a brush mask now — the gemini (instruction-based)
  // path folds them into the prompt as a spatial clause; the BFF only synthesizes
  // a mask from bounds when no mask file exists, so this cannot double-mask.
  if (request.maskBounds) {
    formData.set('maskBounds', JSON.stringify(request.maskBounds))
    if (request.sourceSize) formData.set('sourceSize', JSON.stringify(request.sourceSize))
  }
  // Anchor semantics: what the recognizer says the selection contains — feeds
  // the gemini instruction clause ("only modify the {label} ...").
  if (request.subjectLabel?.trim()) formData.set('subjectLabel', request.subjectLabel.trim())
  // Multi-anchor: per-marked-object label + bounds; preferred over subjectLabel.
  if (request.subjects?.length) formData.set('subjects', JSON.stringify(request.subjects))
  // Dual-image Set-of-Mark: numbered-ring copy → platform image 2 (visual pointing).
  if (request.markedImage) formData.append('markedImage', request.markedImage, 'marked.jpg')
  request.reference?.forEach((blob, index) => {
    formData.append('reference[]', blob, fileNameForBlob(blob, `reference-${index + 1}.png`))
  })
  formData.set('prompt', request.prompt)
  formData.set('imgRatio', request.imgRatio || '1:1')
  // Quality 留空时不下发字段 —— 与 submitGenerationTask 一致（chat 生图路径：
  // auto = 不显式传 quality，server normalizeMivoQuality 对缺省默认即 medium）。
  // 之前 `request.quality || 'medium'` 会把 auto 强制回填成 medium，破坏 auto 语义。
  if (request.quality) formData.set('quality', request.quality)
  formData.set('model', request.model || defaultModel)

  const response = await fetchWithTimeout(
    '/api/mivo/tasks/edit',
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Idempotency-Key': request.idempotencyKey },
      body: formData,
    },
    submitTimeoutMs,
    request.signal,
  )
  if (!response.ok) {
    throw new MivoImageRequestError(
      await readSubmitError(response),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  const body = (await response.json()) as { taskId?: string }
  if (!body.taskId) throw new MivoImageRequestError('任务提交响应无效。', 'upstream-error')
  return body.taskId
}

// POST /api/mivo/tasks/variations → 202 {taskId, batchId, count}. Multipart: the
// source image blob + a `variations` JSON field (Array<{prompt?,imgRatio?,quality?,
// model?}>). The BFF fires N parallel llm-proxy /edits calls and aggregates
// done/partial/failed. Idempotency-Key is one-time per call (same as generate/edit).
export const submitVariationsTask = async (
  request: { image: Blob; variations: VariationParam[]; idempotencyKey: string; signal?: AbortSignal },
): Promise<{ taskId: string; batchId: string; count: number }> => {
  const formData = new FormData()
  formData.append('image', request.image, fileNameForBlob(request.image, 'source.png'))
  formData.set('variations', JSON.stringify(request.variations))
  const response = await fetchWithTimeout(
    '/api/mivo/tasks/variations',
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Idempotency-Key': request.idempotencyKey },
      body: formData,
    },
    submitTimeoutMs,
    request.signal,
  )
  if (!response.ok) {
    throw new MivoImageRequestError(
      await readSubmitError(response),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  const body = (await response.json()) as { taskId?: string; batchId?: string; count?: number }
  if (!body.taskId) throw new MivoImageRequestError('任务提交响应无效。', 'upstream-error')
  return { taskId: body.taskId, batchId: body.batchId || '', count: body.count ?? request.variations.length }
}

// GET /api/mivo/tasks/:id → 200 TaskView | 404 {error:'unknown-task'}.
// 404 (server restarted / task evicted) maps to {status:'unknown'} — the caller
// MUST NOT commit a result for an unknown task (per §7 C1 restart semantics);
// it surfaces a "task expired, retry" failure.
export const pollTask = async (taskId: string, signal?: AbortSignal): Promise<TaskView> => {
  const response = await fetchWithTimeout(
    `/api/mivo/tasks/${encodeURIComponent(taskId)}`,
    { method: 'GET', headers: { ...authHeaders() } },
    pollTimeoutMs,
    signal,
  )
  if (response.status === 404) {
    return {
      id: taskId,
      kind: 'generate',
      status: 'unknown',
      progress: 0,
      stage: 'unknown',
      requestId: '',
      model: '',
    }
  }
  if (!response.ok) {
    throw new MivoImageRequestError(
      await readSubmitError(response),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  const view = (await response.json()) as TaskView
  if (view.status === 'failed' && view.error) {
    view.error = formatMivoClientError(undefined, view.error, 'Mivo Task')
  }
  if (view.status === 'partial' && view.failures?.length) {
    view.failures = view.failures.map((failure) => ({
      ...failure,
      error: formatMivoClientError(undefined, failure.error, 'Mivo Task'),
    }))
  }
  return view
}

export type SettleChatTasksResult = Record<string, TaskView>

// FX-3: POST /api/mivo/tasks/settle → 200 {results: Record<taskId, TaskView>}.
// Batch per-user task status query for hydrate-time reconciliation: for each
// taskId the caller owns and that still exists in the registry, the server returns
// its TaskView; omitted = gone/expired (the client treats as expired — a server-
// confirmed settle, replacing the blanket client-side assumption in
// settleExpiredChatMessages). Mirrors pollTask's auth + 401 handling. Used by
// reconcileExpiredChatTasks to recover wrongly-expired mask-edit chat cards whose
// blanket client-side settle was wrong (the task actually succeeded on the server).
// Unlike pollTask, a 404 is impossible here — the endpoint always 200s with a
// possibly-empty results map; an absent taskId in `results` IS the "gone" signal.
export const settleChatTasks = async (taskIds: string[]): Promise<SettleChatTasksResult> => {
  if (taskIds.length === 0) return {}
  const response = await fetchWithTimeout(
    '/api/mivo/tasks/settle',
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds }),
    },
    submitTimeoutMs,
  )
  if (!response.ok) {
    throw new MivoImageRequestError(
      await readSubmitError(response),
      response.status === 504 ? 'upstream-timeout' : 'upstream-error',
    )
  }
  const body = (await response.json()) as { results?: SettleChatTasksResult }
  return body.results ?? {}
}

// DELETE /api/mivo/tasks/:id → 200 {id,status:'canceled'} | 404 (already gone).
// Best-effort: a 404 or network error during DELETE must not mask the original
// abort. All errors are swallowed — the poll loop will observe the terminal state
// on the next GET (or the action's catch has already decided canceled).
export const cancelTask = async (taskId: string, signal?: AbortSignal): Promise<void> => {
  try {
    await fetchWithTimeout(
      `/api/mivo/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE', headers: { ...authHeaders() } },
      pollTimeoutMs,
      signal,
    )
  } catch {
    // Swallow: cancel is advisory. The server aborts the upstream controller on
    // DELETE; if the DELETE itself fails (network/404), the upstream may keep
    // running but the client has already given up — surface 'canceled' locally.
  }
}

// Infer the MivoImageRequestError kind for a failed task. The tasks API has no
// `kind` field, so timeout is inferred from the error wording. This keeps
// chatStore's '中质量重试' button working for high-quality timeouts (it reads
// err.kind === 'upstream-timeout' via isTimeoutErrorKind).
const TIMEOUT_RE = /\btimeout\b|超时|timed[\s-]?out/i
export const kindForFailedTask = (error: string): MivoImageRequestError['kind'] =>
  TIMEOUT_RE.test(error) ? 'upstream-timeout' : 'upstream-error'
