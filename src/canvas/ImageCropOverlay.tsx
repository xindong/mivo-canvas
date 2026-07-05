import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { toContainer, type Viewport } from '../render/EditOverlayLayer'

export type ImageCropBox = {
  x: number
  y: number
  width: number
  height: number
}

type CropDragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

type CropDragState = {
  pointerId: number
  mode: CropDragMode
  startClientX: number
  startClientY: number
  startBox: ImageCropBox
}

type ImageCropOverlayProps = {
  node: MivoCanvasNode
  /** 3b: crop overlay moved to EditOverlayLayer (screen space); viewport drives
   *  toContainer positioning + transform-scale (equivalent to the old dom-canvas-
   *  layer transform, so handle/border 1/scale math is unchanged). */
  viewport: Viewport
  onCommit: (box: ImageCropBox) => void
  onCancel: () => void
}

const minCropSize = 24

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const initialCropBoxFor = (node: MivoCanvasNode): ImageCropBox => {
  const inset = Math.min(node.width, node.height) >= 96 ? Math.round(Math.min(node.width, node.height) * 0.08) : 0

  return {
    x: inset,
    y: inset,
    width: Math.max(minCropSize, node.width - inset * 2),
    height: Math.max(minCropSize, node.height - inset * 2),
  }
}

const moveBox = (node: MivoCanvasNode, startBox: ImageCropBox, dx: number, dy: number): ImageCropBox => ({
  ...startBox,
  x: clamp(startBox.x + dx, 0, Math.max(0, node.width - startBox.width)),
  y: clamp(startBox.y + dy, 0, Math.max(0, node.height - startBox.height)),
})

const resizeBox = (
  node: MivoCanvasNode,
  mode: CropDragMode,
  startBox: ImageCropBox,
  dx: number,
  dy: number,
): ImageCropBox => {
  let left = startBox.x
  let right = startBox.x + startBox.width
  let top = startBox.y
  let bottom = startBox.y + startBox.height

  if (mode.includes('w')) left = clamp(startBox.x + dx, 0, right - minCropSize)
  if (mode.includes('e')) right = clamp(startBox.x + startBox.width + dx, left + minCropSize, node.width)
  if (mode.includes('n')) top = clamp(startBox.y + dy, 0, bottom - minCropSize)
  if (mode.includes('s')) bottom = clamp(startBox.y + startBox.height + dy, top + minCropSize, node.height)

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

export function ImageCropOverlay({ node, viewport, onCommit, onCancel }: ImageCropOverlayProps) {
  const { scale } = viewport
  const [box, setBox] = useState(() => initialCropBoxFor(node))
  const dragRef = useRef<CropDragState | null>(null)
  const handleSize = 12 / scale
  const borderWidth = 2 / scale

  const beginDrag = (mode: CropDragMode, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBox: box,
    }
  }

  const updateDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    event.preventDefault()
    event.stopPropagation()
    const dx = (event.clientX - drag.startClientX) / scale
    const dy = (event.clientY - drag.startClientY) / scale
    setBox(drag.mode === 'move' ? moveBox(node, drag.startBox, dx, dy) : resizeBox(node, drag.mode, drag.startBox, dx, dy))
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return

    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
  }

  return (
    <div
      className="image-crop-overlay"
      data-canvas-ui="true"
      style={{
        left: toContainer(viewport, node.x, node.y).x,
        top: toContainer(viewport, node.x, node.y).y,
        width: node.width,
        height: node.height,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="image-crop-box"
        style={{
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          borderWidth,
        }}
        onPointerDown={(event) => beginDrag('move', event)}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
          <button
            key={corner}
            type="button"
            className={`image-crop-handle ${corner}`}
            aria-label={`Crop ${corner}`}
            style={{
              width: handleSize,
              height: handleSize,
              borderWidth,
            }}
            onPointerDown={(event) => beginDrag(corner, event)}
            onPointerMove={updateDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}
      </div>
      <div
        className="image-crop-actions"
        style={{
          left: box.x + box.width / 2,
          top: Math.min(node.height + 10, box.y + box.height + 10),
          transform: `translateX(-50%) scale(${1 / scale})`,
        }}
      >
        <button type="button" onClick={() => onCommit(box)}>
          Done
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
