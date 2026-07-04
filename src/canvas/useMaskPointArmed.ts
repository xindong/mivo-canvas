import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { MivoImageRatio } from '../types/generation'
import { prepareMaskEditPlaceholder, removeMaskEditPlaceholder, runMaskEditGeneration } from './maskEditGeneration'
import type { ImageMaskSubmitPayload } from './imageMaskGeometry'
import type { RuntimeCanvasTool } from './canvasInteraction'
import { reduceMaskPointPending, type MaskInitialClientPoint, type MaskPointPendingAction } from './maskPointPending'

export type MaskPointArmedInteractionApi = {
  beginNodePointerDown: (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => void
  handleCanvasPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  temporaryTool: RuntimeCanvasTool | undefined
  isPanning: boolean
}

type UseMaskPointArmedOptions = {
  sceneId: string
  maskCancelRequestId: number
  onMaskEditActiveChange?: (active: boolean) => void
  selectNode: (nodeId?: string, options?: { additive?: boolean }) => void
  closeContextMenu: () => void
  clearCropNode: () => void
  interactionRef: RefObject<MaskPointArmedInteractionApi>
}

const supportedMivoRatios: Array<{ id: MivoImageRatio; value: number }> = [
  { id: '1:1', value: 1 },
  { id: '3:2', value: 3 / 2 },
  { id: '2:3', value: 2 / 3 },
  { id: '16:9', value: 16 / 9 },
  { id: '9:16', value: 9 / 16 },
]

const closestMivoRatioForSize = (size: { width: number; height: number }): MivoImageRatio => {
  const ratio = Math.max(1, size.width) / Math.max(1, size.height)
  return supportedMivoRatios.reduce((best, candidate) => (
    Math.abs(Math.log(ratio / candidate.value)) < Math.abs(Math.log(ratio / best.value)) ? candidate : best
  )).id
}

const hasVisibleImage = (nodes: MivoCanvasNode[]) => nodes.some((node) => node.type === 'image' && !node.hidden)

export function useMaskPointArmed({
  sceneId,
  maskCancelRequestId,
  onMaskEditActiveChange,
  selectNode,
  closeContextMenu,
  clearCropNode,
  interactionRef,
}: UseMaskPointArmedOptions) {
  const maskEditAbortRef = useRef<AbortController | null>(null)
  const maskArmedRef = useRef(false)
  const maskEditNodeIdRef = useRef<string | undefined>(undefined)
  const pendingInitialClientPointRef = useRef<MaskInitialClientPoint | undefined>(undefined)
  const lastMaskCancelRequestIdRef = useRef(maskCancelRequestId)
  const mountedRef = useRef(true)
  const [maskArmed, setMaskArmedState] = useState(false)
  const [maskEditNodeId, setMaskEditNodeId] = useState<string>()
  const [maskEditSubmittingNodeId, setMaskEditSubmittingNodeId] = useState<string>()
  const [initialClientPoint, setInitialClientPoint] = useState<MaskInitialClientPoint>()
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)

  const setMaskArmed = useCallback((next: boolean, reason: string) => {
    const previous = maskArmedRef.current
    maskArmedRef.current = next
    if (previous !== next) {
      debugLogger.log('Mask Edit', `${next ? 'Armed' : 'Disarmed'} point selection: ${reason}`)
    }
    setMaskArmedState(next)
  }, [])

  const updatePendingInitialPoint = useCallback((
    action: MaskPointPendingAction,
    logMessage?: (previous: MaskInitialClientPoint) => string,
  ) => {
    const current = pendingInitialClientPointRef.current
    const next = reduceMaskPointPending(current, action)
    pendingInitialClientPointRef.current = next
    if (current && current !== next && logMessage) debugLogger.log('Mask Edit', logMessage(current))
    setInitialClientPoint(next)
  }, [])

  const recordPendingInitialPoint = useCallback((point: MaskInitialClientPoint) => {
    pendingInitialClientPointRef.current = point
    setInitialClientPoint(reduceMaskPointPending(undefined, { type: 'set', point }))
    debugLogger.log('Mask Edit', `Pending initial point recorded for ${point.nodeId}`)
  }, [])

  const clearPendingInitialPoint = useCallback((reason: string) => {
    updatePendingInitialPoint({ type: 'clear' }, (point) => (
      `Pending initial point for ${point.nodeId} cleared: ${reason}`
    ))
  }, [updatePendingInitialPoint])

  const scheduleStateSync = useCallback((callback: () => void) => {
    window.requestAnimationFrame(() => {
      if (mountedRef.current) callback()
    })
  }, [])

  const cancelMaskEdit = useCallback(() => {
    maskEditAbortRef.current?.abort()
    maskEditAbortRef.current = null
    maskEditNodeIdRef.current = undefined
    setMaskEditNodeId(undefined)
    setMaskEditSubmittingNodeId(undefined)
    setMaskArmed(false, 'mask edit canceled')
    clearPendingInitialPoint('mask edit canceled')
  }, [clearPendingInitialPoint, setMaskArmed])

  const beginMaskEdit = useCallback((nodeId: string) => {
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId && item.type === 'image' && !item.hidden)
    if (!node) {
      debugLogger.log('Mask Edit', `Mask edit start skipped; image node not available: ${nodeId}`)
      return false
    }

    const pending = pendingInitialClientPointRef.current
    if (pending && pending.nodeId !== nodeId) {
      updatePendingInitialPoint({ type: 'discard-stale', nodeId }, (point) => (
        `Pending initial point for ${point.nodeId} discarded: active mask node is ${nodeId}`
      ))
    }
    selectNode(nodeId)
    closeContextMenu()
    clearCropNode()
    maskEditNodeIdRef.current = nodeId
    setMaskEditNodeId(nodeId)
    debugLogger.log('Mask Edit', `Mask edit started for ${nodeId}`)
    return true
  }, [clearCropNode, closeContextMenu, selectNode, updatePendingInitialPoint])

  const submitMaskEdit = useCallback(
    async (nodeId: string, resolvedAssetUrl: string, payload: ImageMaskSubmitPayload) => {
      const targetSceneId = sceneId
      const source = useCanvasStore
        .getState()
        .canvases[targetSceneId]?.nodes.find((node) => node.id === nodeId && node.type === 'image' && !node.hidden)
      if (!source) throw new Error('Source image not found')

      const slotId = prepareMaskEditPlaceholder(targetSceneId, source, payload.prompt)
      setMaskEditSubmittingNodeId(nodeId)
      const abortController = new AbortController()
      maskEditAbortRef.current?.abort()
      maskEditAbortRef.current = abortController
      try {
        await runMaskEditGeneration({
          sceneId: targetSceneId,
          source,
          slotId,
          resolvedAssetUrl,
          payload,
          imgRatio: closestMivoRatioForSize(payload.sourceSize),
          signal: abortController.signal,
        })
        maskEditNodeIdRef.current = undefined
        setMaskEditNodeId(undefined)
        clearPendingInitialPoint('mask edit submitted')
      } catch (error) {
        const logMessage = error instanceof Error ? error.message : '局部重绘失败'
        removeMaskEditPlaceholder(targetSceneId, slotId, {
          canceled: abortController.signal.aborted,
          error: logMessage,
          sourceTitle: source.title,
        })
        const latestCanvasState = useCanvasStore.getState()
        if (latestCanvasState.sceneId !== targetSceneId) {
          useChatStore.getState().appendNotice({
            sceneId: latestCanvasState.sceneId,
            origin: 'mask-edit',
            prompt: `局部重绘失败：${logMessage}`,
          })
        }
        throw error
      } finally {
        if (maskEditAbortRef.current === abortController) {
          maskEditAbortRef.current = null
        }
        setMaskEditSubmittingNodeId(undefined)
      }
    },
    [clearPendingInitialPoint, sceneId],
  )

  const toggleMaskArmed = useCallback(() => {
    if (maskArmedRef.current) {
      setMaskArmed(false, 'toolbar toggle')
      clearPendingInitialPoint('toolbar toggle')
      return
    }

    if (!hasVisibleImage(useCanvasStore.getState().nodes)) {
      debugLogger.log('Mask Edit', 'Point selection arm skipped: no visible image nodes')
      toastFeedback.warn('画布上还没有图片，先添加一张图片')
      return
    }

    setActiveTool('select')
    clearCropNode()
    closeContextMenu()
    clearPendingInitialPoint('new point selection arm')
    setMaskArmed(true, 'toolbar')
    toastFeedback.info('点击图片上要修改的位置')
  }, [clearCropNode, clearPendingInitialPoint, closeContextMenu, setActiveTool, setMaskArmed])

  const handleInitialClientPointHandled = useCallback((
    nodeId: string,
    outcome: 'consumed' | 'discarded',
    reason = 'overlay handled',
  ) => {
    updatePendingInitialPoint({ type: 'consume', nodeId }, (point) => (
      outcome === 'consumed'
        ? `Pending initial point consumed for ${point.nodeId}`
        : `Pending initial point for ${point.nodeId} discarded: ${reason}`
    ))
  }, [updatePendingInitialPoint])

  const wrapNodePointerDown = useCallback((nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    const { beginNodePointerDown, temporaryTool, isPanning } = interactionRef.current
    if (!maskArmedRef.current || temporaryTool || isPanning) {
      beginNodePointerDown(nodeId, event)
      return
    }

    const primaryUnmodified = event.button === 0 && !event.ctrlKey && !event.metaKey
    if (!primaryUnmodified) {
      debugLogger.log('Mask Edit', `Armed node pointer ignored for ${nodeId}: non-primary or modified click`)
      setMaskArmed(false, 'non-primary node pointer')
      beginNodePointerDown(nodeId, event)
      return
    }

    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
    if (node?.type === 'image' && !node.hidden) {
      event.preventDefault()
      event.stopPropagation()
      recordPendingInitialPoint({ nodeId, clientX: event.clientX, clientY: event.clientY })
      beginMaskEdit(nodeId)
      setMaskArmed(false, 'image hit')
      debugLogger.log('Mask Edit', `Armed image hit: ${nodeId}`)
      return
    }

    debugLogger.log('Mask Edit', `Armed node miss: ${nodeId}`)
    setMaskArmed(false, 'node miss')
    beginNodePointerDown(nodeId, event)
  }, [beginMaskEdit, interactionRef, recordPendingInitialPoint, setMaskArmed])

  const wrapCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const { handleCanvasPointerDown, temporaryTool, isPanning } = interactionRef.current
    if (!maskArmedRef.current || temporaryTool || isPanning) {
      handleCanvasPointerDown(event)
      return
    }

    debugLogger.log('Mask Edit', 'Armed canvas miss')
    setMaskArmed(false, 'canvas miss')
    handleCanvasPointerDown(event)
  }, [interactionRef, setMaskArmed])

  useEffect(() => {
    const unsubscribe = useCanvasStore.subscribe((state, previous) => {
      if (state.activeTool !== previous.activeTool && state.activeTool !== 'select' && maskArmedRef.current) {
        scheduleStateSync(() => setMaskArmed(false, `active tool changed to ${state.activeTool}`))
      }
      if (state.sceneId !== previous.sceneId) {
        scheduleStateSync(() => {
          setMaskArmed(false, 'scene changed')
          clearPendingInitialPoint('scene changed')
        })
      }
      if (maskArmedRef.current && !hasVisibleImage(state.nodes)) {
        scheduleStateSync(() => setMaskArmed(false, 'no visible images remain'))
      }
      const activeMaskNodeId = maskEditNodeIdRef.current
      if (
        activeMaskNodeId &&
        !state.nodes.some((node) => node.id === activeMaskNodeId && node.type === 'image' && !node.hidden)
      ) {
        maskEditNodeIdRef.current = undefined
        scheduleStateSync(() => {
          debugLogger.log('Mask Edit', `Mask edit canceled: target image unavailable ${activeMaskNodeId}`)
          cancelMaskEdit()
        })
      }
      const pending = pendingInitialClientPointRef.current
      if (pending && !state.nodes.some((node) => node.id === pending.nodeId && node.type === 'image' && !node.hidden)) {
        scheduleStateSync(() => {
          updatePendingInitialPoint({ type: 'clear' }, (point) => (
            `Pending initial point for ${point.nodeId} discarded: target image unavailable`
          ))
        })
      }
    })
    return unsubscribe
  }, [cancelMaskEdit, clearPendingInitialPoint, scheduleStateSync, setMaskArmed, updatePendingInitialPoint])

  useEffect(() => {
    if (lastMaskCancelRequestIdRef.current === maskCancelRequestId) return
    lastMaskCancelRequestIdRef.current = maskCancelRequestId
    const frame = window.requestAnimationFrame(cancelMaskEdit)
    return () => window.cancelAnimationFrame(frame)
  }, [cancelMaskEdit, maskCancelRequestId])

  useEffect(() => {
    const active = Boolean(maskEditNodeId)
    onMaskEditActiveChange?.(active)

    return () => {
      if (active) onMaskEditActiveChange?.(false)
    }
  }, [maskEditNodeId, onMaskEditActiveChange])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !maskArmedRef.current) return
      event.preventDefault()
      event.stopPropagation()
      setMaskArmed(false, 'escape')
      clearPendingInitialPoint('escape')
    }

    window.addEventListener('keydown', handleEscape, { capture: true })
    return () => window.removeEventListener('keydown', handleEscape, { capture: true })
  }, [clearPendingInitialPoint, setMaskArmed])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      maskEditAbortRef.current?.abort()
      if (pendingInitialClientPointRef.current) {
        debugLogger.log('Mask Edit', `Pending initial point for ${pendingInitialClientPointRef.current.nodeId} cleared: unmount`)
      }
    }
  }, [])

  return {
    maskArmed,
    maskEditNodeId,
    maskEditSubmittingNodeId,
    initialClientPoint,
    beginMaskEdit,
    submitMaskEdit,
    cancelMaskEdit,
    toggleMaskArmed,
    wrapNodePointerDown,
    wrapCanvasPointerDown,
    handleInitialClientPointHandled,
  }
}
