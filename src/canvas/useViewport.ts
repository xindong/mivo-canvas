import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { CanvasId, MivoCanvasNode } from '../types/mivoCanvas'
import {
  boundsForNodes,
  clampViewportScale,
  createPanState,
  normalizedWheelDelta,
  viewportForBounds,
  viewportFromPan,
  viewportFromZoom,
  type CanvasBounds,
  type PanState,
  type Viewport,
} from './canvasInteraction'
import { screenToCanvas as screenToCanvasPoint } from '../render/viewportMatrix'

export const defaultViewportFor = (sceneId: string): Viewport => ({
  x: 420,
  y: 240,
  scale: sceneId === 'stress-test' ? 0.62 : 1,
})

const viewportStorageKey = (sceneId: CanvasId) => `mivo-canvas-viewport:${sceneId}`

const persistedViewportFor = (sceneId: CanvasId): Viewport | undefined => {
  try {
    const rawViewport = window.localStorage.getItem(viewportStorageKey(sceneId))
    if (!rawViewport) return undefined

    const viewport = JSON.parse(rawViewport) as Partial<Viewport>
    if (
      typeof viewport.x !== 'number' ||
      typeof viewport.y !== 'number' ||
      typeof viewport.scale !== 'number'
    ) {
      return undefined
    }

    return {
      x: viewport.x,
      y: viewport.y,
      scale: clampViewportScale(viewport.scale),
    }
  } catch {
    return undefined
  }
}

const initialViewportFor = (sceneId: CanvasId) => persistedViewportFor(sceneId) || defaultViewportFor(sceneId)

const panCacheEnabledFromUrl = () => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false
  const value = new URLSearchParams(window.location.search).get('panCache')
  return value === 'on' || value === 'true' || value === '1'
}

const applyViewportImperatively = (shell: HTMLElement | null, viewport: Viewport) => {
  if (!shell) return
  shell.dataset.viewportScale = String(viewport.scale)
  shell.dataset.viewportX = String(viewport.x)
  shell.dataset.viewportY = String(viewport.y)
  shell.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`
  shell.style.backgroundSize = `${36 * viewport.scale}px ${36 * viewport.scale}px`
  const domLayer = shell.querySelector<HTMLElement>('.dom-canvas-layer')
  if (domLayer) domLayer.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`
  const leaferCanvas = shell.querySelector<HTMLCanvasElement>('.canvas-host canvas')
  const frozenX = Number(leaferCanvas?.dataset.panCacheFrozenX ?? viewport.x)
  const frozenY = Number(leaferCanvas?.dataset.panCacheFrozenY ?? viewport.y)
  if (leaferCanvas?.dataset.panCacheFrozen === 'true') {
    leaferCanvas.style.transform = `translate3d(${viewport.x - frozenX}px, ${viewport.y - frozenY}px, 0)`
  }
}

type UseViewportOptions = {
  shellRef: RefObject<HTMLElement | null>
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  selectedNodes: MivoCanvasNode[]
  onCloseContextMenu: () => void
}

// Viewport state + pan + persistence + zoom/fit callbacks + wheel handling.
// Extracted from useCanvasInteractionController (F7 viewport gap). Pure
// extraction: behavior identical to the inline controller logic.
export function useViewport({ shellRef, sceneId, nodes, selectedNodes, onCloseContextMenu }: UseViewportOptions) {
  const viewportRef = useRef<Viewport>(initialViewportFor(sceneId))
  const panRef = useRef<PanState | null>(null)
  const panCacheEnabled = useMemo(() => panCacheEnabledFromUrl(), [])
  const persistedSceneRef = useRef(sceneId)
  const viewportPersistenceTimerRef = useRef<number | undefined>(undefined)
  const [viewport, setViewport] = useState<Viewport>(() => initialViewportFor(sceneId))
  const [isPanning, setIsPanning] = useState(false)

  useEffect(() => {
    viewportRef.current = viewport
    const shell = shellRef.current
    if (shell && (shell.scrollLeft !== 0 || shell.scrollTop !== 0)) {
      shell.scrollLeft = 0
      shell.scrollTop = 0
    }
  }, [shellRef, viewport])

  useEffect(() => {
    if (persistedSceneRef.current !== sceneId) return

    window.clearTimeout(viewportPersistenceTimerRef.current)
    viewportPersistenceTimerRef.current = window.setTimeout(() => {
      window.localStorage.setItem(viewportStorageKey(sceneId), JSON.stringify(viewport))
      viewportPersistenceTimerRef.current = undefined
    }, 180)

    return () => window.clearTimeout(viewportPersistenceTimerRef.current)
  }, [sceneId, viewport])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return undefined

    const preventNativeWheelDefault = (event: WheelEvent) => {
      event.preventDefault()
    }

    shell.addEventListener('wheel', preventNativeWheelDefault, { passive: false })

    return () => {
      shell.removeEventListener('wheel', preventNativeWheelDefault)
    }
  }, [shellRef])

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number, sourceViewport: Viewport = viewportRef.current) => {
      const rect = shellRef.current?.getBoundingClientRect()
      return screenToCanvasPoint(rect, sourceViewport, clientX, clientY)
    },
    [shellRef],
  )

  const viewportCenter = useCallback(() => {
    const rect = shellRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return screenToCanvasPoint(rect, viewportRef.current, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [shellRef])

  const zoomTo = useCallback(
    (nextScale: number, center?: { clientX: number; clientY: number }) => {
      setViewport((current) => {
        const rect = shellRef.current?.getBoundingClientRect()
        return viewportFromZoom(current, rect, nextScale, center)
      })
    },
    [shellRef],
  )

  const zoomBy = useCallback(
    (factor: number, center?: { clientX: number; clientY: number }) => {
      zoomTo(viewportRef.current.scale * factor, center)
    },
    [zoomTo],
  )

  const fitToBounds = useCallback(
    (bounds: CanvasBounds | undefined, options?: { padding?: number; minPadding?: number }) => {
      const rect = shellRef.current?.getBoundingClientRect()
      const nextViewport = bounds ? viewportForBounds(bounds, rect, options) : undefined

      setViewport(nextViewport || defaultViewportFor(sceneId))
    },
    [sceneId, shellRef],
  )

  const fitAll = useCallback(() => {
    fitToBounds(boundsForNodes(nodes.filter((node) => !node.hidden)))
  }, [fitToBounds, nodes])

  const fitSelection = useCallback(() => {
    const visibleNodes = nodes.filter((node) => !node.hidden)
    fitToBounds(boundsForNodes(selectedNodes.length ? selectedNodes : visibleNodes))
  }, [fitToBounds, nodes, selectedNodes])

  const fit = fitSelection

  const resetView = useCallback(() => {
    setViewport(defaultViewportFor(sceneId))
  }, [sceneId])

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      onCloseContextMenu()

      const delta = normalizedWheelDelta(event.nativeEvent)
      if (event.ctrlKey || event.metaKey) {
        zoomBy(Math.exp(-delta.y * 0.002), { clientX: event.clientX, clientY: event.clientY })
        return
      }

      const deltaX = event.shiftKey && delta.x === 0 ? delta.y : delta.x
      const deltaY = event.shiftKey && delta.x === 0 ? 0 : delta.y
      setViewport((current) => ({
        ...current,
        x: current.x - deltaX,
        y: current.y - deltaY,
      }))
    },
    [onCloseContextMenu, zoomBy],
  )

  // Low-level pan-state setup. The controller's beginPan orchestrates the full
  // sequence (pointer capture + cross-cutting cleanup + clearSelection + startPan).
  const startPan = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      setIsPanning(true)
      panRef.current = createPanState(event.pointerId, event.clientX, event.clientY, viewportRef.current)
    },
    [],
  )

  // Dispatcher (handleCanvasPointerMove) pan branch.
  const tryMovePan = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const pan = panRef.current
      if (pan?.pointerId !== event.pointerId) return false
      if (panCacheEnabled) {
        const nextViewport = viewportFromPan(pan, event.clientX, event.clientY, viewportRef.current)
        viewportRef.current = nextViewport
        applyViewportImperatively(shellRef.current, nextViewport)
        return true
      }
      setViewport((current) => viewportFromPan(pan, event.clientX, event.clientY, current))
      return true
    },
    [panCacheEnabled, shellRef],
  )

  // Dispatcher (handleCanvasPointerEnd) pan branch.
  const tryEndPan = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null
      if (panCacheEnabled) setViewport(viewportRef.current)
      setIsPanning(false)
    }
  }, [panCacheEnabled])

  // Window blur reset (unconditional).
  const resetPan = useCallback(() => {
    panRef.current = null
    if (panCacheEnabled) setViewport(viewportRef.current)
    setIsPanning(false)
  }, [panCacheEnabled])

  // Scene reset (called from the controller's cross-cutting scene-reset rAF).
  const resetViewportForScene = useCallback((nextSceneId: CanvasId) => {
    persistedSceneRef.current = nextSceneId
    setViewport(initialViewportFor(nextSceneId))
    setIsPanning(false)
    panRef.current = null
  }, [])

  return {
    viewport,
    viewportRef,
    isPanning,
    screenToCanvas,
    viewportCenter,
    zoomTo,
    zoomBy,
    fitToBounds,
    fitAll,
    fitSelection,
    fit,
    resetView,
    handleWheel,
    startPan,
    tryMovePan,
    tryEndPan,
    resetPan,
    resetViewportForScene,
  }
}
