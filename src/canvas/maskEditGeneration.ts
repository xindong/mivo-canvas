// 局部重绘 (mask edit) 占位符生命周期：在源图右侧 AI_SLOT_GAP 预建一个 generating
// 态 ai-slot 占位符（并挤开右侧障碍），生成失败/取消时回退到生成前 history 基线以
// 移除该占位符并撤销 reflow 位移。从 MivoCanvas 抽出，保持该视图在 structure-guard
// 行数预算内，也让"局部重绘占位符"这一职责独立可测。
import type { MivoCanvasNode, MivoCanvasSnapshot } from '../types/mivoCanvas'
import type { MivoImageQuality, MivoImageRatio } from '../types/generation'
import { useCanvasStore } from '../store/canvasStore'
import { useCameraFocusStore } from '../store/cameraFocusStore'
import { AI_SLOT_GAP, reflowRightObstacles } from '../store/aiCanvasWorkflow'
import { defaultSizeForNodeType } from './nodeTypes/canvasNodeRegistry'
import { rollbackLatestHistoryBaseline, patchCanvasDocument } from '../store/canvasDocumentModel'
import { debugLogger } from '../store/debugLogStore'
import { readCanvasImageBlob } from '../lib/canvasImageSource'
import { MivoImageRequestError } from '../lib/mivoImageClient'
import {
  inspectMaskResultForBlackArtifacts,
  mapBoundsToResultSpace,
  type MaskArtifactInput,
} from '../lib/maskResultInspection'
import {
  cancelTask,
  kindForFailedTask,
  pollTask,
  submitEditTask,
  taskPollIntervalMs,
  type TaskResultImage,
} from '../lib/mivoTaskClient'
import { maskEditDefaultModel, maskEditQualityFor, type ImageMaskSubmitPayload, type MaskEditModelId } from './imageMaskGeometry'

/** mask-chat-card: runMaskEditGeneration 回调，让 chat flow 驱动卡片状态而不直写 chat。 */
export type MaskEditGenerationCallbacks = {
  /** submitEditTask 返回 taskId 后立即触发（写入 message.maskEdit.serverTaskId 供 cancel fallback/debug）。 */
  onTaskSubmitted?: (taskId: string) => void
  /** 每次 poll 返 running 进度时触发（先只 patch maskEdit.phase，不新增进度 UI）。 */
  onProgress?: (view: Awaited<ReturnType<typeof pollTask>>) => void
  /** 黑盘自愈重试开始时触发（phase 置 self-heal-retry，card 保持 generating）。 */
  onSelfHealRetry?: (taskIds: string[]) => void
}

const patchMaskEditSlotStatus = (
  sceneId: string,
  slotId: string,
  status: 'generating' | 'failed' | 'canceled',
  prompt: string,
  model: string = maskEditDefaultModel,
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
              model,
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

    // Route through patchCanvasDocument so updatedAt bumps on this content
    // change (placeholder placement / status flip are user-visible). The
    // non-active-scene branch writes canvases only; the active branch also
    // surfaces nodes at the top level — both equivalent to the prior direct
    // spread, but now consistent with the updatedAt hub.
    return patchCanvasDocument(current, sceneId, { nodes: nextNodes })
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
  model: string = maskEditDefaultModel,
): { slotId: string; baselineSnapshot: MivoCanvasSnapshot | undefined } => {
  // 规格(2026-07-05 用户澄清):所有生图占位符一律 1:1 方形 loading,局部重绘不例外
  // (此前按源图全尺寸建占位 → 用户看到 3:2 大占位符);结果比例由生成本身保证
  // (edit 结果与源图同比例),替换时按结果图自然比例等面积落画布(documentSlice)。
  const slotSize = defaultSizeForNodeType('ai-slot')
  const slotId = useCanvasStore
    .getState()
    .addAiSlotNode(
      { x: source.x + source.width + AI_SLOT_GAP, y: source.y },
      slotSize,
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
  patchMaskEditSlotStatus(sceneId, slotId, 'generating', prompt, model)
  // 镜头跟随契约:占位建好后请求 auto-focus;跨场景 skip 判定在 cameraFocusStore
  // 内(#95 语义:不切场景、不动镜头)。
  useCameraFocusStore.getState().requestPlaceholderFocus(slotId, {
    targetSceneId: sceneId,
    activeSceneId: useCanvasStore.getState().sceneId,
    source: 'mask-edit',
  })
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
    // Filter-removal fallback (rollback didn't apply): route through
    // patchCanvasDocument so updatedAt bumps on the node/edge removal.
    return patchCanvasDocument(current, sceneId, { nodes, edges })
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
                ? Math.max(0, Math.round((Date.now() - node.aiWorkflow.startedAt) / 1000))
                : undefined,
            },
          }
        : node,
    )
    // High-frequency machine update (poll progress) — explicitly opt out of the
    // updatedAt bump so progress polling doesn't churn the recent-activity ordering.
    return patchCanvasDocument(current, sceneId, { nodes }, { bumpUpdatedAt: false })
  })
}

/** Run the mask-edit generation: submit an async task, poll for server progress,
 *  commit the result in-place over the prebuilt placeholder (via replaceSlotId),
 *  and append cross-scene notices. Throws on failure/cancel (caller removes the
 *  placeholder via removeMaskEditPlaceholder, threading #81 baselineSnapshot).
 *
 *  W2: switched from sync editMivoImage to the async tasks API (submitEditTask →
 *  poll → cancelTask) so overlay X/Esc can best-effort DELETE the upstream task,
 *  and so the placeholder can show real progress/stage/elapsed. Quality 透传:
 *  overlay 四档选择器（auto/low/medium/high），auto = quality undefined 一路穿透
 *  到 submitEditTask（不带 quality 字段，与 chat 生图路径一致）；server
 *  normalizeMivoQuality 对缺省默认即 medium，行为不回退。low/medium/high 直接
 *  作为 request.quality 传入 submitEditTask。 */
export const runMaskEditGeneration = async (args: {
  sceneId: string
  source: MivoCanvasNode
  slotId: string
  resolvedAssetUrl: string | undefined
  payload: ImageMaskSubmitPayload
  imgRatio: MivoImageRatio
  quality?: MivoImageQuality
  signal: AbortSignal
  /** mask-chat-card: chat flow 经回调驱动卡片状态，runMaskEditGeneration 不再直写 chat。 */
  callbacks?: MaskEditGenerationCallbacks
}): Promise<{ nodeIds: string[]; sourceDeleted: boolean }> => {
  const { sceneId, source, slotId, resolvedAssetUrl, payload, imgRatio, signal } = args
  const callbacks = args.callbacks ?? {}
  // Mask-edit dual-model: overlay/chat 传 payload.model，缺省 gemini。质量按模型
  // 固定（gemini→high=2K，gpt→medium=1K）；显式 quality 仍优先（chat 路径可覆盖）。
  const model: MaskEditModelId = payload.model ?? maskEditDefaultModel
  const quality: MivoImageQuality | undefined = args.quality ?? payload.quality ?? maskEditQualityFor(model)
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
  const runOneAttempt = async (
    idempotencyKey: string,
    /** F2 (审 P2): per-attempt 钩子，submitEditTask 返回后立即触发（poll 前）。
     *  self-heal 用它在 task-2 submit 后立刻 onSelfHealRetry，使重试期间 phase=self-heal-retry 可观测。 */
    onSubmitted?: (taskId: string) => void,
  ): Promise<{ taskId: string; images: TaskResultImage[] }> => {
    if (signal.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
    const submitStartedAt = Date.now()
    const taskId = await submitEditTask({
      image,
      mask: payload.mask,
      maskBounds: payload.maskBounds,
      sourceSize: payload.sourceSize,
      subjectLabel: payload.subjectLabel,
      subjects: payload.subjects,
      markedImage: payload.markedImage,
      prompt: payload.prompt,
      imgRatio,
      quality,
      model,
      idempotencyKey,
      signal,
    })
    // FIX-1: 立即写外层 currentTaskId — poll 中途 abort 时 catch 的 cancelTask 才能 DELETE 这个在途 task。
    currentTaskId = taskId
    // mask-chat-card: 通知 chat flow 已拿到 taskId（写 message.maskEdit.serverTaskId 供 cancel fallback/debug）。
    callbacks.onTaskSubmitted?.(taskId)
    onSubmitted?.(taskId)
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
        callbacks.onProgress?.(view)
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

    // W1 self-heal（黑块修复扩面）: 结果图黑块检测 → 新 idempotencyKey 重试 1 次；
    // 第二次仍异常 → 绝不 commitGenerationResult，抛错走 failMaskEditMessage（移除
    // placeholder + 卡片 error）。宁可失败不落坏图。检测覆盖：当前 mask 区 plate、
    // 上次编辑洞区（source.generation.maskBounds+maskSourceSize 映射）、全图近黑
    // 连通组件（区域外黑块）。仅当有 maskBounds（annotation area-edit 模式）且有
    // 结果 b64 时检测；brush mask 模式无 bounds，跳过检测（保守不重试，行为不变）。
    const canInspect = Boolean(payload.maskBounds && images[0]?.b64)
    if (canInspect) {
      // 历史洞区：source 若是上次局部重绘的结果（generation.maskBounds + maskSourceSize），
      // 把上次洞区从"上次源图空间"等比映射到"当前源图空间"作为高优先检测区。
      // maskSourceSize 缺失（旧数据 / annotation 画布坐标路径）→ 坐标空间不明，跳过。
      const sourceGeneration = source.generation
      const priorMaskBoundsPx =
        sourceGeneration?.maskBounds && sourceGeneration.maskSourceSize
          ? [mapBoundsToResultSpace(sourceGeneration.maskBounds, sourceGeneration.maskSourceSize, payload.sourceSize)]
          : undefined
      const inspectionInput: MaskArtifactInput = {
        sourceSizePx: payload.sourceSize,
        maskBoundsPx: payload.maskBounds!,
        priorMaskBoundsPx,
      }
      const firstInspection = await inspectMaskResultForBlackArtifacts(inspectionInput, {
        sourceBlob: image,
        resultB64: images[0].b64,
      })
      if (firstInspection.hasArtifact) {
        // F2 (审 P2): 拿到 task-2 后立即 onSelfHealRetry（poll 期间 phase=self-heal-retry 可观测），
        // 不再等第二次 attempt 完整结束才触发（旧实现 phase 几乎不可见，SC-13 语义打折）。
        const second = await runOneAttempt(newIdempotencyKey(), (task2Id) => {
          callbacks.onSelfHealRetry?.([first.taskId, task2Id])
        })
        attemptTaskIds.push(second.taskId)
        serverTaskId = second.taskId
        const secondInspection = await inspectMaskResultForBlackArtifacts(inspectionInput, {
          sourceBlob: image,
          resultB64: second.images[0]?.b64 ?? '',
        })
        if (secondInspection.hasArtifact) {
          // 自愈失败不 commit：记录 taskIds + 组件证据后抛错，占位符与卡片由
          // chatMaskEditFlow.failMaskEditMessage 统一收口。
          debugLogger.error(
            'Mask Edit',
            `Black artifact persisted for ${source.title}; rejecting commit. taskIds=${attemptTaskIds.join(',')} ` +
              `first=${firstInspection.reason} second=${secondInspection.reason} ` +
              `components=${JSON.stringify(secondInspection.components)}`,
          )
          throw new MivoImageRequestError('局部重绘结果异常，请重新选择区域或换源图后重试。', 'upstream-error')
        }
        debugLogger.warn(
          'Mask Edit',
          `Black artifact detected for ${source.title} (${firstInspection.reason}); retry recovered. taskIds=${attemptTaskIds.join(',')}`,
        )
        images = second.images
      }
    }

    const commitStartedAt = Date.now()
    // mask-chat-card: commit 前重新检查 source 是否仍存在。source 已删时仍以 replaceSlotId
    // 原位替换 placeholder，但不传 sourceNodeId/lineageSourceId/createDerivationEdge（避免
    // documentSlice 的 source 校验阻断落图）；sourceDeleted 回传给 chat flow 写 message。
    const sourceStillExists = useCanvasStore
      .getState()
      .canvases[sceneId]?.nodes.some((n) => n.id === source.id && n.type === 'image' && !n.hidden) ?? false
    const commitPayload = {
      sceneId,
      ...(sourceStillExists
        ? { sourceNodeId: source.id, lineageSourceId: source.id, createDerivationEdge: true as const }
        : {}),
      replaceSlotId: slotId,
      reflow: true,
      resultImages: images,
      prompt: payload.prompt,
      model,
      kind: 'edit' as const,
      maskBounds: payload.maskBounds,
      // 黑块修复：标定 maskBounds 的坐标空间（本次源图 natural pixel 尺寸），
      // 结果节点作为下次编辑的 source 时用于历史洞区高优先检测。
      maskSourceSize: payload.maskBounds ? { ...payload.sourceSize } : undefined,
      placement: 'right' as const,
    }
    const nodeIds = await useCanvasStore.getState().commitGenerationResult(commitPayload)
    // mask-chat-card: 不再在此处 appendNotice —— 同场景结果图由 chat flow 落 resultNodeIds，
    // 跨场景 notice / chat mode replyText notice 由 chatMaskEditFlow 统一处理。
    debugLogger.log(
      'Mask Edit',
      `Task ${serverTaskId} done for ${source.title}; commit ${Date.now() - commitStartedAt}ms; total ${Date.now() - startedAt}ms; sourceDeleted=${!sourceStillExists}`,
    )
    return { nodeIds, sourceDeleted: !sourceStillExists }
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
