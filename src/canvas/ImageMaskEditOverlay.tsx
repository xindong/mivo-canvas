import {
  Check,
  Circle as CircleIcon,
  Lasso,
  MapPin,
  MousePointer2,
  Redo2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { isImeComposing } from '../lib/imeSafeEnter'
import { debugLogger } from '../store/debugLogStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  buildEditMaskBlob,
  displayRectForImage,
  nodePointToImagePixel,
  pointMaskRadiusFor,
  validateMaskCanvasSize,
  type ImageMaskPoint,
  type ImageMaskRegion,
  type ImageMaskSubmitPayload,
} from './imageMaskGeometry'
import type { MaskInitialClientPoint } from './maskPointPending'
import { buildMaskEditSubmission } from './maskEditSubmit'
import { clearMaskEditDraft, getMaskEditDraft, saveMaskEditDraft } from './maskEditDraftStore'
import { useCanvasStore } from '../store/canvasStore'
import { useMaskRichEditor } from './useMaskRichEditor'
import { computeFloatingControls, type FloatingControlsLayout } from './maskEditFloatingControls'
import {
  pointAnchorPath,
  regionPath,
  renderPointMarker,
  renderRegionBadge,
} from './maskEditOverlayRender'
import { toContainer, type Viewport } from '../render/EditOverlayLayer'
import { useMaskAnchorRecognition } from './useMaskAnchorRecognition'

type ImageMaskTool = 'point' | 'box' | 'ellipse' | 'loop'

type ImageMaskEditOverlayProps = {
  node: MivoCanvasNode
  resolvedAssetUrl: string
  naturalSize: { width: number; height: number }
  /**
   * 3b (Phase 3b): the mask overlay moved out of the image DOM node into
   * EditOverlayLayer (canvas-shell direct child, screen space). Positioning is
   * viewport + node geometry (container transform-scale at toContainer(node.x/y)),
   * so it no longer reads the image DOM node's rect — image DOM node can move to
   * Leafer (3c) without breaking the overlay. viewportScale is derived internally.
   */
  viewport: Viewport
  submitting: boolean
  initialClientPoint?: MaskInitialClientPoint
  onCancel: () => void
  onSubmit: (payload: ImageMaskSubmitPayload) => Promise<void>
  onInitialClientPointHandled?: (
    nodeId: string,
    outcome: 'consumed' | 'discarded',
    reason?: string,
  ) => void
}

type DraftRegion =
  | { type: 'box'; start: ImageMaskPoint; current: ImageMaskPoint }
  | { type: 'ellipse'; start: ImageMaskPoint; current: ImageMaskPoint }
  | { type: 'loop'; points: ImageMaskPoint[] }

type PointAnchor = {
  center: ImageMaskPoint
  radius: number
}

type MaskEditSnapshot = {
  regions: ImageMaskRegion[]
  pointAnchors: PointAnchor[]
}

// 圈选工具族（2026-07-07 用户）：红圈让用户自己画——椭圆/矩形/手绘圈选/点选
// (自动圈)，所见即所得地画到标注图上。排序按用户指定。
const toolItems: Array<{ id: ImageMaskTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'ellipse', label: '椭圆', icon: CircleIcon },
  { id: 'box', label: '矩形', icon: Square },
  { id: 'loop', label: '圈选', icon: Lasso },
  { id: 'point', label: '点选', icon: MousePointer2 },
]

const minimumBoxSizePx = 8

// 渲染辅助已抽离到 ./maskEditOverlayRender(机械抽离,行为不变)。
export function ImageMaskEditOverlay({
  node,
  resolvedAssetUrl,
  naturalSize,
  viewport,
  submitting,
  initialClientPoint,
  onCancel,
  onSubmit,
  onInitialClientPointHandled,
}: ImageMaskEditOverlayProps) {
  const { scale: viewportScale } = viewport
  const stageRef = useRef<HTMLDivElement | null>(null)
  // 浮层实际高度随内容变化（模型行、识别标签、错误提示会增高）。用真实测量值
  // 定位并夹在画布内，避免写死常量低估高度导致按钮被顶出可视区（放大时尤甚）。
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<ImageMaskTool>('ellipse')
  // 锚点草稿·恢复（2026-07-08 用户）：同一张图重进局部重绘时，锚点/识别/输入框内容
  // 直接作为初始状态惰性还原（不走 effect setState，无闪帧）；仅挂载时取一次。
  const [initialSavedDraft] = useState(() => getMaskEditDraft(node.id))
  const [regions, setRegions] = useState<ImageMaskRegion[]>(() => initialSavedDraft?.regions ?? [])
  const [pointAnchors, setPointAnchors] = useState<PointAnchor[]>(() => initialSavedDraft?.pointAnchors ?? [])
  const [past, setPast] = useState<MaskEditSnapshot[]>([])
  const [future, setFuture] = useState<MaskEditSnapshot[]>([])
  const [draft, setDraft] = useState<DraftRegion>()
  const [floatingHost, setFloatingHost] = useState<HTMLElement | null>(null)
  const [floatingLayout, setFloatingLayout] = useState<FloatingControlsLayout>()
  const [statusError, setStatusError] = useState('')
  // compose(GPT 结构化整理)进行中的本地 loading（父层 submitting 之前的窗口）。
  const [composing, setComposing] = useState(false)
  const regionsRef = useRef<ImageMaskRegion[]>(initialSavedDraft?.regions ?? [])
  const pointAnchorsRef = useRef<PointAnchor[]>(initialSavedDraft?.pointAnchors ?? [])
  const draftRef = useRef<DraftRegion | undefined>(undefined)
  const removeWindowDragListenersRef = useRef<() => void>(() => undefined)
  const handledInitialClientPointKeyRef = useRef<string | undefined>(undefined)
  const initialFollowupPointerRef = useRef<{ clientX: number; clientY: number } | undefined>(undefined)
  // F1 (审 P2): 同步 in-flight guard，防快速双击/大图 toBlob 慢导致双提交。
  // 进入 submit 即置位；成功后 overlay 卸载（hook 清 maskEditNodeId）自然解除；失败 catch 清回。
  const submitInFlightRef = useRef(false)
  // 锚点草稿（2026-07-08 用户）：待回填的编辑器 HTML；提交成功后卸载时清草稿而非保存。
  const pendingEditorHtmlRef = useRef<string | undefined>(initialSavedDraft?.editorHtml)
  const clearDraftOnUnmountRef = useRef(false)
  const hasAnyAnchor = regions.length > 0 || pointAnchors.length > 0

  const displayRect = useMemo(
    () =>
      displayRectForImage({
        nodeWidth: node.width,
        nodeHeight: node.height,
        naturalWidth: naturalSize.width,
        naturalHeight: naturalSize.height,
        imageCrop: node.imageCrop,
      }),
    [naturalSize.height, naturalSize.width, node.height, node.imageCrop, node.width],
  )

  const {
    recognitions,
    recognitionsRef,
    writeRecognitions,
    openChipKey,
    setOpenChipKey,
    regionKey,
  } = useMaskAnchorRecognition({
    regions,
    naturalSize,
    resolvedAssetUrl,
    initialRecognitions: initialSavedDraft?.recognitions,
  })

  const updateDraft = (nextDraft?: DraftRegion) => {
    draftRef.current = nextDraft
    setDraft(nextDraft)
  }

  const updateFloatingControls = useCallback(
    () => computeFloatingControls({ stageRef, toolbarRef, promptRef, setFloatingHost, setFloatingLayout }),
    [],
  )

  const currentSnapshot = (): MaskEditSnapshot => ({
    regions: regionsRef.current,
    pointAnchors: pointAnchorsRef.current,
  })

  const applySnapshot = (snapshot: MaskEditSnapshot) => {
    regionsRef.current = snapshot.regions
    pointAnchorsRef.current = snapshot.pointAnchors
    setRegions(snapshot.regions)
    setPointAnchors(snapshot.pointAnchors)
  }

  const commitMaskState = (nextRegions: ImageMaskRegion[], nextPointAnchors: PointAnchor[]) => {
    const previous = {
      regions: regionsRef.current,
      pointAnchors: pointAnchorsRef.current,
    }
    regionsRef.current = nextRegions
    pointAnchorsRef.current = nextPointAnchors
    setPast((current) => [...current, previous])
    setRegions(nextRegions)
    setPointAnchors(nextPointAnchors)
    setFuture([])
    setStatusError('')
  }

  const commitRegions = (nextRegions: ImageMaskRegion[]) => {
    commitMaskState(nextRegions, pointAnchorsRef.current)
  }


  useEffect(() => {
    if (!initialClientPoint) return
    const key = `${initialClientPoint.nodeId}:${initialClientPoint.clientX}:${initialClientPoint.clientY}`
    if (handledInitialClientPointKeyRef.current === key) return
    handledInitialClientPointKeyRef.current = key

    if (initialClientPoint.nodeId !== node.id) {
      debugLogger.log(
        'Mask Edit',
        `Initial client point discarded: expected ${node.id}, got ${initialClientPoint.nodeId}`,
      )
      onInitialClientPointHandled?.(initialClientPoint.nodeId, 'discarded', 'node mismatch')
      return
    }

    const rect = stageRef.current?.getBoundingClientRect()
    const localPoint = rect
      ? {
          x: ((initialClientPoint.clientX - rect.left) / Math.max(1, rect.width)) * node.width,
          y: ((initialClientPoint.clientY - rect.top) / Math.max(1, rect.height)) * node.height,
        }
      : undefined
    const pixel = localPoint ? nodePointToImagePixel(localPoint, displayRect, naturalSize, node.imageCrop) : undefined
    if (!pixel) {
      debugLogger.warn('Mask Edit', `Initial client point for ${node.id} discarded: outside image pixels`)
      onInitialClientPointHandled?.(node.id, 'discarded', 'pixel unavailable')
      return
    }

    const radius = pointMaskRadiusFor(naturalSize)
    const previous = {
      regions: regionsRef.current,
      pointAnchors: pointAnchorsRef.current,
    }
    const nextRegions = [...regionsRef.current, { type: 'brush' as const, points: [pixel], radius }]
    regionsRef.current = nextRegions
    setPast((current) => [...current, previous])
    setRegions(nextRegions)
    setFuture([])
    setStatusError('')
    initialFollowupPointerRef.current = {
      clientX: initialClientPoint.clientX,
      clientY: initialClientPoint.clientY,
    }
    debugLogger.log('Mask Edit', `Initial client point consumed for ${node.id} with radius ${radius}px`)
    onInitialClientPointHandled?.(node.id, 'consumed')
  }, [displayRect, initialClientPoint, naturalSize, node.height, node.id, node.imageCrop, node.width, onInitialClientPointHandled])

  useEffect(() => () => removeWindowDragListenersRef.current(), [])

  useLayoutEffect(() => {
    updateFloatingControls()
    // hasAnyAnchor: prompt 面板出现/消失时重算,工具条位置随之上/下移。
  }, [node.height, node.width, node.x, node.y, updateFloatingControls, viewportScale, hasAnyAnchor])

  useEffect(() => {
    const stage = stageRef.current
    const shell = stage?.closest('.canvas-shell')
    if (!stage || !shell) return undefined

    const frame = window.requestAnimationFrame(updateFloatingControls)
    const resizeObserver = new ResizeObserver(updateFloatingControls)
    resizeObserver.observe(stage)
    resizeObserver.observe(shell)
    // 侧栏(尤其抽屉模式)开合会改变浮层可用左界:尺寸变化用 ResizeObserver,
    // drawer/closed 等 class 切换(不改尺寸)用 MutationObserver。
    const sidebar = shell.ownerDocument.querySelector('.project-sidebar')
    if (sidebar) resizeObserver.observe(sidebar)
    const sidebarMutation = sidebar ? new MutationObserver(() => updateFloatingControls()) : null
    if (sidebar && sidebarMutation) sidebarMutation.observe(sidebar, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', updateFloatingControls)
    window.addEventListener('scroll', updateFloatingControls, true)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      sidebarMutation?.disconnect()
      window.removeEventListener('resize', updateFloatingControls)
      window.removeEventListener('scroll', updateFloatingControls, true)
    }
  }, [updateFloatingControls])

  // 浮层内容高度变化（识别标签出现/消失、错误提示、模型行换行）时重新定位，
  // 使夹取用的是真实高度而非常量估算。panelMounted 置真后稳定，effect 只跑一次。
  const panelMounted = Boolean(floatingLayout && floatingHost)
  useEffect(() => {
    if (!panelMounted) return undefined
    const panels = [toolbarRef.current, promptRef.current].filter(Boolean) as HTMLElement[]
    if (!panels.length) return undefined
    const observer = new ResizeObserver(updateFloatingControls)
    panels.forEach((panel) => observer.observe(panel))
    return () => observer.disconnect()
    // hasAnyAnchor: prompt 面板挂载/卸载时重新绑定观察,确保量到它的真实高度。
  }, [panelMounted, updateFloatingControls, hasAnyAnchor])

  const localPointForClient = (clientX: number, clientY: number): ImageMaskPoint | undefined => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return undefined

    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * node.width,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * node.height,
    }
  }

  const pixelForClient = (clientX: number, clientY: number) => {
    const point = localPointForClient(clientX, clientY)
    return point ? nodePointToImagePixel(point, displayRect, naturalSize, node.imageCrop) : undefined
  }

  const updateDraftAtPixel = (pixel: ImageMaskPoint) => {
    const currentDraft = draftRef.current
    if (!currentDraft) return

    if (currentDraft.type === 'box' || currentDraft.type === 'ellipse') {
      updateDraft({ ...currentDraft, current: pixel })
      return
    }

    // 手绘圈选：采样间隔小一点,轨迹平滑。
    const lastPoint = currentDraft.points.at(-1)
    if (lastPoint && Math.hypot(lastPoint.x - pixel.x, lastPoint.y - pixel.y) < 3) {
      return
    }
    updateDraft({ ...currentDraft, points: [...currentDraft.points, pixel] })
  }

  const commitDraftAtPixel = (pixel?: ImageMaskPoint) => {
    const currentDraft = draftRef.current
    if (!currentDraft) return

    const nextRegions = regionsRef.current
    if (currentDraft.type === 'box' || currentDraft.type === 'ellipse') {
      const finalCurrent = pixel || currentDraft.current
      const x = Math.min(currentDraft.start.x, finalCurrent.x)
      const y = Math.min(currentDraft.start.y, finalCurrent.y)
      const width = Math.abs(finalCurrent.x - currentDraft.start.x)
      const height = Math.abs(finalCurrent.y - currentDraft.start.y)
      if (width >= minimumBoxSizePx && height >= minimumBoxSizePx) {
        commitRegions([...nextRegions, { type: currentDraft.type, x, y, width, height }])
      } else {
        setStatusError('选区太小，请拖出更大的区域。')
      }
    } else {
      // 手绘圈选：首尾自动闭合(存点序即可,渲染/mask 时 closePath)。至少要圈出
      // 一个有面积的形状,太小/一条线视为误触。
      const lastPoint = currentDraft.points.at(-1)
      const shouldAppendEndPoint = pixel && lastPoint && Math.hypot(lastPoint.x - pixel.x, lastPoint.y - pixel.y) >= 3
      const points = shouldAppendEndPoint ? [...currentDraft.points, pixel] : currentDraft.points
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      const spanX = points.length ? Math.max(...xs) - Math.min(...xs) : 0
      const spanY = points.length ? Math.max(...ys) - Math.min(...ys) : 0
      if (points.length >= 3 && spanX >= minimumBoxSizePx && spanY >= minimumBoxSizePx) {
        commitRegions([...nextRegions, { type: 'loop', points }])
      } else {
        setStatusError('圈选太小，请围住目标画一圈。')
      }
    }
    updateDraft(undefined)
  }

  const attachWindowDragListeners = () => {
    removeWindowDragListenersRef.current()

    const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
      if (!draftRef.current || submitting) return
      event.preventDefault()
      const pixel = pixelForClient(event.clientX, event.clientY)
      if (pixel) updateDraftAtPixel(pixel)
    }

    const handleWindowPointerEnd = (event: globalThis.PointerEvent) => {
      if (!draftRef.current || submitting) return
      event.preventDefault()
      commitDraftAtPixel(pixelForClient(event.clientX, event.clientY))
      removeWindowDragListenersRef.current()
    }

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerEnd)
    window.addEventListener('pointercancel', handleWindowPointerEnd)
    removeWindowDragListenersRef.current = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerEnd)
      window.removeEventListener('pointercancel', handleWindowPointerEnd)
      removeWindowDragListenersRef.current = () => undefined
    }
  }

  const beginPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const initialFollowupPointer = initialFollowupPointerRef.current
    if (initialFollowupPointer) {
      initialFollowupPointerRef.current = undefined
      const sameInitialPoint =
        Math.hypot(
          event.clientX - initialFollowupPointer.clientX,
          event.clientY - initialFollowupPointer.clientY,
        ) <= 2
      if (event.detail > 1 || sameInitialPoint) {
        debugLogger.log('Mask Edit', 'Ignored double-click follow-up after armed initial point')
        return
      }
    }
    if (submitting) return

    const pixel = pixelForClient(event.clientX, event.clientY)
    if (!pixel) return

    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'point') {
      const radius = pointMaskRadiusFor(naturalSize)
      commitRegions([...regionsRef.current, { type: 'brush', points: [pixel], radius }])
      debugLogger.log('Mask Edit', `Point region added with radius ${radius}px`)
      return
    }
    if (tool === 'box' || tool === 'ellipse') {
      updateDraft({ type: tool, start: pixel, current: pixel })
      attachWindowDragListeners()
      return
    }
    updateDraft({ type: 'loop', points: [pixel] })
    attachWindowDragListeners()
  }

  const undo = () => {
    const previous = past.at(-1)
    if (!previous) return
    const snapshotBeforeUndo = currentSnapshot()
    applySnapshot(previous)
    setFuture((current) => [snapshotBeforeUndo, ...current])
    setPast((current) => current.slice(0, -1))
  }

  const redo = () => {
    const next = future[0]
    if (!next) return
    setPast((current) => [...current, currentSnapshot()])
    applySnapshot(next)
    setFuture((current) => current.slice(1))
  }

  // 最新引用镜像：键盘快捷键 effect 只绑一次，仍调到含最新 past/future 的 undo/redo。
  const undoRef = useRef(undo)
  const redoRef = useRef(redo)
  useEffect(() => {
    undoRef.current = undo
    redoRef.current = redo
  })

  const clear = () => {
    if (!regionsRef.current.length && !pointAnchorsRef.current.length) return
    commitMaskState([], [])
  }

  const submit = async () => {
    // 富文本内容（标签 + 文字）序列化即「编辑要求」正文。
    const body = readEditor().prompt
    if (!body || !hasAnyAnchor || submitting) return
    // F1 (审 P2): 同步 guard，覆盖 buildEditMaskBlob 前窗口（父层 setMaskEditSubmittingNodeId
    // 只能在 submitMaskEdit 入口置位，覆盖不了 toBlob 慢的这段）。双击/大图 toBlob 慢时只产生一个 chat card + 一次 edit POST。
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    // compose(GPT 结构化整理)窗口的本地 loading：父层 submitting 在 onSubmit 回调内才置位，
    // 覆盖不了 buildMaskEditSubmission 里 await composeMaskEditBody 的几秒——期间按钮必须
    // 有可见反馈（2026-07-08 用户）。失败清回；成功后由父层 submitting 接管。
    setComposing(true)

    try {
      setStatusError('')
      validateMaskCanvasSize(naturalSize)
      const mask = regions.length
        ? await buildEditMaskBlob({ naturalSize, imageCrop: node.imageCrop, regions })
        : undefined
      // 提交装配已抽离到 ./maskEditSubmit(机械抽离,行为不变);mask 由外部 await 后传入。
      await onSubmit(
        await buildMaskEditSubmission({
          body,
          regions,
          naturalSize,
          resolvedAssetUrl,
          recognitionsRef,
          regionKey,
          mask,
        }),
      )
      // 成功：overlay 由 hook 清 maskEditNodeId 卸载，submitInFlightRef 随卸载解除，不主动清。
      // 本轮编辑已完成 → 卸载时清掉该图的锚点草稿（而非保存）。
      clearDraftOnUnmountRef.current = true
    } catch (error) {
      submitInFlightRef.current = false // 调度失败清回，允许重试
      setComposing(false)
      setStatusError(error instanceof Error ? error.message : '局部重绘失败。')
    }
  }

  // 富文本编辑器已抽离到 ./useMaskRichEditor(机械抽离,行为不变)。
  const {
    editorRef,
    fieldRef,
    readEditor,
    handleEditorInput,
    handleEditorKeyDown,
    handleEditorClick,
    handleEditorPaste,
  } = useMaskRichEditor({
    regionsRef,
    pointAnchorsRef,
    regions,
    recognitions,
    recognitionsRef,
    regionKey,
    writeRecognitions,
    openChipKey,
    setOpenChipKey,
    onCancel,
    commitMaskState,
  })

  // 锚点草稿·编辑器回填：prompt 面板在有锚点后才挂载，等 editor DOM 出现再整体写回
  // innerHTML（chip + 自由文本混排快照），随后走一次 input 流程刷占位符/清洗。
  useEffect(() => {
    const html = pendingEditorHtmlRef.current
    if (!html || !editorRef.current) return
    pendingEditorHtmlRef.current = undefined
    editorRef.current.innerHTML = html
    handleEditorInput()
  })

  // 锚点草稿·卸载即存：点外/切走/Esc/X 关闭浮层时保存当前锚点态；提交成功或目标图
  // 已被删除则清除草稿（空锚点由 saveMaskEditDraft 内部等价清除）。
  useEffect(() => {
    return () => {
      if (clearDraftOnUnmountRef.current) {
        clearMaskEditDraft(node.id)
        return
      }
      const stillExists = useCanvasStore
        .getState()
        .nodes.some((item) => item.id === node.id && item.type === 'image' && !item.hidden)
      if (!stillExists) {
        clearMaskEditDraft(node.id)
        return
      }
      // 此处就是要读【卸载瞬间的最新】ref 值（保存离开前的锚点态），
      // ref-in-cleanup 告警的「值可能已变」正是本意，禁用之。
      saveMaskEditDraft(node.id, {
        regions: regionsRef.current,
        pointAnchors: pointAnchorsRef.current,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        recognitions: recognitionsRef.current,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        editorHtml: editorRef.current?.innerHTML ?? '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  // 卡片展开时，点字段外部（含在图片上放新锚点）即收起。
  useEffect(() => {
    if (!openChipKey) return undefined
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (fieldRef.current && !fieldRef.current.contains(event.target as Node)) {
        setOpenChipKey(null)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [openChipKey, setOpenChipKey, fieldRef])

  // Cmd/Ctrl+Z 撤销锚点、Cmd/Ctrl+Shift+Z 重做(Mac 用 Cmd,Win/Linux 用 Ctrl)。
  // 焦点在文本框/输入框内时交给浏览器原生撤销,不劫持打字撤销。
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (submitting) return
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return
      event.preventDefault()
      if (event.shiftKey) redoRef.current()
      else undoRef.current()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [submitting])

  const renderedRegions: ImageMaskRegion[] = draft
    ? [
        ...regions,
        draft.type === 'box' || draft.type === 'ellipse'
          ? {
              type: draft.type,
              x: Math.min(draft.start.x, draft.current.x),
              y: Math.min(draft.start.y, draft.current.y),
              width: Math.abs(draft.current.x - draft.start.x),
              height: Math.abs(draft.current.y - draft.start.y),
            }
          : { type: 'loop' as const, points: draft.points },
      ]
    : regions

  // renderPointMarker / renderRegionBadge 已抽离到 ./maskEditOverlayRender
  // (viewportScale 参数化传入,行为不变)。

  const floatingControls =
    floatingLayout && floatingHost ? (
      <div className="image-mask-edit-floating-layer" data-canvas-ui="true">
        <div
          ref={toolbarRef}
          className="image-mask-edit-toolbar"
          data-canvas-ui="true"
          style={{ left: floatingLayout.left, top: floatingLayout.toolbarTop, width: floatingLayout.width }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {/* 第一排：工具（椭圆/矩形/圈选/点选）靠左，关闭靠最右 */}
          <div className="image-mask-edit-toolbar-row">
            <div className="image-mask-edit-tools">
              {toolItems.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  className={tool === id ? 'active' : undefined}
                  onClick={() => setTool(id)}
                  disabled={submitting}
                  title={label}
                  aria-label={label}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="image-mask-edit-close"
              onClick={onCancel}
              aria-label={submitting ? 'Cancel mask request' : 'Cancel mask edit'}
            >
              <X size={14} />
            </button>
          </div>
          {/* 第二排：撤销 / 重复 / 删除 */}
          <div className="image-mask-edit-toolbar-row image-mask-edit-history">
            <button type="button" onClick={undo} disabled={!past.length || submitting} aria-label="Undo mask region">
              <Undo2 size={14} />
            </button>
            <button type="button" onClick={redo} disabled={!future.length || submitting} aria-label="Redo mask region">
              <Redo2 size={14} />
            </button>
            <button type="button" onClick={clear} disabled={!hasAnyAnchor || submitting} aria-label="Clear mask regions">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        {hasAnyAnchor ? (
        <div
          ref={promptRef}
          className="image-mask-edit-prompt"
          data-canvas-ui="true"
          style={{ left: floatingLayout.left, top: floatingLayout.promptTop, width: floatingLayout.width }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="image-mask-edit-field" ref={fieldRef}>
            {openChipKey && recognitions[openChipKey] ? (
              <div
                className="image-mask-edit-object"
                data-canvas-ui="true"
                // 容器级兜底：无论焦点在自定义输入框、还是行内图标/空白，Enter/Escape
                // 都能关卡片（修「自定义打完回车菜单不消失」）。但 IME 合成态（选候选词
                // 期间）的 Enter 用于确认候选，不关卡片——候选确认后再按 Enter 才关。
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== 'Escape') return
                  if (event.key === 'Enter' && isImeComposing(event)) return
                  event.preventDefault()
                  event.stopPropagation()
                  setOpenChipKey(null)
                }}
              >
                <div className="image-mask-edit-object-title">
                  已标记对象{recognitions[openChipKey].recognizing ? ' · 识别中…' : ''}
                </div>
                {recognitions[openChipKey].candidates.map((candidate, index) => {
                  const active = recognitions[openChipKey].selectedIndex === index
                  return (
                    <button
                      key={`${candidate.label}-${index}`}
                      type="button"
                      className={active ? 'image-mask-edit-object-row active' : 'image-mask-edit-object-row'}
                      // pointerdown 选中（不等 click）：自定义输入框持有焦点时，
                      // click 会被 blur/焦点切换吞掉——表现为「选不了其他标签」。
                      onPointerDown={(event) => {
                        event.preventDefault()
                        const key = openChipKey
                        writeRecognitions((current) => ({ ...current, [key]: { ...current[key], selectedIndex: index } }))
                        setOpenChipKey(null)
                      }}
                      disabled={submitting}
                      aria-pressed={active}
                    >
                      <span className="image-mask-edit-object-label">{candidate.label}</span>
                      {active ? <Check size={14} /> : null}
                    </button>
                  )
                })}
                <div
                  className={
                    recognitions[openChipKey].selectedIndex === -1
                      ? 'image-mask-edit-object-row custom active'
                      : 'image-mask-edit-object-row custom'
                  }
                  // 点这行任意处都聚焦输入框（点图标/空白也能打字，Enter 才能被捕获）。
                  onClick={(event) => event.currentTarget.querySelector('input')?.focus()}
                >
                  <MapPin size={14} />
                  <input
                    type="text"
                    value={recognitions[openChipKey].customLabel}
                    disabled={submitting}
                    placeholder="自定义"
                    onFocus={() => {
                      const key = openChipKey
                      writeRecognitions((current) => ({ ...current, [key]: { ...current[key], selectedIndex: -1 } }))
                    }}
                    onChange={(event) => {
                      const key = openChipKey
                      const value = event.target.value
                      writeRecognitions((current) => ({
                        ...current,
                        [key]: { ...current[key], selectedIndex: -1, customLabel: value },
                      }))
                    }}
                    // Enter/Escape 不在这里 stopPropagation —— 让它冒泡到卡片容器统一收起。
                  />
                </div>
              </div>
            ) : null}
            {/* 富文本编辑器：标签 chip（内联原子块，序号+标签+切换箭头）与用户文字
                混排；chip 由 syncEditorChips 按 regions/recognitions 命令式维护，
                文字由用户直接编辑。序列化（chip 标签 + 文字）即「编辑要求」正文。 */}
            <div
              ref={editorRef}
              className="image-mask-edit-editor is-empty-text"
              data-canvas-ui="true"
              data-placeholder={regions.length ? '描述这些区域要怎么改…' : '描述这个区域要怎么改…'}
              contentEditable={!submitting}
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              spellCheck={false}
              onInput={handleEditorInput}
              onKeyDown={handleEditorKeyDown}
              onClick={handleEditorClick}
              onPaste={handleEditorPaste}
            />
          </div>
          {statusError ? <div className="image-mask-edit-error">{statusError}</div> : null}
          <button
            type="button"
            className={submitting || composing ? 'image-mask-edit-submit is-busy' : 'image-mask-edit-submit'}
            onClick={() => void submit()}
            disabled={submitting || composing || !hasAnyAnchor}
          >
            <Sparkles size={15} />
            {submitting ? '重绘中...' : composing ? '处理中...' : '局部重绘'}
          </button>
        </div>
        ) : null}
      </div>
    ) : null

  // 3b: mask overlay moved to EditOverlayLayer (screen space). Position at the image
  // node's screen rect via toContainer + transform-scale — equivalent to the old
  // image-DOM-node transform, so stageRef.getBoundingClientRect() still yields the
  // image node's screen rect and localPointForClient math is unchanged.
  const screenPos = toContainer(viewport, node.x, node.y)

  return (
    <>
      <div
        className="image-mask-edit-overlay"
        data-canvas-ui="true"
        data-region-count={regions.length + pointAnchors.length}
        data-mask-region-count={regions.length}
        data-point-anchor-count={pointAnchors.length}
        onPointerDown={(event) => event.stopPropagation()}
        style={{
          left: screenPos.x,
          top: screenPos.y,
          width: node.width,
          height: node.height,
          transform: `scale(${viewport.scale})`,
          transformOrigin: 'top left',
        }}
      >
        <div
          ref={stageRef}
          className="image-mask-edit-stage"
          data-canvas-ui="true"
          onPointerDown={beginPointer}
        >
          <svg width={node.width} height={node.height} viewBox={`0 0 ${node.width} ${node.height}`}>
            <rect
              x={displayRect.x}
              y={displayRect.y}
              width={displayRect.width}
              height={displayRect.height}
              className="image-mask-edit-display-rect"
            />
            {pointAnchors.map((anchor, index) => {
              const shape = pointAnchorPath(anchor, displayRect, naturalSize, node.imageCrop)
              return renderPointMarker({ x: shape.cx, y: shape.cy }, `anchor-${index}`, viewportScale)
            })}
            {renderedRegions.map((region, index) => {
              const shape = regionPath(region, displayRect, naturalSize, node.imageCrop)
              if (shape.kind === 'point') {
                // badge = 1-based 序号,与输入框标签块一一对应。
                return renderPointMarker({ x: shape.cx, y: shape.cy }, index, viewportScale, index + 1)
              }
              if (shape.kind === 'rect' || shape.kind === 'ellipse') {
                // 徽标贴描边(2026-07-08 用户「连在一起」):矩形=左上角(在描边转角上),
                // 椭圆=顶点(x+w/2, y)(在曲线上),徽标圆心落在线上→天然相切重叠。
                const badgeX = shape.kind === 'ellipse' ? shape.x + shape.width / 2 : shape.x
                return (
                  <g key={index}>
                    {shape.kind === 'rect' ? (
                      <rect
                        className="image-mask-edit-region"
                        x={shape.x}
                        y={shape.y}
                        width={shape.width}
                        height={shape.height}
                      />
                    ) : (
                      <ellipse
                        className="image-mask-edit-region"
                        cx={shape.x + shape.width / 2}
                        cy={shape.y + shape.height / 2}
                        rx={Math.max(1, shape.width / 2)}
                        ry={Math.max(1, shape.height / 2)}
                      />
                    )}
                    {renderRegionBadge(badgeX, shape.y, index + 1, index, viewportScale)}
                  </g>
                )
              }
              if (shape.kind === 'loop') {
                if (!shape.points.length) return null
                // path 不带 Z：描边不画首尾闭合连线（用户反馈），fill 仍按闭合区域填充。
                const d = `M ${shape.points.map((point) => `${point.x} ${point.y}`).join(' L ')}`
                // 徽标贴描边:取套索路径上 y 最小的实际点(最高点),徽标坐在线上,而非
                // 飘在 bbox 角(minX/minY 通常不在路径上)。
                const topPoint = shape.points.reduce((top, p) => (p.y < top.y ? p : top), shape.points[0])
                return (
                  <g key={index}>
                    <path className="image-mask-edit-region loop" d={d} />
                    {renderRegionBadge(topPoint.x, topPoint.y, index + 1, index, viewportScale)}
                  </g>
                )
              }
              return (
                <polyline
                  key={index}
                  className="image-mask-edit-region brush"
                  points={shape.points.map((point) => `${point.x},${point.y}`).join(' ')}
                  strokeWidth={shape.strokeWidth / Math.max(0.1, viewportScale)}
                />
              )
            })}
          </svg>
        </div>
      </div>
      {floatingControls && floatingHost ? createPortal(floatingControls, floatingHost) : null}
    </>
  )
}
