import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { logCanvas } from '../store/canvasStore'
import {
  canvasBoundsFromZoomMarquee,
  createZoomMarqueeBox,
  isVisibleZoomMarqueeRect,
  isZoomToBoundsMarqueeRect,
  zoomMarqueeOverlayRect,
  type CanvasBounds,
  type Viewport,
  type ZoomMarqueeBox,
} from './canvasInteraction'

type ZoomPointerEvent = ReactPointerEvent<HTMLElement>

type UseZoomToolOptions = {
  shellRef: RefObject<HTMLElement | null>
  viewportRef: RefObject<Viewport>
  startInteraction: () => void
  zoomBy: (factor: number, center?: { clientX: number; clientY: number }) => void
  fitToBounds: (bounds: CanvasBounds | undefined, options?: { padding?: number; minPadding?: number }) => void
  zoomOutCursor: boolean
}

const applyOverlayRect = (element: HTMLDivElement, rect: CanvasBounds) => {
  element.style.left = `${rect.x}px`
  element.style.top = `${rect.y}px`
  element.style.width = `${rect.width}px`
  element.style.height = `${rect.height}px`
}

export function useZoomTool({
  shellRef,
  viewportRef,
  startInteraction,
  zoomBy,
  fitToBounds,
  zoomOutCursor,
}: UseZoomToolOptions) {
  const zoomMarqueeRef = useRef<ZoomMarqueeBox | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  const removeOverlay = useCallback(() => {
    overlayRef.current?.remove()
    overlayRef.current = null
  }, [])

  const renderOverlay = useCallback(
    (rect: CanvasBounds | undefined) => {
      const shell = shellRef.current
      if (!shell || !rect || !isVisibleZoomMarqueeRect(rect)) {
        removeOverlay()
        return
      }

      let overlay = overlayRef.current
      if (!overlay) {
        const nextOverlay = document.createElement('div')
        nextOverlay.className = 'zoom-marquee'
        shell.appendChild(nextOverlay)
        overlayRef.current = nextOverlay
        overlay = nextOverlay
      }
      applyOverlayRect(overlay, rect)
    },
    [removeOverlay, shellRef],
  )

  const resetZoomGesture = useCallback(() => {
    zoomMarqueeRef.current = null
    removeOverlay()
  }, [removeOverlay])

  useEffect(() => resetZoomGesture, [resetZoomGesture])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return undefined

    shell.classList.toggle('zoom-out-cursor', zoomOutCursor)
    shell.style.cursor = zoomOutCursor ? 'zoom-out' : ''

    return () => {
      shell.classList.remove('zoom-out-cursor')
      shell.style.cursor = ''
    }
  })

  const beginZoomGesture = useCallback(
    (event: ZoomPointerEvent) => {
      if (event.button !== 0) return

      const shellRect = shellRef.current?.getBoundingClientRect()
      if (!shellRect) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      startInteraction()

      zoomMarqueeRef.current = createZoomMarqueeBox(event.pointerId, event.clientX, event.clientY, shellRect)
      renderOverlay(undefined)
    },
    [renderOverlay, shellRef, startInteraction],
  )

  const tryMoveZoomGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const marquee = zoomMarqueeRef.current
      if (marquee?.pointerId !== event.pointerId) return false

      marquee.currentClientX = event.clientX
      marquee.currentClientY = event.clientY
      renderOverlay(zoomMarqueeOverlayRect(marquee))
      return true
    },
    [renderOverlay],
  )

  const tryEndZoomGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const marquee = zoomMarqueeRef.current
      if (marquee?.pointerId !== event.pointerId) return

      marquee.currentClientX = event.clientX
      marquee.currentClientY = event.clientY
      const overlayRect = zoomMarqueeOverlayRect(marquee)
      zoomMarqueeRef.current = null
      removeOverlay()

      if (event.type !== 'pointerup') return

      if (isZoomToBoundsMarqueeRect(overlayRect)) {
        const bounds = canvasBoundsFromZoomMarquee(marquee, viewportRef.current)
        fitToBounds(bounds, { padding: 0, minPadding: 0 })
        logCanvas(
          `Zoom to region ${Math.round(bounds.width)}x${Math.round(bounds.height)} at ${Math.round(bounds.x)},${Math.round(bounds.y)}`,
        )
        return
      }

      zoomBy(event.altKey ? 0.5 : 2, { clientX: event.clientX, clientY: event.clientY })
    },
    [fitToBounds, removeOverlay, viewportRef, zoomBy],
  )

  return {
    beginZoomGesture,
    tryMoveZoomGesture,
    tryEndZoomGesture,
    resetZoomGesture,
  }
}
