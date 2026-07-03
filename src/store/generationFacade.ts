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

type ChatSlotPrep =
  | { mode: 'beside'; slotId: undefined }
  | { mode: 'slot'; slotId: string }

export const generationFacade = {
  // ─── the 5 generation actions (stable signatures; delegate to the live store) ───
  generateImageEdit: (...args: Parameters<CanvasState['generateImageEdit']>) =>
    useCanvasStore.getState().generateImageEdit(...args),
  generateBesideNode: (...args: Parameters<CanvasState['generateBesideNode']>) =>
    useCanvasStore.getState().generateBesideNode(...args),
  generateIntoAiSlot: (...args: Parameters<CanvasState['generateIntoAiSlot']>) =>
    useCanvasStore.getState().generateIntoAiSlot(...args),
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
    const slotX = selectedNode ? selectedNode.x + selectedNode.width + 56 : -160 + doc.nodes.length * 18
    const slotY = selectedNode ? selectedNode.y : -160 + doc.nodes.length * 18
    const slotId = store.addAiSlotNode(
      { x: slotX, y: slotY },
      { width: 320, height: 320 },
      params.prompt ?? '',
      { sceneId: params.sceneId },
    )
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
