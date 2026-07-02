import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GenerationRatio, MivoImageQuality } from '../types/generation'
import { enhanceMivoPrompt } from '../lib/mivoImageClient'
import { getModelCapabilities } from '../lib/modelCapabilities'
import { useCanvasStore } from './canvasStore'

const maxMessagesPerScene = 200

export type ChatMessageStatus = 'enhancing' | 'generating' | 'done' | 'error'
export type ChatMessageOrigin = 'chat' | 'mask-edit'

export type ChatEnhanceResult = {
  scene?: string
  reasoning?: string
  richPrompt?: string
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  degradedReason?: string
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
}

export type ChatParamOverrides = {
  imgRatio: 'auto' | GenerationRatio
  quality: 'auto' | MivoImageQuality
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
  regenerateWithParams: (options: { sceneId: string; messageId: string }) => Promise<void>
  appendNotice: (options: {
    sceneId: string
    origin: ChatMessageOrigin
    nodeIds?: string[]
    prompt?: string
  }) => void
  retryMessage: (options: { sceneId: string; messageId: string }) => Promise<void>
  clearScene: (sceneId: string) => void
  setSelectedModel: (modelId: string) => void
  setParamOverride: (key: keyof ChatParamOverrides, value: string) => void
}

const createMessageId = () => `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

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

        const existingMessages = state.messagesByScene[sceneId] || []
        const userMessageId = createMessageId()
        const assistantMessageId = createMessageId()

        const userMessage: ChatMessage = {
          id: userMessageId,
          role: 'user',
          kind: 'text',
          text,
          createdAt: Date.now(),
          status: 'done',
        }
        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          kind: 'text',
          text: '',
          createdAt: Date.now(),
          status: 'enhancing',
        }

        set((s) => ({
          isBusy: true,
          messagesByScene: {
            ...s.messagesByScene,
            [sceneId]: trimSceneMessages([...existingMessages, userMessage, assistantMessage]),
          },
        }))

        try {
          const history = historyForEnhance(existingMessages)
          const { selectedModel, paramOverrides } = get()
          const hasSelectedImage = selectedNodeType === 'image'

          const enhanceResult = await enhanceMivoPrompt({
            prompt: text,
            modelId: selectedModel,
            history,
            hasSelectedImage,
            sceneId,
          })

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
          const finalRatio = paramOverrides.imgRatio !== 'auto' ? paramOverrides.imgRatio : enhance.imgRatio
          const finalQuality: MivoImageQuality =
            paramOverrides.quality !== 'auto' ? (paramOverrides.quality as MivoImageQuality) : (enhance.quality || 'medium')

          set((s) => ({
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === assistantMessageId
                  ? { ...m, status: 'generating' as const, enhance, text: finalPrompt }
                  : m,
              ),
            },
          }))

          const canvasStore = useCanvasStore.getState()
          const genOptions = {
            imgRatio: finalRatio,
            quality: finalQuality,
            model: selectedModel,
            referenceFiles: referenceFiles.length ? referenceFiles : undefined,
          }

          let nodeIds: string[]
          if (hasSelectedImage && selectedNodeId) {
            nodeIds = await canvasStore.generateBesideNode(selectedNodeId, finalPrompt, genOptions)
          } else {
            const { nodes } = canvasStore
            const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : undefined
            const slotX = selectedNode ? selectedNode.x + selectedNode.width + 56 : -160 + nodes.length * 18
            const slotY = selectedNode ? selectedNode.y : -160 + nodes.length * 18
            const slotId = canvasStore.addAiSlotNode({ x: slotX, y: slotY }, { width: 320, height: 320 }, finalPrompt)
            nodeIds = await canvasStore.generateIntoAiSlot(slotId, finalPrompt, genOptions)
          }

          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === assistantMessageId
                  ? { ...m, status: 'done' as const, resultNodeIds: nodeIds }
                  : m,
              ),
            },
          }))
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Generation failed'
          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === assistantMessageId
                  ? { ...m, status: 'error' as const, error: errorMsg }
                  : m,
              ),
            },
          }))
        }
      },

      regenerateWithParams: async ({ sceneId, messageId }) => {
        const state = get()
        if (state.isBusy) return

        const messages = state.messagesByScene[sceneId] || []
        const targetMsg = messages.find((m) => m.id === messageId)
        if (!targetMsg || !targetMsg.enhance?.richPrompt) return

        const { selectedModel, paramOverrides } = state
        const finalRatio = paramOverrides.imgRatio !== 'auto' ? paramOverrides.imgRatio : targetMsg.enhance.imgRatio
        const finalQuality: MivoImageQuality =
          paramOverrides.quality !== 'auto' ? (paramOverrides.quality as MivoImageQuality) : (targetMsg.enhance.quality || 'medium')
        const finalPrompt = targetMsg.enhance.richPrompt

        set((s) => ({
          isBusy: true,
          messagesByScene: {
            ...s.messagesByScene,
            [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
              m.id === messageId ? { ...m, status: 'generating' as const, error: undefined } : m,
            ),
          },
        }))

        try {
          const canvasStore = useCanvasStore.getState()
          const slotId = canvasStore.addAiSlotNode({ x: 0, y: 0 }, undefined, finalPrompt)
          const nodeIds = await canvasStore.generateIntoAiSlot(slotId, finalPrompt, {
            imgRatio: finalRatio,
            quality: finalQuality,
            model: selectedModel,
          })

          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === messageId ? { ...m, status: 'done' as const, resultNodeIds: nodeIds } : m,
              ),
            },
          }))
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Generation failed'
          set((s) => ({
            isBusy: false,
            messagesByScene: {
              ...s.messagesByScene,
              [sceneId]: (s.messagesByScene[sceneId] || []).map((m) =>
                m.id === messageId ? { ...m, status: 'error' as const, error: errorMsg } : m,
              ),
            },
          }))
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

      retryMessage: async ({ sceneId, messageId }) => {
        const state = get()
        const messages = state.messagesByScene[sceneId] || []
        const targetMsg = messages.find((m) => m.id === messageId && m.role === 'assistant')
        if (!targetMsg || targetMsg.status !== 'error') return

        const targetIndex = messages.findIndex((m) => m.id === messageId)
        const userMsg = messages.slice(0, targetIndex).reverse().find((m) => m.role === 'user')
        if (!userMsg) return

        set((s) => ({
          messagesByScene: {
            ...s.messagesByScene,
            [sceneId]: (s.messagesByScene[sceneId] || []).filter((m) => m.id !== messageId),
          },
        }))

        await get().sendMessage({ sceneId, text: userMsg.text })
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
