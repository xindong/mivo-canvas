// 局部重绘 (mask edit) 占位符生命周期：在源图右侧 AI_SLOT_GAP 预建一个 generating
// 态 ai-slot 占位符（并挤开右侧障碍），生成失败/取消时回退到生成前 history 基线以
// 移除该占位符并撤销 reflow 位移。从 MivoCanvas 抽出，保持该视图在 structure-guard
// 行数预算内，也让"局部重绘占位符"这一职责独立可测。
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { MivoImageRatio } from '../types/generation'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
import { AI_SLOT_GAP, reflowRightObstacles } from '../store/aiCanvasWorkflow'
import { rollbackLatestHistoryBaseline } from '../store/canvasDocumentModel'
import { debugLogger } from '../store/debugLogStore'
import { readCanvasImageBlob } from '../lib/canvasImageSource'
import { editMivoImage } from '../lib/mivoImageClient'
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

/** Prebuild a generating ai-slot placeholder to the right of the source image. */
export const prepareMaskEditPlaceholder = (
  sceneId: string,
  source: MivoCanvasNode,
  prompt: string,
): string => {
  const slotId = useCanvasStore
    .getState()
    .addAiSlotNode(
      { x: source.x + source.width + AI_SLOT_GAP, y: source.y },
      { width: source.width, height: source.height },
      prompt,
      { sceneId },
    )
  patchMaskEditSlotStatus(sceneId, slotId, 'generating', prompt)
  debugLogger.log('Canvas', `Prepared mask edit placeholder for ${source.title}`)
  return slotId
}

/** Remove the placeholder on failure/cancel: revert to the pre-generation history
 * baseline (also undoing reflow shifts), falling back to a plain node delete. */
export const removeMaskEditPlaceholder = (
  sceneId: string,
  slotId: string,
  context: { canceled?: boolean; error?: string; sourceTitle?: string } = {},
) => {
  useCanvasStore.setState((current) => {
    const rollback = rollbackLatestHistoryBaseline(current, sceneId, { removeNodeId: slotId })
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

/** Run the mask-edit generation: edit the source image, commit the result in-place
 * over the prebuilt placeholder (via replaceSlotId), and append cross-scene notices.
 * Throws on failure/cancel (caller removes the placeholder). */
export const runMaskEditGeneration = async (args: {
  sceneId: string
  source: MivoCanvasNode
  slotId: string
  resolvedAssetUrl: string | undefined
  payload: ImageMaskSubmitPayload
  imgRatio: MivoImageRatio
  signal: AbortSignal
}): Promise<string[]> => {
  const { sceneId, source, slotId, resolvedAssetUrl, payload, imgRatio, signal } = args
  const image = await readCanvasImageBlob(source, resolvedAssetUrl)
  const response = await editMivoImage({
    image,
    mask: payload.mask,
    prompt: payload.prompt,
    imgRatio,
    quality: 'medium',
    model: 'gpt-image-2',
    signal,
  })
  const commitPayload = {
    sceneId,
    sourceNodeId: source.id,
    lineageSourceId: source.id,
    replaceSlotId: slotId,
    reflow: true,
    resultImages: response.images,
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
  return nodeIds
}
