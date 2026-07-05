// src/store/chatMaskEditFlow.ts
// mask-chat-card: 局部重绘任务并入对话生图卡片链路。本模块是 mask edit 的 chat flow
// 主体 —— 创建 user+assistant enhancing 卡片、跑 enhance(intent:'edit')→runMaskEditGeneration、
// 按 messageId 更新 submitted/done/error、统一 cross-scene notice、提供 cancelMaskEditMessage
// 给 chatStore.cancelGeneration 委托。chatStore 只暴露薄 action + cancelGeneration 分发，
// 主体在此（保持 chatStore.ts <= 833 行红线，参考 chatEnhanceFlow/chatGenerationHydration 先例）。
//
// 运行时循环注意：本模块 import useChatStore（runtime），chatStore 反向 import cancelMaskEditMessage
// （runtime）—— ESM live binding，双方只在函数体内访问对方导出，不在模块加载期访问，无 TDZ。
import type { ChatGenerationContext, ChatMessage } from './chatStore'
import type { EnhanceResponse, MivoImageQuality, MivoImageRatio } from '../types/generation'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { ImageMaskSubmitPayload } from '../canvas/imageMaskGeometry'
import { useChatStore } from './chatStore'
import { useCanvasStore } from './canvasStore'
import { debugLogger } from './debugLogStore'
import { enhanceMivoPrompt, MivoImageRequestError } from '../lib/mivoImageClient'
import { resolveMaskEditEnhance, enhanceForGeneration } from './chatEnhanceFlow'
import { removeMaskEditPlaceholder, runMaskEditGeneration } from '../canvas/maskEditGeneration'
import {
  clearMaskEditTask,
  abortMaskEditTask,
  type ActiveMaskEditTask,
} from './maskEditTaskRuntime'

const canceledGenerationMessage = '已取消生成，可修改提示后重试。'
const maskEditRetryDisabledReason = '局部重绘任务已结束，请重新选择区域后再试'

export type MaskEditMessagePhase = 'enhancing' | 'submitting' | 'polling' | 'self-heal-retry'

const createId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`

/** 构造 enhance edit 的 editContext（源图像素空间，零换算透传 payload.maskBounds）。 */
const buildEditContext = (source: MivoCanvasNode, payload: ImageMaskSubmitPayload) => ({
  sourceTitle: source.title,
  hasMask: Boolean(payload.mask),
  maskKind: (payload.maskBounds ? 'bounds' : 'brush') as 'brush' | 'bounds',
  maskBoundsPx: payload.maskBounds,
  sourceSize: payload.sourceSize,
})

/** patch 一条 assistant message（按 sceneId/messageId 精确定位）。 */
const patchAssistantMessage = (
  sceneId: string,
  messageId: string,
  patch: (message: ChatMessage) => ChatMessage,
): void => {
  useChatStore.setState((s) => {
    const prev = s.messagesByScene[sceneId]
    if (!prev) return {}
    return {
      messagesByScene: {
        ...s.messagesByScene,
        [sceneId]: prev.map((m) => (m.id === messageId ? patch(m) : m)),
      },
    }
  })
}

const patchMaskEditPhase = (sceneId: string, messageId: string, phase: MaskEditMessagePhase, serverTaskId?: string): void => {
  patchAssistantMessage(sceneId, messageId, (m) => ({
    ...m,
    generationContext: {
      ...(m.generationContext as ChatGenerationContext),
      maskEdit: { ...(m.generationContext as ChatGenerationContext).maskEdit, phase, ...(serverTaskId ? { serverTaskId } : {}) },
    },
  }))
}

/** 创建 user prompt + assistant enhancing 卡片，返回 messageId。 */
export const beginMaskEditMessage = (args: {
  sceneId: string
  source: MivoCanvasNode
  prompt: string
  slotId: string
  imgRatio: MivoImageRatio
  quality: MivoImageQuality | undefined
}): string => {
  const messageId = createId('mask-msg')
  const now = Date.now()
  const userMessage: ChatMessage = {
    id: createId('mask-user'),
    role: 'user',
    kind: 'text',
    text: args.prompt,
    createdAt: now,
    status: 'done',
    origin: 'mask-edit',
  }
  const assistantMessage: ChatMessage = {
    id: messageId,
    role: 'assistant',
    kind: 'text',
    text: '',
    createdAt: now,
    status: 'enhancing',
    origin: 'mask-edit',
    generationContext: {
      sourceNodeId: args.source.id,
      sourceNodeType: 'image',
      model: 'gpt-image-2',
      requestedImgRatio: args.imgRatio,
      requestedQuality: args.quality ?? 'auto',
      imgRatio: args.imgRatio,
      quality: args.quality,
      pendingSlotId: args.slotId,
      maskEdit: { sourceTitle: args.source.title, phase: 'enhancing' },
    } as ChatGenerationContext,
  }
  useChatStore.setState((s) => {
    const prev = s.messagesByScene[args.sceneId] || []
    return {
      messagesByScene: {
        ...s.messagesByScene,
        [args.sceneId]: [...prev, userMessage, assistantMessage],
      },
    }
  })
  return messageId
}

/** 成功收口：同一 patch 写 resultNodeIds + status done + sourceDeleted + 清 error；追加 notice（若 noticeText 或跨场景）。 */
export const finishMaskEditMessage = (args: {
  sceneId: string
  messageId: string
  nodeIds: string[]
  sourceDeleted: boolean
  noticeText?: string
}): void => {
  patchAssistantMessage(args.sceneId, args.messageId, (m) => ({
    ...m,
    status: 'done' as const,
    resultNodeIds: args.nodeIds,
    error: undefined,
    errorKind: undefined,
    timeoutRetryKey: undefined,
    timeoutRetryCount: undefined,
    retryDisabledReason: undefined,
    generationContext: {
      ...(m.generationContext as ChatGenerationContext),
      maskEdit: {
        ...((m.generationContext as ChatGenerationContext).maskEdit),
        sourceDeleted: args.sourceDeleted,
        phase: undefined,
      },
    },
  }))
  // 跨场景 notice：若当前 scene 已切走，在当前 scene 追加指向目标画布的 notice。
  const currentSceneId = useCanvasStore.getState().sceneId
  if (currentSceneId !== args.sceneId) {
    const title = useCanvasStore.getState().canvases[args.sceneId]?.title || args.sceneId
    useChatStore.getState().appendNotice({
      sceneId: currentSceneId,
      origin: 'mask-edit',
      prompt: `结果已生成到画布 ${title}`,
    })
  }
  // chat mode replyText 作为附言 notice（W4 永远先出图语义）。
  if (args.noticeText) {
    useChatStore.getState().appendNotice({
      sceneId: currentSceneId,
      origin: 'mask-edit',
      prompt: args.noticeText,
    })
  }
}

/** 失败收口：移除 placeholder + message 转 error + retryDisabledReason + 跨场景 notice。 */
export const failMaskEditMessage = (args: {
  sceneId: string
  messageId: string
  canceled: boolean
  error: string
  errorKind?: string
  slotId: string
  baselineSnapshot?: unknown
  sourceTitle?: string
}): void => {
  removeMaskEditPlaceholder(args.sceneId, args.slotId, {
    canceled: args.canceled,
    error: args.error,
    sourceTitle: args.sourceTitle,
    baselineSnapshot: args.baselineSnapshot as never,
  })
  patchAssistantMessage(args.sceneId, args.messageId, (m) => ({
    ...m,
    status: 'error' as const,
    error: args.canceled ? canceledGenerationMessage : args.error,
    errorKind: (args.canceled ? 'canceled' : args.errorKind || 'unknown') as never,
    timeoutRetryKey: undefined,
    timeoutRetryCount: undefined,
    retryDisabledReason: maskEditRetryDisabledReason,
    generationContext: {
      ...(m.generationContext as ChatGenerationContext),
      maskEdit: { ...((m.generationContext as ChatGenerationContext).maskEdit), phase: undefined },
    },
  }))
  const currentSceneId = useCanvasStore.getState().sceneId
  if (currentSceneId !== args.sceneId) {
    useChatStore.getState().appendNotice({
      sceneId: currentSceneId,
      origin: 'mask-edit',
      prompt: `局部重绘失败：${args.error}`,
    })
  }
}

/** 后台 flow：enhance(intent:'edit') → patch generating → runMaskEditGeneration(callbacks) → finish/fail。
 *  由 useMaskPointArmed.submitMaskEdit 调度（void，不 await 全程）。 */
export const runMaskEditChatFlow = async (record: ActiveMaskEditTask): Promise<void> => {
  const { sceneId, messageId, slotId, source, resolvedAssetUrl, payload, abortController, imgRatio, quality } = record
  const signal = abortController.signal
  try {
    // 1. enhance(intent:'edit')。await 后立即查 signal.aborted —— enhanceMivoPrompt 把 abort
    //    归类为 upstream-network，不能依赖它区分，必须自己查，否则 cancel 后会当 degraded 继续 edit。
    const enhanceResult: EnhanceResponse = await enhanceMivoPrompt({
      prompt: payload.prompt,
      modelId: 'gpt-image-2',
      hasSelectedImage: true,
      sceneId,
      intent: 'edit',
      editContext: buildEditContext(source, payload),
      signal,
    })
    if (signal.aborted) throw new MivoImageRequestError(canceledGenerationMessage, 'canceled')

    // 2. resolve finalPrompt/noticeText（W4 三态：generate/chat/degraded 都先出图）。
    const { finalPrompt, noticeText } = resolveMaskEditEnhance(enhanceResult, payload.prompt)
    const enhance = enhanceForGeneration(enhanceResult)

    // 3. patch assistant → generating（写 enhance/finalPrompt/noticeText/maskEdit.phase=submitting）。
    patchAssistantMessage(sceneId, messageId, (m) => ({
      ...m,
      status: 'generating' as const,
      text: finalPrompt,
      enhance,
      error: undefined,
      errorKind: undefined,
      retryDisabledReason: undefined,
      generationContext: {
        ...(m.generationContext as ChatGenerationContext),
        finalPrompt,
        noticeText,
        maskEdit: { ...((m.generationContext as ChatGenerationContext).maskEdit), phase: 'submitting' },
      },
    }))

    // 4. runMaskEditGeneration（callbacks 驱动卡片 phase；成功返 {nodeIds, sourceDeleted}）。
    const { nodeIds, sourceDeleted } = await runMaskEditGeneration({
      sceneId,
      source,
      slotId,
      resolvedAssetUrl,
      payload: { ...payload, prompt: finalPrompt },
      imgRatio,
      quality,
      signal,
      callbacks: {
        onTaskSubmitted: (taskId) => patchMaskEditPhase(sceneId, messageId, 'polling', taskId),
        onProgress: () => patchMaskEditPhase(sceneId, messageId, 'polling'),
        onSelfHealRetry: () => patchMaskEditPhase(sceneId, messageId, 'self-heal-retry'),
      },
    })

    // 5. 成功收口。
    finishMaskEditMessage({ sceneId, messageId, nodeIds, sourceDeleted, noticeText })
    clearMaskEditTask(messageId)
    debugLogger.log('Mask Edit', `Mask chat flow done for ${source.title} (msg ${messageId})`)
  } catch (error) {
    const canceled = Boolean(signal.aborted) || (error instanceof MivoImageRequestError && error.kind === 'canceled')
    const logMessage = error instanceof Error ? error.message : '局部重绘失败'
    const errorKind = error instanceof MivoImageRequestError ? error.kind : undefined
    failMaskEditMessage({
      sceneId,
      messageId,
      canceled,
      error: logMessage,
      errorKind,
      slotId,
      baselineSnapshot: record.baselineSnapshot,
      sourceTitle: source.title,
    })
    clearMaskEditTask(messageId)
    debugLogger.log('Mask Edit', `Mask chat flow failed for ${source.title} (msg ${messageId}): ${logMessage}`)
  }
}

/** cancelGeneration 委托：取消指定 messageId 的 mask edit 后台任务。
 *  - runtime 有 record：abort controller，返回；真正 cancelTask+removeMaskEditPlaceholder+mark error 由后台 catch 收口。
 *  - runtime 无 record 但 message 有 serverTaskId+pendingSlotId：best-effort cancelTask + filter 删 placeholder（无 baselineSnapshot）+ message 标 canceled error。
 *  不触碰 activeChatAbortController（普通 chat 单例），保证 chat×mask 并行取消隔离（SC-19）。 */
export const cancelMaskEditMessage = (sceneId: string, messageId: string): void => {
  if (abortMaskEditTask(messageId)) {
    debugLogger.log('Mask Edit', `Cancel dispatched to in-flight mask runtime for ${messageId}`)
    return
  }
  // runtime 已不在（刷新后 / flow 已结束）—— best-effort 走 message 里留的 serverTaskId/pendingSlotId。
  const message = (useChatStore.getState().messagesByScene[sceneId] || []).find((m) => m.id === messageId)
  const serverTaskId = message?.generationContext?.maskEdit?.serverTaskId
  const slotId = message?.generationContext?.pendingSlotId
  if (serverTaskId) {
    // cancelTask 是 async 但这里同步分发；后台 catch 会处理 message 终态。若无 runtime，直接标 error。
    void import('../lib/mivoTaskClient').then(({ cancelTask }) => {
      cancelTask(serverTaskId).catch(() => {})
    })
  }
  if (slotId) {
    removeMaskEditPlaceholder(sceneId, slotId, { canceled: true, sourceTitle: message?.generationContext?.maskEdit?.sourceTitle })
  }
  patchAssistantMessage(sceneId, messageId, (m) => ({
    ...m,
    status: 'error' as const,
    error: canceledGenerationMessage,
    errorKind: 'canceled' as never,
    timeoutRetryKey: undefined,
    timeoutRetryCount: undefined,
    retryDisabledReason: maskEditRetryDisabledReason,
  }))
}
