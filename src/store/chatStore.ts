import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { EnhanceDegradedReason, GenerationRatio, MivoImageQuality } from '../types/generation'
import { readImportedAssetFile, saveImportedAsset } from '../lib/assetStorage'
import { idbStateStorage } from '../lib/persistIdbStorage'
import { MivoImageRequestError, enhanceMivoPrompt, type MivoImageRequestErrorKind } from '../lib/mivoImageClient'
import { getModelCapabilities } from '../lib/modelCapabilities'
import { settleCanvasGenerationLocally } from './canvasGenerationCancel'
import { fallbackCancelTarget, settleExpiredChatMessages } from './chatGenerationHydration'
import { resolveChatEnhance, enhanceForGeneration, historyForEnhance, trimSceneMessages } from './chatEnhanceFlow'
import { cancelMaskEditMessage } from './chatMaskEditFlow'
import { debugLogger } from './debugLogStore'
import { generationFacade } from './generationFacade'
import { clampChatGenerationContext, migrateChatPersistedState, sanitizeEnhanceDegradedReason } from './chatStoreMigrate'

export type ChatMessageStatus = 'enhancing' | 'generating' | 'done' | 'error'
export type ChatMessageOrigin = 'chat' | 'mask-edit'
export type ChatMessageErrorKind = MivoImageRequestErrorKind | 'unknown'

export type ChatEnhanceResult = {
  scene?: string
  reasoning?: string
  richPrompt?: string
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  /** FIX-3: 收窄为 union，不放宽回 string。persisted legacy 字符串在
   *  chatStoreMigrate.sanitizeEnhanceDegradedReason 处 runtime normalize。 */
  degradedReason?: EnhanceDegradedReason
  /** W4: 哪一档 LLM 降级（primary/fallback），透传自 EnhanceResponse.stage。 */
  stage?: 'primary' | 'fallback'
}

export type ChatParamOverrides = {
  imgRatio: 'auto' | GenerationRatio
  quality: 'auto' | MivoImageQuality
}

export type MaskEditMessageContext = {
  sourceTitle?: string
  serverTaskId?: string
  sourceDeleted?: boolean
  phase?: 'enhancing' | 'submitting' | 'polling' | 'self-heal-retry'
}

export type ChatGenerationContext = {
  sourceNodeId?: string
  sourceNodeType?: string
  referenceAssetUrls?: string[]
  model: string
  requestedImgRatio: ChatParamOverrides['imgRatio']
  requestedQuality: ChatParamOverrides['quality']
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  finalPrompt?: string
  pendingSlotId?: string
  /** FIX-4: chat 模式澄清附言（replyText）持久化到 context，retry 不重跑 enhance
   *  时也能从 context 读回并在生成成功后 appendNotice，与 send 路径语义一致。 */
  noticeText?: string
  /** mask-chat-card: mask edit 卡片状态机。runtime 不持久化（abortController/Blob 不可序列化），
   *  但 serverTaskId/sourceDeleted 持久化供刷新后 cancel fallback 与归因。 */
  maskEdit?: MaskEditMessageContext
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  kind?: 'text' | 'notice'
  text: string
  createdAt: number
  status: ChatMessageStatus
  enhance?: ChatEnhanceResult
  resultNodeIds?: string[]
  origin?: ChatMessageOrigin
  error?: string
  errorKind?: ChatMessageErrorKind
  timeoutRetryKey?: string
  timeoutRetryCount?: number
  selectedNodeId?: string
  selectedNodeType?: string
  generationContext?: ChatGenerationContext
  retryDisabledReason?: string
}

type ChatState = {
  messagesByScene: Record<string, ChatMessage[]>
  selectedModel: string
  paramOverrides: ChatParamOverrides
  isBusy: boolean
  sendMessage: (options: {
    sceneId: string
    text: string
    selectedNodeId?: string
    selectedNodeType?: string
    referenceFiles?: File[]
  }) => Promise<void>
  appendNotice: (options: {
    sceneId: string
    origin: ChatMessageOrigin
    nodeIds?: string[]
    prompt?: string
  }) => void
  retryMessage: (options: { sceneId: string; messageId: string; qualityOverride?: MivoImageQuality }) => Promise<void>
  cancelGeneration: (options?: { sceneId?: string; messageId?: string }) => void
  clearScene: (sceneId: string) => void
  setSelectedModel: (modelId: string) => void
  setParamOverride: (key: keyof ChatParamOverrides, value: string) => void
}

const createMessageId = () => `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const canceledGenerationMessage = '已取消生成，可修改提示后重试。'
const referenceAssetMissingMessage = '参考图已失效，无法重试'
const timeoutRetryAdviceHigh = '建议降低质量或换比例'
const timeoutRetryAdviceNeutral = '可稍后重试、换比例或减少参考图'
let activeChatAbortController: AbortController | null = null

const saveReferenceAssets = async (files: File[]) =>
  Promise.all(files.map(async (file) => (await saveImportedAsset(file)).assetUrl))

const referenceFilesFromAssets = async (assetUrls: string[] = []) => {
  const assets = await Promise.all(assetUrls.map((assetUrl) => readImportedAssetFile(assetUrl)))
  if (assets.some((asset) => !asset)) throw new Error(referenceAssetMissingMessage)

  return assets.map((asset) => new File([asset!.blob], asset!.name, { type: asset!.type || asset!.blob.type }))
}

const isTimeoutErrorKind = (kind?: ChatMessageErrorKind) =>
  kind === 'client-timeout' || kind === 'upstream-timeout'

const timeoutRetryKeyForContext = (context: ChatGenerationContext) =>
  JSON.stringify({
    model: context.model,
    imgRatio: context.imgRatio || '',
    quality: context.quality || 'medium',
    finalPrompt: context.finalPrompt || '',
    sourceNodeId: context.sourceNodeId || '',
    sourceNodeType: context.sourceNodeType || '',
    referenceAssetUrls: context.referenceAssetUrls || [],
  })

const errorInfoForChat = (err: unknown, signal?: AbortSignal): { message: string; kind: ChatMessageErrorKind } => {
  if (signal?.aborted) return { message: canceledGenerationMessage, kind: 'canceled' }
  if (err instanceof MivoImageRequestError) {
    return {
      message: err.kind === 'canceled' ? canceledGenerationMessage : err.message,
      kind: err.kind,
    }
  }
  return { message: err instanceof Error ? err.message : 'Generation failed', kind: 'unknown' }
}

const errorTextForChat = (
  message: string,
  kind: ChatMessageErrorKind,
  timeoutRetryCount?: number,
  quality?: string,
) => {
  if (!isTimeoutErrorKind(kind) || (timeoutRetryCount || 0) < 2) return message
  const advice = quality === 'high' ? timeoutRetryAdviceHigh : timeoutRetryAdviceNeutral
  return `${message}，${advice}`
}

// enhanceForGeneration / historyForEnhance / trimSceneMessages / maxMessagesPerScene
// 已外迁到 ./chatEnhanceFlow.ts（mask-chat-card：保持 chatStore.ts <= 833 行红线）。

// clampChatGenerationContext / migrateChatPersistedState / ChatPersistedState /
// sanitizeMessagesByScene 已抽到 ./chatStoreMigrate.ts（保持本文件在 structure-guard
// 900 行阈值内，同 #76 把 migratePersistedState 搬到 canvasGenerationHydration.ts 的先例）。

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messagesByScene: {},
      selectedModel: 'gemini-3-pro-image',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      isBusy: false,

      sendMessage: async ({ sceneId, text, selectedNodeId, selectedNodeType, referenceFiles = [] }) => {
        const state = get()
        if (state.isBusy) return

        const { selectedModel, paramOverrides } = state
        // S03b: 参考图保存失败不再静默丢消息——catch 内自包含地构造并落 user +
        // assistant 两条消息（那时 userMessage 尚未构造，不能依赖函数后续逻辑），
        // 避免用户输入凭空消失。isBusy 此刻未置 true，无残留。
        let referenceAssetUrls: string[]
        try {
          referenceAssetUrls = await saveReferenceAssets(referenceFiles)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          debugLogger.error('Chat Store', `参考图保存失败，消息以失败态落档：${message}`)
          const failedUserMessage: ChatMessage = {
            id: createMessageId(),
            role: 'user',
            kind: 'text',
            text,
            createdAt: Date.now(),
            status: 'done',
            selectedNodeId,
            selectedNodeType,
          }
          const failedAssistantMessage: ChatMessage = {
            id: createMessageId(),
            role: 'assistant',
            kind: 'text',
            text: `参考图保存失败：${message}`,
            createdAt: Date.now(),
            status: 'error',
            error: `参考图保存失败：${message}`,
            errorKind: 'unknown',
            // S03b: 无 generationContext 可供 retryMessage 重放（参考图未保存成功），
            // 显式禁用 Retry 按钮避免死按钮（ChatMessageList 对 status:'error' 且无
            // retryDisabledReason 的消息会渲染可点 Retry，点击后 retryMessage 因无
            // context 直接 return）。引导用户重新选择图片后再发送。
            retryDisabledReason: '参考图保存失败，请重新选择图片后再发送',
          }
          set((s) => ({
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: trimSceneMessages([
                ...(s.messagesByScene[sceneId] || []),
                failedUserMessage,
                failedAssistantMessage,
              ]),
            },
          }))
          return
        }
        if (get().isBusy) return

        const abortController = new AbortController()
        activeChatAbortController = abortController

        const existingMessages = get().messagesByScene[sceneId] || []
        const userMessageId = createMessageId()
        const assistantMessageId = createMessageId()
        const initialContext: ChatGenerationContext = {
          sourceNodeId: selectedNodeId,
          sourceNodeType: selectedNodeType,
          referenceAssetUrls,
          model: selectedModel,
          requestedImgRatio: paramOverrides.imgRatio,
          requestedQuality: paramOverrides.quality,
        }

        const userMessage: ChatMessage = {
          id: userMessageId,
          role: 'user',
          kind: 'text',
          text,
          createdAt: Date.now(),
          status: 'done',
          selectedNodeId,
          selectedNodeType,
          generationContext: initialContext,
        }
        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          kind: 'text',
          text: '',
          createdAt: Date.now(),
          status: 'enhancing',
          generationContext: initialContext,
        }
        let context = initialContext

        set((s) => ({
          isBusy: true,
          messagesByScene: {
            ...s.messagesByScene,
            [sceneId]: trimSceneMessages([...existingMessages, userMessage, assistantMessage]),
          },
        }))

        try {
          const history = historyForEnhance(existingMessages)
          const hasSelectedImage = selectedNodeType === 'image'

          const enhanceResult = await enhanceMivoPrompt({
            prompt: text,
            modelId: selectedModel,
            history,
            hasSelectedImage,
            sceneId,
            signal: abortController.signal,
          })
          if (abortController.signal.aborted) throw new Error(canceledGenerationMessage)

          const enhance = enhanceForGeneration(enhanceResult)
          // W4: chat 模式不再早 return —— 用原始 text 生图，replyText 经 appendNotice
          // 作附言。generate 模式 finalPrompt = richPrompt || text，无附言。
          const { finalPrompt, noticeText } = resolveChatEnhance(enhanceResult, text)
          // manual override > agent suggestion
          const finalRatio = paramOverrides.imgRatio !== 'auto'
            ? paramOverrides.imgRatio
            : enhance.imgRatio || getModelCapabilities(selectedModel).defaultRatio
          const finalQuality: MivoImageQuality =
            paramOverrides.quality !== 'auto' ? (paramOverrides.quality as MivoImageQuality) : (enhance.quality || 'medium')
          context = {
            ...initialContext,
            imgRatio: finalRatio,
            quality: finalQuality,
            finalPrompt,
            // FIX-4: 持久化 chat 附言到 context，retry 不重跑 enhance 时可读回。
            noticeText,
          }

          set((s) => ({
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === userMessageId || m.id === assistantMessageId
                  ? {
                      ...m,
                      ...(m.id === assistantMessageId
                        ? { status: 'generating' as const, enhance, text: finalPrompt }
                        : {}),
                      generationContext: context,
                    }
                  : m,
              ),
            },
          }))

          const genOptions = {
            sceneId,
            createDerivationEdge: false,
            imgRatio: finalRatio,
            quality: finalQuality,
            model: selectedModel,
            referenceFiles: referenceFiles.length ? referenceFiles : undefined,
            signal: abortController.signal,
          }

          // P2-A3: generation goes through the facade (SC3.1) — chatStore no longer
          // calls useCanvasStore.getState() for generation actions or canvas reads.
          // prepareChatSlot is sync + creates the slot before the async generate, so
          // on failure the message's pendingSlotId is set for retry to reuse.
          const prep = generationFacade.prepareChatSlot({
            sceneId,
            selectedNodeId,
            hasSelectedImage,
            pendingSlotId: context.pendingSlotId,
            prompt: finalPrompt,
            imgRatio: finalRatio,
          })
          if (prep.slotId && prep.slotId !== context.pendingSlotId) {
            context = { ...context, pendingSlotId: prep.slotId }
            set((s) => ({
              messagesByScene: {
                ...s.messagesByScene,
                [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                  m.id === userMessageId || m.id === assistantMessageId ? { ...m, generationContext: context } : m,
                ),
              },
            }))
          }

          const nodeIds = prep.mode === 'beside' && selectedNodeId
            ? await generationFacade.generateBesideNode(selectedNodeId, finalPrompt, genOptions)
            : await generationFacade.generateIntoAiSlot(prep.slotId, finalPrompt, genOptions)

          const sceneChange = generationFacade.getSceneChangeInfo(sceneId)
          if (sceneChange.sceneChanged) {
            get().appendNotice({
              sceneId: sceneChange.currentSceneId,
              origin: 'chat',
              prompt: `结果已生成到画布 ${sceneChange.sceneTitle}`,
            })
          }
          // W4: chat 模式的澄清附言 —— replyText 作 notice 展示在生成结果后。
          if (noticeText) {
            get().appendNotice({ sceneId: sceneChange.currentSceneId, origin: 'chat', prompt: noticeText })
          }

          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      status: 'done' as const,
                      resultNodeIds: nodeIds,
                      generationContext: context,
                      error: undefined,
                      errorKind: undefined,
                      timeoutRetryKey: undefined,
                      timeoutRetryCount: undefined,
                    }
                  : m,
              ),
            },
          }))
        } catch (err) {
          const errorInfo = errorInfoForChat(err, abortController.signal)
          const timeoutRetryCount = isTimeoutErrorKind(errorInfo.kind) ? 1 : undefined
          const timeoutRetryKey = isTimeoutErrorKind(errorInfo.kind) ? timeoutRetryKeyForContext(context) : undefined
          const errorMsg = errorTextForChat(errorInfo.message, errorInfo.kind, timeoutRetryCount, context.quality)
          const failureSceneChange = generationFacade.getSceneChangeInfo(sceneId)
          if (failureSceneChange.sceneChanged) {
            get().appendNotice({
              sceneId: failureSceneChange.currentSceneId,
              origin: 'chat',
              prompt: `生成失败：${errorMsg}`,
            })
          }
          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      status: 'error' as const,
                      error: errorMsg,
                      errorKind: errorInfo.kind,
                      timeoutRetryKey,
                      timeoutRetryCount,
                    }
                  : m,
              ),
            },
          }))
        } finally {
          if (activeChatAbortController === abortController) {
            activeChatAbortController = null
          }
        }
      },

      appendNotice: ({ sceneId, origin, nodeIds, prompt }) => {
        const notice: ChatMessage = {
          id: createMessageId(),
          role: 'assistant',
          kind: 'notice',
          text: prompt || (origin === 'mask-edit' ? 'Mask edit completed' : 'Generation completed'),
          createdAt: Date.now(),
          status: 'done',
          origin,
          resultNodeIds: nodeIds,
        }

        set((s) => ({
          messagesByScene: {
            ...s.messagesByScene,
            [sceneId]: trimSceneMessages([...(s.messagesByScene[sceneId] || []), notice]),
          },
        }))
      },

      retryMessage: async ({ sceneId, messageId, qualityOverride }) => {
        const state = get()
        if (state.isBusy) return
        const messages = state.messagesByScene[sceneId] || []
        const targetMsg = messages.find((m) => m.id === messageId && m.role === 'assistant')
        if (!targetMsg || targetMsg.status !== 'error') return

        const targetIndex = messages.findIndex((m) => m.id === messageId)
        const userMsg = messages.slice(0, targetIndex).reverse().find((m) => m.role === 'user')
        if (!userMsg) return
        const rawBaseContext = targetMsg.generationContext || userMsg.generationContext
        if (!rawBaseContext) return
        // 防未来能力表变更再漏：retry 入口对 context 跑一遍 clamp（与 persist v1→v2 同一 helper）
        const baseContext = clampChatGenerationContext(rawBaseContext)

        let referenceFiles: File[]
        try {
          referenceFiles = await referenceFilesFromAssets(baseContext.referenceAssetUrls)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : referenceAssetMissingMessage
          set((s) => ({
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      status: 'error' as const,
                      error: errorMsg,
                      errorKind: 'unknown' as const,
                      timeoutRetryKey: undefined,
                      timeoutRetryCount: undefined,
                      retryDisabledReason: referenceAssetMissingMessage,
                    }
                  : m,
              ),
            },
          }))
          return
        }

        if (get().isBusy) return
        const abortController = new AbortController()
        activeChatAbortController = abortController
        let context = baseContext
        let retryEnhance = targetMsg.enhance
        let finalPrompt = context.finalPrompt || targetMsg.enhance?.richPrompt || targetMsg.text || userMsg.text
        let finalQuality = qualityOverride || context.quality || 'medium'
        let finalRatio = context.imgRatio || getModelCapabilities(context.model).defaultRatio
        let retryNoticeText = context.noticeText
        context = {
          ...context,
          finalPrompt,
          imgRatio: finalRatio,
          quality: finalQuality,
        }

        try {
          if (!baseContext.finalPrompt) {
            set((s) => ({
              isBusy: true,
              messagesByScene: {
                ...s.messagesByScene,
                [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                  m.id === messageId
                    ? {
                        ...m,
                        status: 'enhancing' as const,
                        text: '',
                        enhance: undefined,
                        error: undefined,
                        errorKind: undefined,
                        timeoutRetryKey: undefined,
                        timeoutRetryCount: undefined,
                        retryDisabledReason: undefined,
                        resultNodeIds: undefined,
                        generationContext: context,
                      }
                    : m,
                ),
              },
            }))

            const userIndex = messages.findIndex((m) => m.id === userMsg.id)
            const enhanceResult = await enhanceMivoPrompt({
              prompt: userMsg.text,
              modelId: context.model,
              history: historyForEnhance(messages.slice(0, Math.max(0, userIndex))),
              hasSelectedImage: context.sourceNodeType === 'image',
              sceneId,
              signal: abortController.signal,
            })
            if (abortController.signal.aborted) throw new Error(canceledGenerationMessage)

            const enhance = enhanceForGeneration(enhanceResult)
            retryEnhance = enhance
            // W4: chat 模式不再早 return —— 用原始 text 生图，replyText 作附言。
            const chatResolution = resolveChatEnhance(enhanceResult, userMsg.text)
            finalPrompt = chatResolution.finalPrompt
            retryNoticeText = chatResolution.noticeText
            finalRatio = context.requestedImgRatio !== 'auto'
              ? context.requestedImgRatio
              : enhance.imgRatio || getModelCapabilities(context.model).defaultRatio
            finalQuality = qualityOverride ||
              (context.requestedQuality !== 'auto' ? (context.requestedQuality as MivoImageQuality) : (enhance.quality || 'medium'))
            context = {
              ...context,
              imgRatio: finalRatio,
              quality: finalQuality,
              finalPrompt,
              // FIX-4: retry 重跑 enhance 时刷新 noticeText 到 context，保持与 send 一致。
              noticeText: retryNoticeText,
            }
          }

          set((s) => ({
            isBusy: true,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      status: 'generating' as const,
                      text: finalPrompt,
                      enhance: retryEnhance,
                      error: undefined,
                      errorKind: undefined,
                      timeoutRetryKey: undefined,
                      timeoutRetryCount: undefined,
                      retryDisabledReason: undefined,
                      resultNodeIds: undefined,
                      generationContext: context,
                    }
                  : m,
              ),
            },
          }))

          const genOptions = {
            sceneId,
            createDerivationEdge: false,
            imgRatio: context.imgRatio,
            quality: finalQuality,
            model: context.model,
            referenceFiles: referenceFiles.length ? referenceFiles : undefined,
            signal: abortController.signal,
          }

          // P2-A3: generation via the facade (SC3.1). prepareChatSlot reuses the
          // existing pendingSlotId if the slot is still present, else creates one.
          const hasSelectedImage = context.sourceNodeType === 'image' && Boolean(context.sourceNodeId)
          const prep = generationFacade.prepareChatSlot({
            sceneId,
            selectedNodeId: context.sourceNodeId,
            hasSelectedImage,
            pendingSlotId: context.pendingSlotId,
            prompt: finalPrompt,
            imgRatio: finalRatio,
          })
          if (prep.slotId && prep.slotId !== context.pendingSlotId) {
            context = { ...context, pendingSlotId: prep.slotId }
            set((s) => ({
              messagesByScene: {
                ...s.messagesByScene,
                [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                  m.id === messageId ? { ...m, generationContext: context } : m,
                ),
              },
            }))
          }

          const nodeIds = prep.mode === 'beside' && context.sourceNodeId
            ? await generationFacade.generateBesideNode(context.sourceNodeId, finalPrompt, genOptions)
            : await generationFacade.generateIntoAiSlot(prep.slotId, finalPrompt, genOptions)

          const sceneChange = generationFacade.getSceneChangeInfo(sceneId)
          if (sceneChange.sceneChanged) {
            get().appendNotice({
              sceneId: sceneChange.currentSceneId,
              origin: 'chat',
              prompt: `结果已生成到画布 ${sceneChange.sceneTitle}`,
            })
          }
          // W4: chat 模式的澄清附言 —— replyText 作 notice 展示在生成结果后。
          if (retryNoticeText) {
            get().appendNotice({ sceneId: sceneChange.currentSceneId, origin: 'chat', prompt: retryNoticeText })
          }

          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      status: 'done' as const,
                      resultNodeIds: nodeIds,
                      generationContext: {
                        ...context,
                        finalPrompt,
                        quality: finalQuality,
                      },
                      error: undefined,
                      errorKind: undefined,
                      timeoutRetryKey: undefined,
                      timeoutRetryCount: undefined,
                    }
                  : m,
              ),
            },
          }))
        } catch (err) {
          const errorInfo = errorInfoForChat(err, abortController.signal)
          const timeoutRetryKey = isTimeoutErrorKind(errorInfo.kind) ? timeoutRetryKeyForContext(context) : undefined
          const timeoutRetryCount = isTimeoutErrorKind(errorInfo.kind)
            ? targetMsg.timeoutRetryKey === timeoutRetryKey
              ? (targetMsg.timeoutRetryCount || 0) + 1
              : 1
            : undefined
          const errorMsg = errorTextForChat(errorInfo.message, errorInfo.kind, timeoutRetryCount, context.quality)
          const failureSceneChange = generationFacade.getSceneChangeInfo(sceneId)
          if (failureSceneChange.sceneChanged) {
            get().appendNotice({
              sceneId: failureSceneChange.currentSceneId,
              origin: 'chat',
              prompt: `生成失败：${errorMsg}`,
            })
          }
          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      status: 'error' as const,
                      error: errorMsg,
                      errorKind: errorInfo.kind,
                      timeoutRetryKey,
                      timeoutRetryCount,
                      generationContext: context,
                      retryDisabledReason: errorMsg === referenceAssetMissingMessage ? referenceAssetMissingMessage : undefined,
                    }
                  : m,
              ),
            },
          }))
        } finally {
          if (activeChatAbortController === abortController) {
            activeChatAbortController = null
          }
        }
      },

      cancelGeneration: (options = {}) => {
        // mask-chat-card (审 F1 / SC-19): 先按 sceneId/messageId 精确解析 target。
        // target 是 origin:'mask-edit' 且 in-flight → 在触碰 activeChatAbortController
        // 之前委托 cancelMaskEditMessage 并 return。保证 chat×mask 并行时点 mask 卡取消
        // 不会 abort 普通 chat 的全局 controller（mask 不置 isBusy、不用 activeChatAbortController）。
        const target = fallbackCancelTarget(get().messagesByScene, options)
        if (target && target.message.origin === 'mask-edit') {
          cancelMaskEditMessage(target.sceneId, target.message.id)
          return
        }

        // 普通 chat 分支：保持原有全局 abort + settleCanvasGenerationLocally 路径（零变化）。
        if (activeChatAbortController && !activeChatAbortController.signal.aborted) {
          activeChatAbortController.abort()
          return
        }

        if (!target) {
          debugLogger.warn('Chat Store', 'Cancel fallback skipped: no in-flight chat message found')
          return
        }

        set((s) => ({
          isBusy: false,
          messagesByScene: {
            ...s.messagesByScene,
            [target.sceneId]: (s.messagesByScene[target.sceneId] || []).map((message) =>
              message.id === target.message.id
                ? {
                    ...message,
                    status: 'error' as const,
                    error: canceledGenerationMessage,
                    errorKind: 'canceled' as const,
                    timeoutRetryKey: undefined,
                    timeoutRetryCount: undefined,
                    retryDisabledReason: undefined,
                  }
                : message,
            ),
          },
        }))

        const slotId = target.message.generationContext?.pendingSlotId
        const canvasResult = slotId
          ? settleCanvasGenerationLocally({
              sceneId: target.sceneId,
              slotId,
              status: 'canceled',
            })
          : { settledSlots: 0, settledTasks: 0 }

        debugLogger.warn(
          'Chat Store',
          `Cancel fallback settled message ${target.message.id} in ${target.sceneId}; slots=${canvasResult.settledSlots}; tasks=${canvasResult.settledTasks}`,
        )
      },

      clearScene: (sceneId) =>
        set((s) => ({
          messagesByScene: { ...s.messagesByScene, [sceneId]: [] },
        })),

      setSelectedModel: (modelId) => {
        const state = get()
        const capabilities = getModelCapabilities(modelId)
        const currentRatio = state.paramOverrides.imgRatio
        const ratioValid =
          currentRatio === 'auto' ||
          (capabilities.ratios as string[]).includes(currentRatio)

        set(() => ({
          selectedModel: modelId,
          paramOverrides: {
            ...state.paramOverrides,
            imgRatio: ratioValid ? currentRatio : 'auto',
          },
        }))
      },

      setParamOverride: (key, value) =>
        set((s) => ({
          paramOverrides: { ...s.paramOverrides, [key]: value },
        })),
    }),
    {
      name: 'mivo-chat-demo',
      version: 2,
      // FU4-2: persist to IndexedDB alongside canvasStore. skipHydration defers to
      // the App-layer hydration gate (no first-paint flash). migrate/merge unchanged.
      storage: createJSONStorage(() => idbStateStorage),
      skipHydration: true,
      partialize: (state) => ({
        messagesByScene: state.messagesByScene,
        selectedModel: state.selectedModel,
        paramOverrides: state.paramOverrides,
        // isBusy excluded (runtime state)
      }),
      migrate: migrateChatPersistedState,
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<ChatState>
        const merged = {
          ...currentState,
          ...persisted,
          isBusy: false,
        }
        const result = settleExpiredChatMessages(merged.messagesByScene || {})
        if (result.settledMessages > 0) {
          debugLogger.warn('Chat Store', `Hydration settled ${result.settledMessages} expired chat generation message(s)`)
        }
        // FIX-A: zustand v5 persisted version == options version (v2==v2) 时 migrate
        // 不走，只走 merge。86ce7d4 之前写入的脏 degradedReason string 仍会经 merge 进
        // runtime/UI。在 merge 必经路径对每条 message 跑 sanitizeEnhanceDegradedReason
        // （与 settle 同一处 map），保证 hydration 后 degradedReason 必为 union 成员或 undefined。
        const sanitizedMessages: Record<string, ChatMessage[]> = {}
        for (const [sceneId, messages] of Object.entries(result.messagesByScene)) {
          sanitizedMessages[sceneId] = messages.map(sanitizeEnhanceDegradedReason)
        }
        return {
          ...merged,
          messagesByScene: sanitizedMessages,
        }
      },
    },
  ),
)
