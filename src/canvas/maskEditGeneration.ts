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
import {
  cancelTask,
  kindForFailedTask,
  pollTask,
  submitEditTask,
  taskPollIntervalMs,
} from '../lib/mivoTaskClient'
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
 *  to 'low' (W2.1) — the overlay's quality button group overrides it. */
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
  const quality: MivoImageQuality = args.quality || payload.quality || 'low'
  const startedAt = Date.now()
  const image = await readCanvasImageBlob(source, resolvedAssetUrl)

  let serverTaskId: string | undefined
  const submitStartedAt = Date.now()
  try {
    if (signal.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
    serverTaskId = await submitEditTask({
      image,
      mask: payload.mask,
      prompt: payload.prompt,
      imgRatio,
      quality,
      model: 'gpt-image-2',
      idempotencyKey: newIdempotencyKey(),
      signal,
    })
    debugLogger.log(
      'Mask Edit',
      `Task ${serverTaskId} submitted for ${source.title} (quality=${quality}) in ${Date.now() - submitStartedAt}ms`,
    )

    // Poll loop (mirrors generationSlice.runTaskPollLoop; inlined to keep this
    // module self-contained and avoid a cross-slice refactor).
    for (;;) {
      if (signal.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const view = await pollTask(serverTaskId, signal)

      if (view.status === 'running' || view.status === 'pending') {
        patchMaskEditProgress(sceneId, slotId, view.progress, view.stage)
        await sleep(taskPollIntervalMs(), signal)
        continue
      }
      if (view.status === 'done') {
        const images = view.result?.images ?? []
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
  } catch (error) {
    // W2.2: overlay X/Esc → best-effort DELETE the upstream task before rethrowing
    // so the caller's removeMaskEditPlaceholder rolls back with #81 baselineSnapshot.
    const canceled = Boolean(signal.aborted) || (error instanceof MivoImageRequestError && error.kind === 'canceled')
    if (canceled && serverTaskId) {
      await cancelTask(serverTaskId)
    }
    if (error instanceof MivoImageRequestError) {
      debugLogger.error(
        'Mask Edit',
        `Task ${serverTaskId || '?'} failed for ${source.title} after ${Date.now() - startedAt}ms: ${error.message}`,
      )
    }
    throw error
  }
}
