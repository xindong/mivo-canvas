import { MousePointer2, Redo2, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { debugLogger } from '../store/debugLogStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  boundsForRegions,
  buildEditMaskBlob,
  displayRectForImage,
  imagePixelToNodePoint,
  nodePointToImagePixel,
  pointMaskRadiusFor,
  validateMaskCanvasSize,
  type ImageMaskPoint,
  type ImageMaskRegion,
  type ImageMaskSubmitPayload,
} from './imageMaskGeometry'
import type { MaskInitialClientPoint } from './maskPointPending'

type ImageMaskTool = 'point' | 'box' | 'brush'

type ImageMaskEditOverlayProps = {
  node: MivoCanvasNode
  resolvedAssetUrl: string
  naturalSize: { width: number; height: number }
  viewportScale: number
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
  | { type: 'brush'; points: ImageMaskPoint[] }

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

const toolItems: Array<{ id: ImageMaskTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'point', label: '点选', icon: MousePointer2 },
]

const minimumBoxSizePx = 8
const floatingControlsMargin = 12
const floatingControlsGap = 10
const floatingToolbarHeight = 114
const floatingPromptHeight = 146
const floatingControlsMinWidth = 320
const floatingControlsMaxWidth = 420

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const radiusToNode = (
  center: ImageMaskPoint,
  radius: number,
  displayRect: { x: number; y: number; width: number; height: number },
  naturalSize: { width: number; height: number },
  imageCrop: MivoCanvasNode['imageCrop'],
) => {
  const centerNode = imagePixelToNodePoint(center, displayRect, naturalSize, imageCrop)
  const edgeNode = imagePixelToNodePoint(
    { x: center.x + radius, y: center.y },
    displayRect,
    naturalSize,
    imageCrop,
  )
  return Math.max(4, Math.abs(edgeNode.x - centerNode.x))
}

const regionPath = (
  region: ImageMaskRegion,
  displayRect: { x: number; y: number; width: number; height: number },
  naturalSize: { width: number; height: number },
  imageCrop: MivoCanvasNode['imageCrop'],
) => {
  if (region.type === 'box') {
    const start = imagePixelToNodePoint({ x: region.x, y: region.y }, displayRect, naturalSize, imageCrop)
    const end = imagePixelToNodePoint(
      { x: region.x + region.width, y: region.y + region.height },
      displayRect,
      naturalSize,
      imageCrop,
    )
    return {
      kind: 'rect' as const,
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    }
  }

  if (region.points.length === 1) {
    const center = imagePixelToNodePoint(region.points[0], displayRect, naturalSize, imageCrop)
    return {
      kind: 'point' as const,
      cx: center.x,
      cy: center.y,
      r: radiusToNode(region.points[0], region.radius, displayRect, naturalSize, imageCrop),
    }
  }

  return {
    kind: 'polyline' as const,
    points: region.points.map((point) => imagePixelToNodePoint(point, displayRect, naturalSize, imageCrop)),
    strokeWidth: radiusToNode(region.points[0], region.radius, displayRect, naturalSize, imageCrop) * 2,
  }
}

const pointAnchorPath = (
  anchor: PointAnchor,
  displayRect: { x: number; y: number; width: number; height: number },
  naturalSize: { width: number; height: number },
  imageCrop: MivoCanvasNode['imageCrop'],
) => {
  const center = imagePixelToNodePoint(anchor.center, displayRect, naturalSize, imageCrop)
  return {
    cx: center.x,
    cy: center.y,
    r: radiusToNode(anchor.center, anchor.radius, displayRect, naturalSize, imageCrop),
  }
}

export function ImageMaskEditOverlay({
  node,
  naturalSize,
  viewportScale,
  submitting,
  initialClientPoint,
  onCancel,
  onSubmit,
  onInitialClientPointHandled,
}: ImageMaskEditOverlayProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<ImageMaskTool>('point')
  const [prompt, setPrompt] = useState('')
  const [regions, setRegions] = useState<ImageMaskRegion[]>([])
  const [pointAnchors, setPointAnchors] = useState<PointAnchor[]>([])
  const [past, setPast] = useState<MaskEditSnapshot[]>([])
  const [future, setFuture] = useState<MaskEditSnapshot[]>([])
  const brushSizePx = 48
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
  const promptReady = Boolean(prompt.trim())
  const hasAnyAnchor = regions.length > 0 || pointAnchors.length > 0
  const maskEditHint = !hasAnyAnchor
    ? '先在图片上点选要修改的区域。'
    : !promptReady
      ? '输入修改描述后再提交。'
      : ''

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
    const maxWidth = Math.max(floatingControlsMinWidth, shellRect.width - floatingControlsMargin * 2)
    const width = Math.min(floatingControlsMaxWidth, maxWidth, Math.max(floatingControlsMinWidth, stageRect.width))
    const stageLeft = stageRect.left - shellRect.left
    const stageTop = stageRect.top - shellRect.top
    const stageBottom = stageTop + stageRect.height
    const left = clamp(
      stageLeft + stageRect.width / 2 - width / 2,
      floatingControlsMargin,
      Math.max(floatingControlsMargin, shellRect.width - width - floatingControlsMargin),
    )
    const stackHeight = floatingToolbarHeight + floatingControlsGap + floatingPromptHeight
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
    const promptTop = stackTop + floatingToolbarHeight + floatingControlsGap

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
  }, [node.height, node.width, node.x, node.y, updateFloatingControls, viewportScale])

  useEffect(() => {
    const stage = stageRef.current
    const shell = stage?.closest('.canvas-shell')
    if (!stage || !shell) return undefined

    const frame = window.requestAnimationFrame(updateFloatingControls)
    const resizeObserver = new ResizeObserver(updateFloatingControls)
    resizeObserver.observe(stage)
    resizeObserver.observe(shell)
    window.addEventListener('resize', updateFloatingControls)
    window.addEventListener('scroll', updateFloatingControls, true)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateFloatingControls)
      window.removeEventListener('scroll', updateFloatingControls, true)
    }
  }, [updateFloatingControls])

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

    if (currentDraft.type === 'box') {
      updateDraft({ ...currentDraft, current: pixel })
      return
    }

    const lastPoint = currentDraft.points.at(-1)
    if (lastPoint && Math.hypot(lastPoint.x - pixel.x, lastPoint.y - pixel.y) < Math.max(2, brushSizePx / 6)) {
      return
    }
    updateDraft({ ...currentDraft, points: [...currentDraft.points, pixel] })
  }

  const commitDraftAtPixel = (pixel?: ImageMaskPoint) => {
    const currentDraft = draftRef.current
    if (!currentDraft) return

    const nextRegions = regionsRef.current
    if (currentDraft.type === 'box') {
      const finalCurrent = pixel || currentDraft.current
      const x = Math.min(currentDraft.start.x, finalCurrent.x)
      const y = Math.min(currentDraft.start.y, finalCurrent.y)
      const width = Math.abs(finalCurrent.x - currentDraft.start.x)
      const height = Math.abs(finalCurrent.y - currentDraft.start.y)
      if (width >= minimumBoxSizePx && height >= minimumBoxSizePx) {
        commitRegions([...nextRegions, { type: 'box', x, y, width, height }])
      } else {
        setStatusError('选区太小，请拖出更大的区域。')
      }
    } else {
      const lastPoint = currentDraft.points.at(-1)
      const shouldAppendEndPoint = pixel && lastPoint && Math.hypot(lastPoint.x - pixel.x, lastPoint.y - pixel.y) >= Math.max(2, brushSizePx / 6)
      const points = shouldAppendEndPoint ? [...currentDraft.points, pixel] : currentDraft.points
      if (points.length) {
        commitRegions([...nextRegions, { type: 'brush', points, radius: brushSizePx }])
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
    if (tool === 'box') {
      updateDraft({ type: 'box', start: pixel, current: pixel })
      attachWindowDragListeners()
      return
    }
    updateDraft({ type: 'brush', points: [pixel] })
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

  const clear = () => {
    if (!regionsRef.current.length && !pointAnchorsRef.current.length) return
    commitMaskState([], [])
  }

  const submit = async () => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || !hasAnyAnchor || submitting) return

    try {
      setStatusError('')
      validateMaskCanvasSize(naturalSize)
      const mask = regions.length
        ? await buildEditMaskBlob({ naturalSize, imageCrop: node.imageCrop, regions })
        : undefined
      await onSubmit({
        prompt: trimmedPrompt,
        mask,
        maskBounds: regions.length ? boundsForRegions(regions, naturalSize) : undefined,
        sourceSize: naturalSize,
      })
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : '局部重绘失败。')
    }
  }

  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }

  const renderedRegions = draft
    ? [
        ...regions,
        draft.type === 'box'
          ? {
              type: 'box' as const,
              x: Math.min(draft.start.x, draft.current.x),
              y: Math.min(draft.start.y, draft.current.y),
              width: Math.abs(draft.current.x - draft.start.x),
              height: Math.abs(draft.current.y - draft.start.y),
            }
          : { type: 'brush' as const, points: draft.points, radius: brushSizePx },
      ]
    : regions

  const renderPointMarker = (center: ImageMaskPoint, radiusNode: number, index: string | number) => {
    const scale = Math.max(0.1, viewportScale)
    const armLength = 10 / scale
    const centerRadius = 3.5 / scale
    const strokeWidth = 2 / scale

    return (
      <g key={`point-marker-${index}`} className="image-mask-edit-point-marker">
        <circle
          className="image-mask-edit-point-ring"
          cx={center.x}
          cy={center.y}
          r={radiusNode}
        />
        <line
          className="image-mask-edit-point-crosshair"
          x1={center.x - armLength}
          y1={center.y}
          x2={center.x + armLength}
          y2={center.y}
          strokeWidth={strokeWidth}
        />
        <line
          className="image-mask-edit-point-crosshair"
          x1={center.x}
          y1={center.y - armLength}
          x2={center.x}
          y2={center.y + armLength}
          strokeWidth={strokeWidth}
        />
        <circle
          className="image-mask-edit-point-core"
          cx={center.x}
          cy={center.y}
          r={centerRadius}
        />
      </g>
    )
  }

  const floatingControls =
    floatingLayout && floatingHost ? (
      <div className="image-mask-edit-floating-layer" data-canvas-ui="true">
        <div
          className="image-mask-edit-toolbar"
          data-canvas-ui="true"
          style={{ left: floatingLayout.left, top: floatingLayout.toolbarTop, width: floatingLayout.width }}
          onPointerDown={(event) => event.stopPropagation()}
        >
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
          <div className="image-mask-edit-history">
            <button type="button" onClick={undo} disabled={!past.length || submitting} aria-label="Undo mask region">
              <Undo2 size={14} />
            </button>
            <button type="button" onClick={redo} disabled={!future.length || submitting} aria-label="Redo mask region">
              <Redo2 size={14} />
            </button>
            <button type="button" onClick={clear} disabled={!hasAnyAnchor || submitting} aria-label="Clear mask regions">
              <Trash2 size={14} />
            </button>
            <button type="button" onClick={onCancel} aria-label={submitting ? 'Cancel mask request' : 'Cancel mask edit'}>
              <X size={14} />
            </button>
          </div>
        </div>
        <div
          className="image-mask-edit-prompt"
          data-canvas-ui="true"
          style={{ left: floatingLayout.left, top: floatingLayout.promptTop, width: floatingLayout.width }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <textarea
            value={prompt}
            disabled={submitting}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder="描述这个区域要怎么改..."
          />
          {maskEditHint ? <div className="image-mask-edit-hint">{maskEditHint}</div> : null}
          {statusError ? <div className="image-mask-edit-error">{statusError}</div> : null}
          <button type="button" onClick={() => void submit()} disabled={submitting || !promptReady || !hasAnyAnchor}>
            <Sparkles size={15} />
            {submitting ? '重绘中...' : '局部重绘'}
          </button>
        </div>
      </div>
    ) : null

  return (
    <>
      <div
        className="image-mask-edit-overlay"
        data-canvas-ui="true"
        data-region-count={regions.length + pointAnchors.length}
        data-mask-region-count={regions.length}
        data-point-anchor-count={pointAnchors.length}
        onPointerDown={(event) => event.stopPropagation()}
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
              return renderPointMarker({ x: shape.cx, y: shape.cy }, shape.r, `anchor-${index}`)
            })}
            {renderedRegions.map((region, index) => {
              const shape = regionPath(region, displayRect, naturalSize, node.imageCrop)
              if (shape.kind === 'point') {
                return renderPointMarker({ x: shape.cx, y: shape.cy }, shape.r, index)
              }
              if (shape.kind === 'rect') {
                return (
                  <rect
                    key={index}
                    className="image-mask-edit-region"
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                  />
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
