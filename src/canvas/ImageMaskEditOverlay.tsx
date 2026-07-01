import { Brush, MousePointer2, Redo2, Sparkles, Square, Trash2, Undo2, X } from 'lucide-react'
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
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  boundsForRegions,
  buildEditMaskBlob,
  displayRectForImage,
  imagePixelToNodePoint,
  nodePointToImagePixel,
  validateMaskCanvasSize,
  type ImageMaskPoint,
  type ImageMaskRegion,
  type ImageMaskSubmitPayload,
} from './imageMaskGeometry'

type ImageMaskTool = 'point' | 'box' | 'brush'

type ImageMaskEditOverlayProps = {
  node: MivoCanvasNode
  resolvedAssetUrl: string
  naturalSize: { width: number; height: number }
  viewportScale: number
  submitting: boolean
  onCancel: () => void
  onSubmit: (payload: ImageMaskSubmitPayload) => Promise<void>
}

type DraftRegion =
  | { type: 'box'; start: ImageMaskPoint; current: ImageMaskPoint }
  | { type: 'brush'; points: ImageMaskPoint[] }

type FloatingControlsLayout = {
  left: number
  width: number
  toolbarTop: number
  promptTop: number
}

const toolItems: Array<{ id: ImageMaskTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'point', label: '点选', icon: MousePointer2 },
  { id: 'box', label: '框选', icon: Square },
  { id: 'brush', label: '涂抹', icon: Brush },
]

const minimumBoxSizePx = 8
const floatingControlsMargin = 12
const floatingControlsGap = 10
const floatingToolbarHeight = 106
const floatingPromptHeight = 138
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
  if (region.type === 'point') {
    const center = imagePixelToNodePoint(region.center, displayRect, naturalSize, imageCrop)
    return {
      kind: 'circle' as const,
      cx: center.x,
      cy: center.y,
      r: radiusToNode(region.center, region.radius, displayRect, naturalSize, imageCrop),
    }
  }

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

  return {
    kind: 'polyline' as const,
    points: region.points.map((point) => imagePixelToNodePoint(point, displayRect, naturalSize, imageCrop)),
    strokeWidth: radiusToNode(region.points[0], region.radius, displayRect, naturalSize, imageCrop) * 2,
  }
}

export function ImageMaskEditOverlay({
  node,
  naturalSize,
  viewportScale,
  submitting,
  onCancel,
  onSubmit,
}: ImageMaskEditOverlayProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<ImageMaskTool>('box')
  const [prompt, setPrompt] = useState('')
  const [regions, setRegions] = useState<ImageMaskRegion[]>([])
  const [past, setPast] = useState<ImageMaskRegion[][]>([])
  const [future, setFuture] = useState<ImageMaskRegion[][]>([])
  const [brushSizePx, setBrushSizePx] = useState(48)
  const [draft, setDraft] = useState<DraftRegion>()
  const [floatingHost, setFloatingHost] = useState<HTMLElement | null>(null)
  const [floatingLayout, setFloatingLayout] = useState<FloatingControlsLayout>()
  const [statusError, setStatusError] = useState('')
  const regionsRef = useRef<ImageMaskRegion[]>([])
  const draftRef = useRef<DraftRegion | undefined>(undefined)
  const removeWindowDragListenersRef = useRef<() => void>(() => undefined)
  const promptReady = Boolean(prompt.trim())
  const maskEditHint = !regions.length
    ? '先在图片上点选、框选或涂抹要修改的区域。'
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
    const toolbarAboveTop = stageTop - floatingToolbarHeight - floatingControlsGap
    const toolbarTop =
      toolbarAboveTop >= floatingControlsMargin
        ? toolbarAboveTop
        : clamp(stageBottom + floatingControlsGap, floatingControlsMargin, shellRect.height - floatingToolbarHeight - floatingControlsMargin)
    const promptBelowTop = stageBottom + floatingControlsGap
    const promptTop =
      promptBelowTop <= shellRect.height - floatingPromptHeight - floatingControlsMargin
        ? promptBelowTop
        : clamp(stageTop - floatingPromptHeight - floatingControlsGap, floatingControlsMargin, shellRect.height - floatingPromptHeight - floatingControlsMargin)

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

  const commitRegions = (nextRegions: ImageMaskRegion[]) => {
    const previousRegions = regionsRef.current
    regionsRef.current = nextRegions
    setPast((current) => [...current, previousRegions])
    setRegions(nextRegions)
    setFuture([])
    setStatusError('')
  }

  useEffect(() => () => removeWindowDragListenersRef.current(), [])

  useLayoutEffect(() => {
    updateFloatingControls()
  }, [node.height, node.width, node.x, node.y, updateFloatingControls, viewportScale])

  useEffect(() => {
    const stage = stageRef.current
    const shell = stage?.closest('.canvas-shell')
    if (!stage || !shell) return undefined

    let frame = window.requestAnimationFrame(updateFloatingControls)
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
    if (submitting) return

    const pixel = pixelForClient(event.clientX, event.clientY)
    if (!pixel) return

    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'point') {
      commitRegions([...regionsRef.current, { type: 'point', center: pixel, radius: brushSizePx }])
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
    setFuture((current) => [regions, ...current])
    regionsRef.current = previous
    setRegions(previous)
    setPast((current) => current.slice(0, -1))
  }

  const redo = () => {
    const next = future[0]
    if (!next) return
    setPast((current) => [...current, regions])
    regionsRef.current = next
    setRegions(next)
    setFuture((current) => current.slice(1))
  }

  const clear = () => {
    if (!regionsRef.current.length) return
    commitRegions([])
  }

  const submit = async () => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || !regions.length || submitting) return

    try {
      setStatusError('')
      validateMaskCanvasSize(naturalSize)
      const mask = await buildEditMaskBlob({ naturalSize, imageCrop: node.imageCrop, regions })
      await onSubmit({
        prompt: trimmedPrompt,
        mask,
        maskBounds: boundsForRegions(regions, naturalSize),
        sourceSize: naturalSize,
      })
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : '局部重绘失败。')
    }
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
          <label className="image-mask-edit-size">
            <span>画笔</span>
            <input
              type="range"
              min="12"
              max="180"
              value={brushSizePx}
              disabled={submitting}
              onChange={(event) => setBrushSizePx(Number(event.target.value))}
            />
            <em>{brushSizePx}px</em>
          </label>
          <div className="image-mask-edit-history">
            <button type="button" onClick={undo} disabled={!past.length || submitting} aria-label="Undo mask region">
              <Undo2 size={14} />
            </button>
            <button type="button" onClick={redo} disabled={!future.length || submitting} aria-label="Redo mask region">
              <Redo2 size={14} />
            </button>
            <button type="button" onClick={clear} disabled={!regions.length || submitting} aria-label="Clear mask regions">
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
            placeholder="描述这个区域要怎么改..."
          />
          {maskEditHint ? <div className="image-mask-edit-hint">{maskEditHint}</div> : null}
          {statusError ? <div className="image-mask-edit-error">{statusError}</div> : null}
          <button type="button" onClick={() => void submit()} disabled={submitting || !promptReady || !regions.length}>
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
        data-region-count={regions.length}
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
            {renderedRegions.map((region, index) => {
              const shape = regionPath(region, displayRect, naturalSize, node.imageCrop)
              if (shape.kind === 'circle') {
                return <circle key={index} className="image-mask-edit-region" cx={shape.cx} cy={shape.cy} r={shape.r} />
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
