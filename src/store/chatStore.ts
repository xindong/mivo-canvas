import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GenerationRatio, MivoImageQuality } from '../types/generation'
import { readImportedAssetFile, saveImportedAsset } from '../lib/assetStorage'
import { MivoImageRequestError, enhanceMivoPrompt, type MivoImageRequestErrorKind } from '../lib/mivoImageClient'
import { getModelCapabilities } from '../lib/modelCapabilities'
import { useCanvasStore } from './canvasStore'

const maxMessagesPerScene = 200

export type ChatMessageStatus = 'enhancing' | 'generating' | 'done' | 'error'
export type ChatMessageOrigin = 'chat' | 'mask-edit'
export type ChatMessageErrorKind = MivoImageRequestErrorKind | 'unknown'

export type ChatEnhanceResult = {
  scene?: string
  reasoning?: string
  richPrompt?: string
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  degradedReason?: string
}

export type ChatParamOverrides = {
  imgRatio: 'auto' | GenerationRatio
  quality: 'auto' | MivoImageQuality
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
  cancelGeneration: () => void
  clearScene: (sceneId: string) => void
  setSelectedModel: (modelId: string) => void
  setParamOverride: (key: keyof ChatParamOverrides, value: string) => void
}

const createMessageId = () => `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const canceledGenerationMessage = '已取消生成，可修改提示后重试。'
const referenceAssetMissingMessage = '参考图已失效，无法重试'
const timeoutRetryAdvice = '建议降低质量或换比例'
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
  if (err instanceof Error && err.message.includes('已取消')) return { message: canceledGenerationMessage, kind: 'canceled' }
  return { message: err instanceof Error ? err.message : 'Generation failed', kind: 'unknown' }
}

const errorTextForChat = (message: string, kind: ChatMessageErrorKind, timeoutRetryCount?: number) =>
  isTimeoutErrorKind(kind) && (timeoutRetryCount || 0) >= 2
    ? `${message}，${timeoutRetryAdvice}`
    : message

const trimSceneMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.length > maxMessagesPerScene ? messages.slice(-maxMessagesPerScene) : messages

const historyForEnhance = (messages: ChatMessage[], limit = 6) =>
  messages
    .filter((m) => m.status === 'done' && (m.role === 'user' || m.enhance?.richPrompt))
    .slice(-limit)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.enhance?.richPrompt || m.text }))

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messagesByScene: {},
      selectedModel: 'gpt-image-2',
      paramOverrides: { imgRatio: 'auto', quality: 'auto' },
      isBusy: false,

      sendMessage: async ({ sceneId, text, selectedNodeId, selectedNodeType, referenceFiles = [] }) => {
        const state = get()
        if (state.isBusy) return

        const { selectedModel, paramOverrides } = state
        const referenceAssetUrls = await saveReferenceAssets(referenceFiles)
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

          const enhance: ChatEnhanceResult = enhanceResult.enhanced
            ? {
                scene: enhanceResult.scene,
                reasoning: enhanceResult.reasoning,
                richPrompt: enhanceResult.richPrompt,
                imgRatio: enhanceResult.imgRatio,
                quality: enhanceResult.quality,
                degradedReason: enhanceResult.degradedReason,
              }
            : { degradedReason: enhanceResult.degradedReason }

          // manual override > agent suggestion
          const finalPrompt = enhance.richPrompt || text
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

          const canvasStore = useCanvasStore.getState()
          const genOptions = {
            sceneId,
            imgRatio: finalRatio,
            quality: finalQuality,
            model: selectedModel,
            referenceFiles: referenceFiles.length ? referenceFiles : undefined,
            signal: abortController.signal,
          }

          let nodeIds: string[]
          if (hasSelectedImage && selectedNodeId) {
            nodeIds = await canvasStore.generateBesideNode(selectedNodeId, finalPrompt, genOptions)
          } else {
            const targetDocument = canvasStore.canvases[sceneId]
            if (!targetDocument) throw new Error('目标画布已删除，无法继续生成。')
            const selectedNode = selectedNodeId ? targetDocument.nodes.find((n) => n.id === selectedNodeId) : undefined
            const slotX = selectedNode ? selectedNode.x + selectedNode.width + 56 : -160 + targetDocument.nodes.length * 18
            const slotY = selectedNode ? selectedNode.y : -160 + targetDocument.nodes.length * 18
            const slotId = canvasStore.addAiSlotNode(
              { x: slotX, y: slotY },
              { width: 320, height: 320 },
              finalPrompt,
              { sceneId },
            )
            context = { ...context, pendingSlotId: slotId }
            set((s) => ({
              messagesByScene: {
                ...s.messagesByScene,
                [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                  m.id === userMessageId || m.id === assistantMessageId ? { ...m, generationContext: context } : m,
                ),
              },
            }))
            nodeIds = await canvasStore.generateIntoAiSlot(slotId, finalPrompt, genOptions)
          }

          const latestCanvasState = useCanvasStore.getState()
          if (latestCanvasState.sceneId !== sceneId) {
            const title = latestCanvasState.canvases[sceneId]?.title || sceneId
            get().appendNotice({
              sceneId: latestCanvasState.sceneId,
              origin: 'chat',
              prompt: `结果已生成到画布 ${title}`,
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
          const errorMsg = errorTextForChat(errorInfo.message, errorInfo.kind, timeoutRetryCount)
          const latestCanvasState = useCanvasStore.getState()
          if (latestCanvasState.sceneId !== sceneId) {
            get().appendNotice({
              sceneId: latestCanvasState.sceneId,
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
        const baseContext = targetMsg.generationContext || userMsg.generationContext
        if (!baseContext) return

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
        const finalPrompt = context.finalPrompt || targetMsg.enhance?.richPrompt || targetMsg.text || userMsg.text
        const finalQuality = qualityOverride || context.quality || 'medium'
        const finalRatio = context.imgRatio || getModelCapabilities(context.model).defaultRatio
        context = {
          ...context,
          finalPrompt,
          imgRatio: finalRatio,
          quality: finalQuality,
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

        try {
          const canvasStore = useCanvasStore.getState()
          const genOptions = {
            sceneId,
            imgRatio: context.imgRatio,
            quality: finalQuality,
            model: context.model,
            referenceFiles: referenceFiles.length ? referenceFiles : undefined,
            signal: abortController.signal,
          }

          let nodeIds: string[]
          if (context.sourceNodeType === 'image' && context.sourceNodeId) {
            nodeIds = await canvasStore.generateBesideNode(context.sourceNodeId, finalPrompt, genOptions)
          } else {
            const targetDocument = canvasStore.canvases[sceneId]
            if (!targetDocument) throw new Error('目标画布已删除，无法继续生成。')
            let slotId = context.pendingSlotId
            const reusableSlot = slotId
              ? targetDocument.nodes.find((node) => node.id === slotId && node.type === 'ai-slot' && !node.hidden)
              : undefined

            if (!reusableSlot) {
              const selectedNode = context.sourceNodeId
                ? targetDocument.nodes.find((node) => node.id === context.sourceNodeId && !node.hidden)
                : undefined
              const slotX = selectedNode ? selectedNode.x + selectedNode.width + 56 : -160 + targetDocument.nodes.length * 18
              const slotY = selectedNode ? selectedNode.y : -160 + targetDocument.nodes.length * 18
              slotId = canvasStore.addAiSlotNode(
                { x: slotX, y: slotY },
                { width: 320, height: 320 },
                finalPrompt,
                { sceneId },
              )
              context = { ...context, pendingSlotId: slotId }
              set((s) => ({
                messagesByScene: {
                  ...s.messagesByScene,
                  [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                    m.id === messageId ? { ...m, generationContext: context } : m,
                  ),
                },
              }))
            }

            nodeIds = await canvasStore.generateIntoAiSlot(slotId, finalPrompt, genOptions)
          }

          const latestCanvasState = useCanvasStore.getState()
          if (latestCanvasState.sceneId !== sceneId) {
            const title = latestCanvasState.canvases[sceneId]?.title || sceneId
            get().appendNotice({
              sceneId: latestCanvasState.sceneId,
              origin: 'chat',
              prompt: `结果已生成到画布 ${title}`,
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
          const errorMsg = errorTextForChat(errorInfo.message, errorInfo.kind, timeoutRetryCount)
          const latestCanvasState = useCanvasStore.getState()
          if (latestCanvasState.sceneId !== sceneId) {
            get().appendNotice({
              sceneId: latestCanvasState.sceneId,
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

      cancelGeneration: () => {
        if (!activeChatAbortController || activeChatAbortController.signal.aborted) return
        activeChatAbortController.abort()
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
      version: 1,
      partialize: (state) => ({
        messagesByScene: state.messagesByScene,
        selectedModel: state.selectedModel,
        paramOverrides: state.paramOverrides,
        // isBusy excluded (runtime state)
      }),
    },
  ),
)
