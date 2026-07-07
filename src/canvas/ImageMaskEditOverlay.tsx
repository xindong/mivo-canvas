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
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { debugLogger } from '../store/debugLogStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  boundsForRegions,
  buildEditMaskBlob,
  displayRectForImage,
  maskEditDefaultModel,
  maskEditQualityFor,
  nodePointToImagePixel,
  pointMaskRadiusFor,
  validateMaskCanvasSize,
  type ImageMaskBounds,
  type ImageMaskPoint,
  type ImageMaskRegion,
  type ImageMaskSubmitPayload,
} from './imageMaskGeometry'
import type { MaskInitialClientPoint } from './maskPointPending'
import { buildMaskEditPromptBundle } from './maskEditSubmit'
import {
  pointAnchorPath,
  regionPath,
  renderPointMarker,
  renderRegionBadge,
} from './maskEditOverlayRender'
import { toContainer, type Viewport } from '../render/EditOverlayLayer'
import { recognitionLabel, useMaskAnchorRecognition } from './useMaskAnchorRecognition'

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

type FloatingControlsLayout = {
  left: number
  width: number
  toolbarTop: number
  promptTop: number
}

// 圈选工具族（2026-07-07 用户）：红圈让用户自己画——椭圆/矩形/手绘圈选/点选
// (自动圈)，所见即所得地画到标注图上。排序按用户指定。
const toolItems: Array<{ id: ImageMaskTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'ellipse', label: '椭圆', icon: CircleIcon },
  { id: 'box', label: '矩形', icon: Square },
  { id: 'loop', label: '圈选', icon: Lasso },
  { id: 'point', label: '点选', icon: MousePointer2 },
]

// 富文本编辑器里 chip token 的锚点 key 属性名（DOM ↔ region 关联）。
const anchorKeyAttr = 'data-anchor-key'
const minimumBoxSizePx = 8
const floatingControlsMargin = 12
const floatingControlsGap = 10
const floatingToolbarHeight = 114
// 加宽（用户 2026-07-07）：4 个工具按钮 + 关闭要能在一排放下，不换行；顺带让
// prompt 描述少折行。竖图时浮层宽度以前只有 ~320，「点选」会被挤到第二行。
const floatingControlsMinWidth = 400
const floatingControlsMaxWidth = 480

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// 渲染辅助(radiusToNode / regionPath / pointAnchorPath / renderPointMarker /
// renderRegionBadge)已抽离到 ./maskEditOverlayRender (structure guard >900,
// 机械抽离,行为不变)。

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
  // 3b: viewport replaces the old viewportScale prop. Alias kept so the rest of
  // the component (deps arrays, MaskPointMarker, strokeWidth) reads viewportScale
  // unchanged — only the positioning container + Props changed.
  const { scale: viewportScale } = viewport
  const stageRef = useRef<HTMLDivElement | null>(null)
  // 浮层实际高度随内容变化（模型行、识别标签、错误提示会增高）。用真实测量值
  // 定位并夹在画布内，避免写死常量低估高度导致按钮被顶出可视区（放大时尤甚）。
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<ImageMaskTool>('ellipse')
  // 局部重绘固定用 Gemini（nano-banana，2K 指令式局部重绘）——不再提供 GPT 选项。
  // 质量由模型固定映射（maskEditQualityFor(maskEditDefaultModel) = high）。
  const fieldRef = useRef<HTMLDivElement | null>(null)
  // 富文本编辑器 DOM（chip token + 文字混排，命令式维护 chip，不受 React 重渲染影响）。
  const editorRef = useRef<HTMLDivElement | null>(null)
  const [regions, setRegions] = useState<ImageMaskRegion[]>([])
  const [pointAnchors, setPointAnchors] = useState<PointAnchor[]>([])
  const [past, setPast] = useState<MaskEditSnapshot[]>([])
  const [future, setFuture] = useState<MaskEditSnapshot[]>([])
  const [draft, setDraft] = useState<DraftRegion>()
  const [floatingHost, setFloatingHost] = useState<HTMLElement | null>(null)
  const [floatingLayout, setFloatingLayout] = useState<FloatingControlsLayout>()
  const [statusError, setStatusError] = useState('')
  const regionsRef = useRef<ImageMaskRegion[]>([])
  const pointAnchorsRef = useRef<PointAnchor[]>([])
  const draftRef = useRef<DraftRegion | undefined>(undefined)
  const removeWindowDragListenersRef = useRef<() => void>(() => undefined)
  const handledInitialClientPointKeyRef = useRef<string | undefined>(undefined)
  const initialFollowupPointerRef = useRef<{ clientX: number; clientY: number } | undefined>(undefined)
  // F1 (审 P2): 同步 in-flight guard，防快速双击/大图 toBlob 慢导致双提交。
  // 进入 submit 即置位；成功后 overlay 卸载（hook 清 maskEditNodeId）自然解除；失败 catch 清回。
  const submitInFlightRef = useRef(false)
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
  } = useMaskAnchorRecognition({ regions, naturalSize, resolvedAssetUrl })

  const updateDraft = (nextDraft?: DraftRegion) => {
    draftRef.current = nextDraft
    setDraft(nextDraft)
  }

  const updateFloatingControls = useCallback(() => {
    const stage = stageRef.current
    const shell = stage?.closest('.canvas-shell') as HTMLElement | null
    if (!stage || !shell) return

    const stageRect = stage.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    // 抽屉侧栏(position:fixed, z-index 80)浮在画布之上,会盖住浮层左半。测出它的
    // 右边界,把浮层左界推到抽屉右侧,避免工具条钻到栏后无法操作。
    let leftBound = floatingControlsMargin
    const drawer = shell.ownerDocument.querySelector('.project-sidebar.drawer:not(.closed)') as HTMLElement | null
    if (drawer) {
      const drawerRect = drawer.getBoundingClientRect()
      if (drawerRect.width > 0 && drawerRect.right > shellRect.left) {
        leftBound = Math.max(leftBound, drawerRect.right - shellRect.left + floatingControlsGap)
      }
    }
    const maxWidth = Math.max(floatingControlsMinWidth, shellRect.width - leftBound - floatingControlsMargin)
    const width = Math.min(floatingControlsMaxWidth, maxWidth, Math.max(floatingControlsMinWidth, stageRect.width))
    const stageLeft = stageRect.left - shellRect.left
    const stageTop = stageRect.top - shellRect.top
    const stageBottom = stageTop + stageRect.height
    const left = clamp(
      stageLeft + stageRect.width / 2 - width / 2,
      leftBound,
      Math.max(leftBound, shellRect.width - width - floatingControlsMargin),
    )
    // 真实测量高度优先（挂载后可得），首帧回退到常量估算。prompt 面板仅在有锚点时
    // 渲染（promptRef 为 null），此时不预留它的高度，工具条独立定位。
    const toolbarHeight = toolbarRef.current?.offsetHeight || floatingToolbarHeight
    const promptEl = promptRef.current
    const promptHeight = promptEl ? promptEl.offsetHeight : 0
    const promptGap = promptEl ? floatingControlsGap : 0
    const stackHeight = toolbarHeight + promptGap + promptHeight
    const minStackTop = floatingControlsMargin
    const maxStackTop = Math.max(floatingControlsMargin, shellRect.height - stackHeight - floatingControlsMargin)
    const belowStackTop = stageBottom + floatingControlsGap
    const aboveStackTop = stageTop - stackHeight - floatingControlsGap
    const stackTop =
      belowStackTop <= maxStackTop
        ? belowStackTop
        : aboveStackTop >= minStackTop
          ? aboveStackTop
          : clamp(belowStackTop, minStackTop, maxStackTop)
    const toolbarTop = stackTop
    const promptTop = stackTop + toolbarHeight + promptGap

    setFloatingHost(shell)
    setFloatingLayout((current) => {
      const nextLayout = {
        left: Math.round(left),
        width: Math.round(width),
        toolbarTop: Math.round(toolbarTop),
        promptTop: Math.round(promptTop),
      }
      return current &&
        current.left === nextLayout.left &&
        current.width === nextLayout.width &&
        current.toolbarTop === nextLayout.toolbarTop &&
        current.promptTop === nextLayout.promptTop
        ? current
        : nextLayout
    })
  }, [])

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

    try {
      setStatusError('')
      validateMaskCanvasSize(naturalSize)
      const mask = regions.length
        ? await buildEditMaskBlob({ naturalSize, imageCrop: node.imageCrop, regions })
        : undefined
      // 多锚点：每个锚点带识别标签 + 自身 bounds（供红圈标注图 + 兜底用）。
      const subjects = regions
        .map((region) => {
          const label = recognitionLabel(recognitionsRef.current[regionKey(region)])
          const bounds = boundsForRegions([region], naturalSize)
          return label && bounds ? { label, bounds } : undefined
        })
        .filter((subject): subject is { label: string; bounds: ImageMaskBounds } => Boolean(subject))
      // 提交装配(锚点方位编排 + 结构化提示词组装 + 红圈标注图)已抽离到
      // ./maskEditSubmit (structure guard >900,机械抽离,行为不变)。
      const { finalPrompt, markedImage } = await buildMaskEditPromptBundle({
        body,
        regions,
        naturalSize,
        resolvedAssetUrl,
        recognitionsRef,
        regionKey,
      })
      await onSubmit({
        prompt: finalPrompt,
        mask,
        maskBounds: regions.length ? boundsForRegions(regions, naturalSize) : undefined,
        sourceSize: naturalSize,
        model: maskEditDefaultModel,
        quality: maskEditQualityFor(maskEditDefaultModel),
        subjects: subjects.length ? subjects : undefined,
        markedImage: markedImage ?? undefined,
      })
      // 成功：overlay 由 hook 清 maskEditNodeId 卸载，submitInFlightRef 随卸载解除，不主动清。
    } catch (error) {
      submitInFlightRef.current = false // 调度失败清回，允许重试
      setStatusError(error instanceof Error ? error.message : '局部重绘失败。')
    }
  }

  // 富文本编辑器序列化：走一遍 childNodes，chip → 当前标签、文本 → 原文，合起来
  // 即「编辑要求」正文（标签也是正文的一部分）；hasText 用于占位符显隐。
  const readEditor = useCallback((): { prompt: string; hasText: boolean } => {
    const editor = editorRef.current
    if (!editor) return { prompt: '', hasText: false }
    const tokens: string[] = []
    let textChars = ''
    editor.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ''
        tokens.push(text)
        textChars += text
      } else if (node instanceof HTMLElement && node.hasAttribute(anchorKeyAttr)) {
        tokens.push(recognitionLabel(recognitionsRef.current[node.getAttribute(anchorKeyAttr) as string]))
      } else if (node instanceof HTMLElement) {
        const text = node.textContent ?? ''
        tokens.push(text)
        textChars += text
      }
    })
    const prompt = tokens
      .map((token) => token.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { prompt, hasText: textChars.trim().length > 0 }
  }, [recognitionsRef])

  const buildChipNode = useCallback((key: string, n: number, label: string): HTMLElement => {
    const chip = document.createElement('span')
    chip.className = 'image-mask-edit-chip'
    chip.setAttribute(anchorKeyAttr, key)
    chip.contentEditable = 'false'
    const idx = document.createElement('span')
    idx.className = 'image-mask-edit-chip-index'
    idx.textContent = String(n)
    const lbl = document.createElement('span')
    lbl.className = 'image-mask-edit-chip-label'
    lbl.textContent = label
    const caret = document.createElement('span')
    caret.className = 'image-mask-edit-chip-caret'
    caret.setAttribute('data-caret-key', key)
    caret.textContent = '⌄'
    chip.append(idx, lbl, caret)
    return chip
  }, [])

  // 增量维护 chip：已存在的就地更新序号/标签（绝不移动，避免在标签间打字时乱跳），
  // 新锚点插在「上一个锚点 chip 之后」，被删的锚点移除其 chip。光标/文本节点不受影响。
  const syncEditorChips = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const desired = regions.map((region, index) => ({
      key: regionKey(region),
      n: index + 1,
      label: recognitionLabel(recognitions[regionKey(region)]) || '识别中…',
    }))
    const desiredKeys = new Set(desired.map((item) => item.key))
    editor.querySelectorAll(`[${anchorKeyAttr}]`).forEach((node) => {
      if (!desiredKeys.has(node.getAttribute(anchorKeyAttr) as string)) node.remove()
    })
    let previousChip: HTMLElement | null = null
    for (const item of desired) {
      let chip = editor.querySelector(`[${anchorKeyAttr}="${item.key}"]`) as HTMLElement | null
      if (chip) {
        const idxEl = chip.querySelector('.image-mask-edit-chip-index')
        if (idxEl && idxEl.textContent !== String(item.n)) idxEl.textContent = String(item.n)
        const lblEl = chip.querySelector('.image-mask-edit-chip-label')
        if (lblEl && lblEl.textContent !== item.label) lblEl.textContent = item.label
      } else {
        chip = buildChipNode(item.key, item.n, item.label)
        if (previousChip && previousChip.parentNode === editor) {
          editor.insertBefore(chip, previousChip.nextSibling)
        } else {
          editor.insertBefore(chip, editor.firstChild)
        }
      }
      previousChip = chip
    }
  }, [regions, recognitions, regionKey, buildChipNode])

  // 清洗 contenteditable DOM：浏览器会在输入/粘贴时自动塞 <br> 和 <div>/<p> 块级
  // 包装（空编辑框自带隐形 <br>），把 chip 和文字挤成多行，还会让序列化把包装里的
  // chip 误读成文字。这里把块级包装拆平、隐形 <br> 删掉、粘贴的样式包装转纯文本，
  // 保证内容始终是「顶层内联流」。文本节点原样保留（光标不丢）。
  const normalizeEditorDom = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    let changed = true
    while (changed) {
      changed = false
      for (const node of Array.from(editor.childNodes)) {
        if (!(node instanceof HTMLElement) || node.hasAttribute(anchorKeyAttr)) continue
        if (node.tagName === 'BR') {
          node.remove()
          changed = true
        } else if (node.tagName === 'DIV' || node.tagName === 'P') {
          while (node.firstChild) editor.insertBefore(node.firstChild, node)
          node.remove()
          changed = true
        } else if (node.querySelector(`[${anchorKeyAttr}]`)) {
          while (node.firstChild) editor.insertBefore(node.firstChild, node)
          node.remove()
          changed = true
        } else {
          editor.replaceChild(editor.ownerDocument.createTextNode(node.textContent ?? ''), node)
          changed = true
        }
      }
    }
  }, [])

  const handleEditorInput = () => {
    const editor = editorRef.current
    if (!editor) return
    normalizeEditorDom()
    // 删除 chip（Delete/Backspace）→ 同步移除对应锚点，画布 pin 一并消失，可撤销。
    const presentKeys = new Set(
      Array.from(editor.querySelectorAll(`[${anchorKeyAttr}]`)).map((node) => node.getAttribute(anchorKeyAttr)),
    )
    const surviving = regionsRef.current.filter((region) => presentKeys.has(regionKey(region)))
    if (surviving.length !== regionsRef.current.length) {
      const survivingKeys = new Set(surviving.map((region) => regionKey(region)))
      writeRecognitions((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => survivingKeys.has(key))),
      )
      commitMaskState(surviving, pointAnchorsRef.current)
    }
    editor.classList.toggle('is-empty-text', !readEditor().hasText)
  }

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Enter 拦掉：contenteditable 回车会插 <div>/<br> 块级包装，产生诡异换行且破坏
    // 序列化；正文不需要手动换行，长了自动折行。
    if (event.key === 'Enter') {
      event.preventDefault()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    // Escape 分级：候选卡开着先收卡，再按才退出局部重绘。
    if (openChipKey) {
      setOpenChipKey(null)
      return
    }
    onCancel()
  }

  // 点 chip 切换箭头 → 展开/收起该锚点的候选卡；点 chip 主体 → 整体选中（可复制/删除/粘贴调序）。
  const handleEditorClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    const caret = target?.closest('[data-caret-key]') as HTMLElement | null
    if (caret) {
      event.preventDefault()
      const key = caret.getAttribute('data-caret-key') as string
      setOpenChipKey((current) => (current === key ? null : key))
      return
    }
    const chip = target?.closest(`[${anchorKeyAttr}]`) as HTMLElement | null
    if (chip && editorRef.current?.contains(chip)) {
      event.preventDefault()
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        range.selectNode(chip)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  // chip 选中态：原生选区盖到 chip 上时打 is-selected。
  useEffect(() => {
    const handleSelectionChange = () => {
      const editor = editorRef.current
      if (!editor) return
      const selection = document.getSelection()
      editor.querySelectorAll(`[${anchorKeyAttr}]`).forEach((chip) => {
        const selected = Boolean(
          selection && selection.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(chip),
        )
        chip.classList.toggle('is-selected', selected)
      })
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  // 粘贴：带我们的 chip → 「移动」语义（删原位重建，即复制粘贴调顺序）；普通内容降级纯文本。
  const handleEditorPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    if (!editor) return
    event.preventDefault()
    const html = event.clipboardData?.getData('text/html') || ''
    const text = event.clipboardData?.getData('text/plain') || ''
    const selection = editor.ownerDocument.getSelection()
    if (!selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const fragment = editor.ownerDocument.createDocumentFragment()
    if (html.includes(anchorKeyAttr)) {
      const validKeys = new Set(regionsRef.current.map((region) => regionKey(region)))
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent ?? ''
          if (value) fragment.appendChild(editor.ownerDocument.createTextNode(value))
          return
        }
        if (node instanceof HTMLElement && node.hasAttribute(anchorKeyAttr)) {
          const key = node.getAttribute(anchorKeyAttr) as string
          if (!validKeys.has(key)) return
          editor.querySelectorAll(`[${anchorKeyAttr}="${key}"]`).forEach((existing) => existing.remove())
          const index = regionsRef.current.findIndex((region) => regionKey(region) === key)
          fragment.appendChild(
            buildChipNode(key, index + 1, recognitionLabel(recognitionsRef.current[key]) || '识别中…'),
          )
          return
        }
        node.childNodes.forEach(walk)
      }
      parsed.body.childNodes.forEach(walk)
    } else if (text) {
      fragment.appendChild(editor.ownerDocument.createTextNode(text))
    }
    const lastInserted = fragment.lastChild
    range.insertNode(fragment)
    if (lastInserted) {
      range.setStartAfter(lastInserted)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    handleEditorInput()
  }

  // regions/recognitions 变化 → 同步 chip 到编辑器，并刷新占位符。先清洗（空
  // contenteditable 自带隐形 <br>，不清掉会把首批 chip 挤到第二行）。
  useEffect(() => {
    normalizeEditorDom()
    syncEditorChips()
    editorRef.current?.classList.toggle('is-empty-text', !readEditor().hasText)
  }, [normalizeEditorDom, syncEditorChips, readEditor])

  // 识别 debounce effect + 卸载 abort effect 已搬入 useMaskAnchorRecognition hook
  // (structure guard >900 机械抽离,行为不变)。

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
  }, [openChipKey, setOpenChipKey])

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
                // 都能关卡片（修「自定义打完回车菜单不消失」）。
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== 'Escape') return
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
            className="image-mask-edit-submit"
            onClick={() => void submit()}
            disabled={submitting || !hasAnyAnchor}
          >
            <Sparkles size={15} />
            {submitting ? '重绘中...' : '局部重绘'}
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
                    {renderRegionBadge(shape.x, shape.y, index + 1, index, viewportScale)}
                  </g>
                )
              }
              if (shape.kind === 'loop') {
                if (!shape.points.length) return null
                const xs = shape.points.map((point) => point.x)
                const ys = shape.points.map((point) => point.y)
                // path 不带 Z：描边不画首尾闭合连线（用户反馈），fill 仍按闭合区域填充。
                const d = `M ${shape.points.map((point) => `${point.x} ${point.y}`).join(' L ')}`
                return (
                  <g key={index}>
                    <path className="image-mask-edit-region loop" d={d} />
                    {renderRegionBadge(Math.min(...xs), Math.min(...ys), index + 1, index, viewportScale)}
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
