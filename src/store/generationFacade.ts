// generationFacade — stable entry for the 5 generation actions (SC3.1).
//
// chatStore imports THIS, not useCanvasStore.getState(), so the chat layer is
// decoupled from the canvas store's internal slice composition (A2 may re-split
// slices; chatStore is unaffected as long as the facade signatures hold).
//
// The facade also owns the chat-specific "beside-if-selected-image, else create/
// reuse an ai-slot" flow (prepareChatSlot) + the cross-scene notice read
// (getSceneChangeInfo), so chatStore never reads the canvas store directly.
//
// Failure semantics: the generate* methods rethrow (chatStore's catch depends on
// the throw to walk the error branch — A1's 9 quirks). prepareChatSlot is sync +
// may throw if the target canvas was deleted (matches the prior inline guard).

import { useCanvasStore } from './canvasStore'
import type { CanvasGenerationOptions, CanvasState } from './canvasStore'
import type { CanvasId } from '../types/mivoCanvas'
import { defaultSizeForNodeType } from '../canvas/nodeTypes/canvasNodeRegistry'
import { AI_SLOT_GAP, chooseAdjacentPlacement } from './aiCanvasWorkflow'
import { firstAnchorImageFor } from './canvasDocumentModel'

type ChatSlotPrep =
  | { mode: 'beside'; slotId: undefined }
  | { mode: 'slot'; slotId: string }

const freshlyCreatedChatSlots = new Set<string>()

export const generationFacade = {
  // ─── the 5 generation actions (stable signatures; delegate to the live store) ───
  generateImageEdit: (...args: Parameters<CanvasState['generateImageEdit']>) =>
    useCanvasStore.getState().generateImageEdit(...args),
  generateBesideNode: (...args: Parameters<CanvasState['generateBesideNode']>) =>
    useCanvasStore.getState().generateBesideNode(...args),
  generateIntoAiSlot: (
    slotId?: Parameters<CanvasState['generateIntoAiSlot']>[0],
    prompt?: Parameters<CanvasState['generateIntoAiSlot']>[1],
    options?: Parameters<CanvasState['generateIntoAiSlot']>[2],
  ) => {
    const skipSlotHistoryBaseline = Boolean(slotId && freshlyCreatedChatSlots.delete(slotId))
    const nextOptions = skipSlotHistoryBaseline ? { ...options, skipSlotHistoryBaseline } : options
    return useCanvasStore.getState().generateIntoAiSlot(slotId, prompt, nextOptions)
  },
  generateVariations: (...args: Parameters<CanvasState['generateVariations']>) =>
    useCanvasStore.getState().generateVariations(...args),
  generateFromAnnotation: (...args: Parameters<CanvasState['generateFromAnnotation']>) =>
    useCanvasStore.getState().generateFromAnnotation(...args),

  // ─── chat-specific flow: decide beside vs slot + create/reuse the slot ───
  // Sync: the slot is created BEFORE the async generate, so on failure chatStore
  // still has the slotId (via the message's pendingSlotId) for retry to reuse —
  // preserves the prior inline behavior.
  prepareChatSlot: (params: {
    sceneId: CanvasId
    selectedNodeId?: string
    hasSelectedImage: boolean
    pendingSlotId?: string
    prompt: string
  }): ChatSlotPrep => {
    if (params.hasSelectedImage && params.selectedNodeId) {
      return { mode: 'beside', slotId: undefined }
    }
    const store = useCanvasStore.getState()
    const doc = store.canvases[params.sceneId]
    if (!doc) throw new Error('目标画布已删除，无法继续生成。')

    const existing = params.pendingSlotId
      ? doc.nodes.find((n) => n.id === params.pendingSlotId && n.type === 'ai-slot' && !n.hidden)
      : undefined
    if (existing) return { mode: 'slot', slotId: existing.id }

    const selectedNode = params.selectedNodeId
      ? doc.nodes.find((n) => n.id === params.selectedNodeId && !n.hidden)
      : undefined
    const slotSize = defaultSizeForNodeType('ai-slot')
    const slotPosition = selectedNode
      ? { x: selectedNode.x + selectedNode.width + AI_SLOT_GAP, y: selectedNode.y }
      : (() => {
          const anchor = firstAnchorImageFor(doc.nodes)
          if (!anchor) return { x: -Math.round(slotSize.width / 2), y: -Math.round(slotSize.height / 2) }
          return chooseAdjacentPlacement({
            nodes: doc.nodes,
            anchor,
            width: slotSize.width,
            height: slotSize.height,
            placement: 'below',
            margin: AI_SLOT_GAP,
          })
        })()
    const slotId = store.addAiSlotNode(
      slotPosition,
      slotSize,
      params.prompt ?? '',
      { sceneId: params.sceneId },
    )
    freshlyCreatedChatSlots.add(slotId)
    return { mode: 'slot', slotId }
  },

  // ─── read-only: did the active scene change during generation? (cross-scene notice) ───
  getSceneChangeInfo: (expectedSceneId: CanvasId) => {
    const state = useCanvasStore.getState()
    return {
      sceneChanged: state.sceneId !== expectedSceneId,
      currentSceneId: state.sceneId,
      sceneTitle: state.canvases[expectedSceneId]?.title || expectedSceneId,
    }
  },
}

export type { CanvasGenerationOptions }
