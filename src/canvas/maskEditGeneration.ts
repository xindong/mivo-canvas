// 局部重绘 (mask edit) 占位符生命周期：在源图右侧 AI_SLOT_GAP 预建一个 generating
// 态 ai-slot 占位符（并挤开右侧障碍），生成失败/取消时回退到生成前 history 基线以
// 移除该占位符并撤销 reflow 位移。从 MivoCanvas 抽出，保持该视图在 structure-guard
// 行数预算内，也让"局部重绘占位符"这一职责独立可测。
import type { MivoCanvasNode, MivoCanvasSnapshot } from '../types/mivoCanvas'
import type { MivoImageQuality, MivoImageRatio } from '../types/generation'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
import { AI_SLOT_GAP, reflowRightObstacles } from '../store/aiCanvasWorkflow'
import { rollbackLatestHistoryBaseline } from '../store/canvasDocumentModel'
import { debugLogger } from '../store/debugLogStore'
import { readCanvasImageBlob } from '../lib/canvasImageSource'
import { MivoImageRequestError } from '../lib/mivoImageClient'
import { inspectMaskResultForBlackPlate } from '../lib/maskResultInspection'
import {
  cancelTask,
  kindForFailedTask,
  pollTask,
  submitEditTask,
  taskPollIntervalMs,
  type TaskResultImage,
} from '../lib/mivoTaskClient'
import { toastFeedback } from '../store/toastStore'
import type { ImageMaskSubmitPayload } from './imageMaskGeometry'

const patchMaskEditSlotStatus = (
  sceneId: string,
  slotId: string,
  status: 'generating' | 'failed' | 'canceled',
  prompt: string,
) => {
  const createdAt = Date.now()
  useCanvasStore.setState((current) => {
    const document = current.canvases[sceneId]
    if (!document) return {}

    const nodes = document.nodes.map((node) =>
      node.id === slotId && node.type === 'ai-slot'
        ? {
            ...node,
            generation: {
              prompt,
              model: 'gpt-image-2',
              size: node.generation?.size || `${Math.round(node.width)}x${Math.round(node.height)}`,
              seed: node.generation?.seed,
              strength: node.generation?.strength,
              createdAt,
            },
            aiWorkflow: {
              ...(node.aiWorkflow || { kind: 'slot' as const }),
              status,
              operation: 'area-edit' as const,
              prompt,
              placement: 'right' as const,
              createdAt,
              // F5: progress/stage/startedAt for the generating-state overlay render.
              ...(status === 'generating'
                ? { progress: node.aiWorkflow?.progress ?? 0, stage: node.aiWorkflow?.stage ?? 'queued', startedAt: createdAt }
                : {}),
            },
          }
        : node,
    )
    const slot = nodes.find((node) => node.id === slotId)
    const nextNodes = status === 'generating' && slot ? reflowRightObstacles(nodes, slot, AI_SLOT_GAP) : nodes
    const nextDocument = { ...document, nodes: nextNodes }

    return {
      ...(sceneId === current.sceneId ? { nodes: nextNodes } : {}),
      canvases: { ...current.canvases, [sceneId]: nextDocument },
    }
  })
}

/** Prebuild a generating ai-slot placeholder to the right of the source image.
 *  Returns the slot id plus the history baseline snapshot captured right after
 *  addAiSlotNode pushes it (undefined when the target scene isn't the active one,
 *  since addAiSlotNode only pushes history for the active scene — see
 *  patchCanvasDocument). The caller threads baselineSnapshot into
 *  removeMaskEditPlaceholder so the rollback is gated on object identity (S01). */
export const prepareMaskEditPlaceholder = (
  sceneId: string,
  source: MivoCanvasNode,
  prompt: string,
): { slotId: string; baselineSnapshot: MivoCanvasSnapshot | undefined } => {
  const slotId = useCanvasStore
    .getState()
    .addAiSlotNode(
      { x: source.x + source.width + AI_SLOT_GAP, y: source.y },
      { width: source.width, height: source.height },
      prompt,
      { sceneId },
    )
  // S01: addAiSlotNode 内部 { history: true } 仅在 sceneId === state.sceneId 时
  // push 基线。非活跃场景下不 push，栈顶是无关快照 —— 此时 baselineSnapshot 必须
  // 置 undefined，否则 removeMaskEditPlaceholder 的 expectedBaseline 校验会误判。
  const baselineSnapshot =
    sceneId === useCanvasStore.getState().sceneId
      ? useCanvasStore.getState().historyPast.at(-1)
      : undefined
  patchMaskEditSlotStatus(sceneId, slotId, 'generating', prompt)
  debugLogger.log('Canvas', `Prepared mask edit placeholder for ${source.title}`)
  return { slotId, baselineSnapshot }
}

/** Remove the placeholder on failure/cancel: revert to the pre-generation history
 *  baseline (also undoing reflow shifts) only when the栈顶仍是 prepare 时捕获的基线
 *  引用； otherwise fall back to a plain node delete that preserves user edits made
 *  during the async generation (S01: 保编辑 > 还原位移). */
export const removeMaskEditPlaceholder = (
  sceneId: string,
  slotId: string,
  context: {
    canceled?: boolean
    error?: string
    sourceTitle?: string
    baselineSnapshot?: MivoCanvasSnapshot
  } = {},
) => {
  useCanvasStore.setState((current) => {
    const rollback = context.baselineSnapshot
      ? rollbackLatestHistoryBaseline(current, sceneId, {
          removeNodeId: slotId,
          expectedBaseline: context.baselineSnapshot,
        })
      : undefined
    if (rollback) return rollback

    const document = current.canvases[sceneId]
    if (!document) return {}
    const nodes = document.nodes.filter((node) => node.id !== slotId)
    const edges = (document.edges || []).filter((edge) => edge.from !== slotId && edge.to !== slotId)
    return {
      ...(sceneId === current.sceneId ? { nodes, edges } : {}),
      canvases: { ...current.canvases, [sceneId]: { ...document, nodes, edges } },
    }
  })

  const title = context.sourceTitle || slotId
  if (context.canceled) {
    debugLogger.warn('Canvas', `Mask edit canceled for ${title}; placeholder removed`)
  } else {
    debugLogger.error('Canvas', `Mask edit failed for ${title}; placeholder removed: ${context.error || ''}`)
  }
}

// W2 (QoL batch): one-time idempotency key per mask-edit call. Self-heal retry
// (W1) MUST regenerate a new key — the BFF registry dedupes by key, so reusing the
// original failed-call's key would silently return the cached black-plate task.
const newIdempotencyKey = (): string => {
  const crypto = globalThis.crypto as Crypto | undefined
  if (crypto?.randomUUID) return crypto.randomUUID()
  return `mivo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// Sleep that rejects with MivoImageRequestError(kind='canceled') on abort, so the
// poll loop surfaces cancel promptly without waiting for the next GET. Mirrors
// generationSlice's sleep (same cancel semantics).
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MivoImageRequestError('图片请求已取消。', 'canceled'))
      return
    }
    const onAbort = () => {
      window.clearTimeout(id)
      reject(new MivoImageRequestError('图片请求已取消。', 'canceled'))
    }
    const id = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

// F5: patch the placeholder's aiWorkflow progress/stage on each non-terminal poll
// so the overlay can render a live progress bar + stage label + elapsed time.
// elapsedSec is derived here (not in render) to keep CanvasNodeView pure.
const patchMaskEditProgress = (
  sceneId: string,
  slotId: string,
  progress: number,
  stage: string,
) => {
  useCanvasStore.setState((current) => {
    const document = current.canvases[sceneId]
    if (!document) return {}
    const now = Date.now()
    const nodes = document.nodes.map((node) =>
      node.id === slotId && node.type === 'ai-slot' && node.aiWorkflow
        ? {
            ...node,
            aiWorkflow: {
              ...node.aiWorkflow,
              status: 'generating' as const,
              progress,
              stage,
              elapsedSec: node.aiWorkflow.startedAt
                ? Math.max(0, Math.round((now - node.aiWorkflow.startedAt) / 1000))
                : undefined,
            },
          }
        : node,
    )
    return {
      ...(sceneId === current.sceneId ? { nodes } : {}),
      canvases: { ...current.canvases, [sceneId]: { ...document, nodes } },
    }
  })
}

/** Run the mask-edit generation: submit an async task, poll for server progress,
 *  commit the result in-place over the prebuilt placeholder (via replaceSlotId),
 *  and append cross-scene notices. Throws on failure/cancel (caller removes the
 *  placeholder via removeMaskEditPlaceholder, threading #81 baselineSnapshot).
 *
 *  W2: switched from sync editMivoImage to the async tasks API (submitEditTask →
 *  poll → cancelTask) so overlay X/Esc can best-effort DELETE the upstream task,
 *  and so the placeholder can show real progress/stage/elapsed. Quality defaults
 *  to 'medium' — the overlay's quality button group (low/medium) overrides it;
 *  FIX-5: low 不提速（冒烟实测 low≈medium 延迟），默认改回 medium，low/medium 选择器供成本权衡。 */
export const runMaskEditGeneration = async (args: {
  sceneId: string
  source: MivoCanvasNode
  slotId: string
  resolvedAssetUrl: string | undefined
  payload: ImageMaskSubmitPayload
  imgRatio: MivoImageRatio
  quality?: MivoImageQuality
  signal: AbortSignal
}): Promise<string[]> => {
  const { sceneId, source, slotId, resolvedAssetUrl, payload, imgRatio, signal } = args
  const quality: MivoImageQuality = args.quality || payload.quality || 'medium'
  const startedAt = Date.now()
  const image = await readCanvasImageBlob(source, resolvedAssetUrl)

  // FIX-1: currentTaskId tracks the IN-FLIGHT server task for cancel. Set inside
  // runOneAttempt right after submitEditTask returns (BEFORE the poll loop), so an
  // abort during poll still knows which task to DELETE. serverTaskId (assigned only
  // after a successful attempt) stays undefined mid-attempt → cancelTask silently
  // no-op'd, orphaning the in-flight task; self-heal retry abort could even DELETE
  // the previous attempt's stale id. Each attempt overwrites currentTaskId with its
  // own fresh id so retry-abort DELETEs the right (new) task.
  let currentTaskId: string | undefined

  // W1: submit+poll 抽成单次尝试，便于黑盘自愈时用新 idempotencyKey 重跑一次。
  // newIdempotencyKey 必须每次重试都重新生成 —— BFF registry 按 key dedupe，复用
  // 原失败调用的 key 会静默返回缓存的黑盘 task（F3）。progress patch 在 poll loop
  // 内，重试时 placeholder 仍在，进度字段继续刷新。
  const runOneAttempt = async (idempotencyKey: string): Promise<{ taskId: string; images: TaskResultImage[] }> => {
    if (signal.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
    const submitStartedAt = Date.now()
    const taskId = await submitEditTask({
      image,
      mask: payload.mask,
      prompt: payload.prompt,
      imgRatio,
      quality,
      model: 'gpt-image-2',
      idempotencyKey,
      signal,
    })
    // FIX-1: 立即写外层 currentTaskId — poll 中途 abort 时 catch 的 cancelTask 才能 DELETE 这个在途 task。
    currentTaskId = taskId
    debugLogger.log(
      'Mask Edit',
      `Task ${taskId} submitted for ${source.title} (quality=${quality}) in ${Date.now() - submitStartedAt}ms`,
    )

    // Poll loop (mirrors generationSlice.runTaskPollLoop; inlined to keep this
    // module self-contained and avoid a cross-slice refactor).
    for (;;) {
      if (signal.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const view = await pollTask(taskId, signal)

      if (view.status === 'running' || view.status === 'pending') {
        patchMaskEditProgress(sceneId, slotId, view.progress, view.stage)
        await sleep(taskPollIntervalMs(), signal)
        continue
      }
      if (view.status === 'done') {
        return { taskId, images: view.result?.images ?? [] }
      }
      if (view.status === 'failed') {
        const message = view.error || '局部重绘失败'
        throw new MivoImageRequestError(message, kindForFailedTask(message))
      }
      if (view.status === 'canceled') {
        throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      }
      // unknown — server restarted / task evicted. Never commit; surface retry.
      throw new MivoImageRequestError('任务已失效（服务端重启），请重试。', 'upstream-error')
    }
  }

  let serverTaskId: string | undefined
  try {
    const first = await runOneAttempt(newIdempotencyKey())
    serverTaskId = first.taskId
    let images = first.images
    const attemptTaskIds = [first.taskId]

    // W1 self-heal: 检测结果图黑盘 → 新 idempotencyKey 重试 1 次。
    // 仅当有 maskBounds（annotation area-edit 模式）且有结果 b64 时检测；brush
    // mask 模式无 bounds，跳过检测（保守不重试）。二次仍黑 → 照常 commit 重试
    // 结果 + warn toast + debugLogger.error 附两个 taskId 证据。
    const canInspect = Boolean(payload.maskBounds && images[0]?.b64)
    if (canInspect) {
      const blackPlate = await inspectMaskResultForBlackPlate(
        { sourceSizePx: payload.sourceSize, maskBoundsPx: payload.maskBounds! },
        { sourceBlob: image, resultB64: images[0].b64 },
      )
      if (blackPlate) {
        const second = await runOneAttempt(newIdempotencyKey())
        attemptTaskIds.push(second.taskId)
        serverTaskId = second.taskId
        const secondBlack = await inspectMaskResultForBlackPlate(
          { sourceSizePx: payload.sourceSize, maskBoundsPx: payload.maskBounds! },
          { sourceBlob: image, resultB64: second.images[0]?.b64 ?? '' },
        )
        if (secondBlack) {
          toastFeedback.warn('局部重绘结果异常，已使用重试结果，请检查画面')
          debugLogger.error(
            'Mask Edit',
            `Black plate detected for ${source.title}; both attempts returned black plates. taskIds=${attemptTaskIds.join(',')}`,
          )
        } else {
          debugLogger.warn(
            'Mask Edit',
            `Black plate detected for ${source.title}; retry recovered. taskIds=${attemptTaskIds.join(',')}`,
          )
        }
        images = second.images
      }
    }

    const commitStartedAt = Date.now()
    const commitPayload = {
      sceneId,
      sourceNodeId: source.id,
      lineageSourceId: source.id,
      replaceSlotId: slotId,
      reflow: true,
      resultImages: images,
      prompt: payload.prompt,
      model: 'gpt-image-2',
      kind: 'edit' as const,
      createDerivationEdge: true,
      maskBounds: payload.maskBounds,
      placement: 'right' as const,
    }
    const nodeIds = await useCanvasStore.getState().commitGenerationResult(commitPayload)
    const latest = useCanvasStore.getState()
    useChatStore.getState().appendNotice({ sceneId, origin: 'mask-edit', nodeIds, prompt: payload.prompt })
    if (latest.sceneId !== sceneId) {
      const title = latest.canvases[sceneId]?.title || sceneId
      useChatStore
        .getState()
        .appendNotice({ sceneId: latest.sceneId, origin: 'mask-edit', prompt: `结果已生成到画布 ${title}` })
    }
    debugLogger.log(
      'Mask Edit',
      `Task ${serverTaskId} done for ${source.title}; commit ${Date.now() - commitStartedAt}ms; total ${Date.now() - startedAt}ms`,
    )
    return nodeIds
  } catch (error) {
    // W2.2: overlay X/Esc → best-effort DELETE the upstream task before rethrowing
    // so the caller's removeMaskEditPlaceholder rolls back with #81 baselineSnapshot.
    // FIX-1: cancel the IN-FLIGHT task (currentTaskId, set mid-attempt), not
    // serverTaskId (only set after a successful attempt). Without this, an abort
    // during poll left serverTaskId undefined → cancelTask no-op'd → orphaned task.
    const canceled = Boolean(signal.aborted) || (error instanceof MivoImageRequestError && error.kind === 'canceled')
    if (canceled && currentTaskId) {
      await cancelTask(currentTaskId)
    }
    if (error instanceof MivoImageRequestError) {
      debugLogger.error(
        'Mask Edit',
        `Task ${currentTaskId || serverTaskId || '?'} failed for ${source.title} after ${Date.now() - startedAt}ms: ${error.message}`,
      )
    }
    throw error
  }
}
