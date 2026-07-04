// 局部重绘 (mask edit) 占位符生命周期：在源图右侧 AI_SLOT_GAP 预建一个 generating
// 态 ai-slot 占位符（并挤开右侧障碍），生成失败/取消时回退到生成前 history 基线以
// 移除该占位符并撤销 reflow 位移。从 MivoCanvas 抽出，保持该视图在 structure-guard
// 行数预算内，也让"局部重绘占位符"这一职责独立可测。
import type { MivoCanvasNode, MivoCanvasSnapshot } from '../types/mivoCanvas'
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
