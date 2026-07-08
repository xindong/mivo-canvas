import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import { beginMaskEditMessage, runMaskEditChatFlow } from '../store/chatMaskEditFlow'
import { registerMaskEditTask } from '../store/maskEditTaskRuntime'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { MivoImageRatio } from '../types/generation'
import { prepareMaskEditPlaceholder } from './maskEditGeneration'
import type { ImageMaskSubmitPayload } from './imageMaskGeometry'
import { nodeIdFromDomTarget, type RuntimeCanvasTool } from './canvasInteraction'
import { reduceMaskPointPending, shouldCancelPendingMaskEdit, type MaskInitialClientPoint, type MaskPointPendingAction } from './maskPointPending'
import type { HitTestTarget } from '../render/hitTest'

export type MaskPointArmedInteractionApi = {
  /** Shell hit-test peek (screenToCanvas + resolveHitTarget). Armed mode peeks
   * this to detect image hits → beginMaskEdit, since per-node dispatch is gone. */
  resolveCanvasHit: (clientX: number, clientY: number) => HitTestTarget | null
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

  // （2026-07-08）armed 首击不再落 initial point，record 函数随之移除；
  // pending 机制其余部分（clear/discard-stale）保留供防串扰逻辑使用。

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

  // mask-chat-card: cancelMaskEdit 现在只关闭交互层（overlay/draft），不 abort 已提交的
  // 后台任务。runtime abortController 已移入 maskEditTaskRuntime registry，由卡片取消
  // （cancelGeneration → cancelMaskEditMessage）统一终止；Esc/点画布/overlay X/target
  // 删除/unmount/maskCancelRequestId 都走本函数，只清本 hook 的 draft state。
  const cancelMaskEdit = useCallback((reason = 'mask edit canceled') => {
    maskEditNodeIdRef.current = undefined
    setMaskEditNodeId(undefined)
    setMaskEditSubmittingNodeId(undefined)
    setMaskArmed(false, reason)
    clearPendingInitialPoint(reason)
  }, [clearPendingInitialPoint, setMaskArmed])

  const beginMaskEdit = useCallback((nodeId: string) => {
    // D4 直接入口（dock 按钮 / 上下文菜单）与指针路径同语义：开镜时立即解除 armed，
    // 避免 armed 残留导致下一次点击被 wrapNodePointerDown 当作 armed 命中处理。
    setMaskArmed(false, 'mask edit started')
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
  }, [clearCropNode, closeContextMenu, selectNode, setMaskArmed, updatePendingInitialPoint])

  const submitMaskEdit = useCallback(
    async (nodeId: string, resolvedAssetUrl: string, payload: ImageMaskSubmitPayload) => {
      const targetSceneId = sceneId
      const source = useCanvasStore
        .getState()
        .canvases[targetSceneId]?.nodes.find((node) => node.id === nodeId && node.type === 'image' && !node.hidden)
      if (!source) throw new Error('Source image not found')
      // F1 (审 P2): 双保险 in-flight guard。overlay 的 submitInFlightRef 覆盖 buildEditMaskBlob
      // 前窗口；本 setMaskEditSubmittingNodeId 覆盖 submitMaskEdit 执行窗口（buildEditMaskBlob
      // 之后到 cancelMaskEdit 之前）。成功路径 cancelMaskEdit 清回；catch 清回失败路径。
      // 防快速双击/大图 toBlob 慢导致双提交（两个 placeholder + 两组 chat message + 两条 edit POST）。
      setMaskEditSubmittingNodeId(nodeId)
      try {
        const { slotId, baselineSnapshot } = prepareMaskEditPlaceholder(targetSceneId, source, payload.prompt)
        // mask-chat-card: 调度后台任务，不 await 全程。创建 chat enhancing card + runtime
        // record 后立即关闭 overlay；enhance→edit→finish 由 runMaskEditChatFlow 后台驱动，
        // 卡片状态由 chatMaskEditFlow 经 callbacks 收口。多 mask 并发允许（不 abort 旧任务）。
        const imgRatio = closestMivoRatioForSize(payload.sourceSize)
        const messageId = beginMaskEditMessage({
          sceneId: targetSceneId,
          source,
          prompt: payload.prompt,
          slotId,
          imgRatio,
          quality: payload.quality,
        })
        const abortController = new AbortController()
        registerMaskEditTask({
          sceneId: targetSceneId,
          messageId,
          slotId,
          baselineSnapshot,
          abortController,
          source,
          resolvedAssetUrl,
          payload,
          imgRatio,
          quality: payload.quality,
        })
        // 关闭 overlay 交互层（不 abort runtime task）；submitMaskEdit 立即返回，
        // overlay 由本 cancelMaskEdit 关闭（同时清 setMaskEditSubmittingNodeId），enhance/edit 后台继续。
        cancelMaskEdit('mask edit submitted')
        void runMaskEditChatFlow({
          sceneId: targetSceneId,
          messageId,
          slotId,
          baselineSnapshot,
          abortController,
          source,
          resolvedAssetUrl,
          payload,
          imgRatio,
          quality: payload.quality,
        }).catch((error) => {
          debugLogger.error(
            'Mask Edit',
            `runMaskEditChatFlow crashed for ${source.title} (msg ${messageId}): ${error instanceof Error ? error.message : 'unknown'}`,
          )
      })
      } catch (error) {
        // F1: 调度失败清回 submitting（成功路径 cancelMaskEdit 已清），允许重试。
        setMaskEditSubmittingNodeId(undefined)
        throw error
      }
    },
    [cancelMaskEdit, sceneId],
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
    // 文案覆盖四种选区工具（不止点选）；toast 定位已抬到主工具条上方（App.css .toast-viewport）。
    toastFeedback.info('点击图片，用椭圆/矩形/圈选/点选标出要修改的位置')
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

  // Phase 1b-4: per-node dispatch is gone; the shell resolves hits. Armed mode
  // peeks resolveCanvasHit to detect image hits → beginMaskEdit (was
  // wrapNodePointerDown's job). Non-image / blank / non-primary → disarm + fall
  // through to handleCanvasPointerDown, mirroring the pre-1b-4 unconditional
  // disarm that ran before handleCanvasPointerDown's UI-skip (so UI targets like
  // the tool dock still disarm; SelectionQuickToolbar stops propagation at the DOM
  // level so it never reaches here — both behaviors preserved as-is).
  // W5 (QoL batch, from #87): maskEditNodeId set but overlay not mounted →
  // pointerdown on a different node/blank must cancel the pending mask edit so the
  // late-arriving overlay doesn't pop up over a new selection. 1b-4 把 #87 的
  // wrapNodePointerDown node-branch W5 + blank-canvas W5 合并到 wrapCanvasPointerDown
  // 的非 armed 分支(resolveCanvasHit 取 hitNodeId,undefined 覆盖 blank)。
  const wrapCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const { handleCanvasPointerDown, resolveCanvasHit, temporaryTool, isPanning } = interactionRef.current
    if (!maskArmedRef.current || temporaryTool || isPanning) {
      // DOM-first(同 ctx/dbl):pending 窗口 resolveCanvasHit 因 activeEditState 激活返回
      // edit-overlay-cancel 而非 node,hitNodeId 恒 undefined → shouldCancelPendingMaskEdit
      // 误判 blank 误取消同节点 re-engage(Greptile P1)。改 nodeIdFromDomTarget 绕开短路。
      // 点外即关维持;锚点由 maskEditDraftStore 在卸载时保存,不丢(2026-07-08 用户)。
      const pendingMaskNodeId = maskEditNodeIdRef.current
      const hitNodeId = nodeIdFromDomTarget(event.target) ?? undefined
      if (shouldCancelPendingMaskEdit(pendingMaskNodeId, hitNodeId)) {
        cancelMaskEdit()
      }
      handleCanvasPointerDown(event)
      return
    }

    const primaryUnmodified = event.button === 0 && !event.ctrlKey && !event.metaKey
    if (!primaryUnmodified) {
      debugLogger.log('Mask Edit', 'Armed pointer ignored: non-primary or modified click')
      setMaskArmed(false, 'non-primary node pointer')
      handleCanvasPointerDown(event)
      return
    }

    const target = resolveCanvasHit(event.clientX, event.clientY)
    const node = target?.kind === 'node'
      ? useCanvasStore.getState().nodes.find((item) => item.id === target.nodeId)
      : undefined
    if (node?.type === 'image' && !node.hidden) {
      event.preventDefault()
      event.stopPropagation()
      // 2026-07-08 用户：armed 后的首击只负责「打开浮层」（工具条立现，默认椭圆），
      // 不再把这一击当成 point 锚点落下——否则用户的第一个动作永远被强制成点选。
      // 故不 recordPendingInitialPoint；用户在浮层里自选工具画选区。
      beginMaskEdit(node.id)
      setMaskArmed(false, 'image hit')
      debugLogger.log('Mask Edit', `Armed image hit: ${node.id} (open overlay only, no initial point)`)
      return
    }

    setMaskArmed(false, node ? 'node miss' : 'canvas miss')
    debugLogger.log('Mask Edit', node ? `Armed node miss: ${node.id}` : 'Armed canvas miss')
    handleCanvasPointerDown(event)
  }, [beginMaskEdit, cancelMaskEdit, interactionRef, setMaskArmed])

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
    const frame = window.requestAnimationFrame(() => cancelMaskEdit('mask cancel request'))
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
      // mask-chat-card: unmount 不 abort runtime task（后台 task 由 registry 管理，卡片取消收口）；
      // 只清本 hook 的 draft state。
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
    wrapCanvasPointerDown,
    handleInitialClientPointHandled,
  }
}
