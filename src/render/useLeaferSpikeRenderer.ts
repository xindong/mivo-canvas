import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Rect, Leafer } from 'leafer-ui'
import '@leafer-in/view'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererMode } from './rendererMode'
import { isLeaferSpikePainted } from './leaferSpikeFilter'
import { useCanvasStore } from '../store/canvasStore'

/**
 * 0b spike — Phase 2b 正式化时按 phase2b-adapter-camera-zorder.md 重构
 * （届时拆 useLeaferHost + useLeaferCameraSync + RendererAdapter + EditOverlayLayer）。
 *
 * 最小 LeaferRenderer：初始化 Leafer（hittable:false，D1 不抢 pointer；canvas-host CSS
 * pointer-events:none 已是双保险）+ 相机单向同步（React viewport → leafer.zoomLayer.set，
 * 禁反向监听）+ paint image/frame/rect（diff add/update/remove）。
 *
 * dom 模式仅保留 Leafer init（空白 canvas，与 PR-1 前行为一致），不 paint、不 sync。
 * leafer 模式当前只画三类；其余节点继续 DOM（见 leaferSpikeFilter）。
 *
 * 交互在 leafer 模式下允许暂时残缺（spike 只测渲染性能；pan/zoom 走 viewport 不依赖节点命中）。
 */

export type ViewportState = { x: number; y: number; scale: number }

type PaintedEntry = { object: Image | Rect; node: MivoCanvasNode }
type LeaferSpikeStats = {
  expectedChildren: number
  children: number
  pixelNonEmpty: boolean
  pixelSampleCount: number
  syncVersion: number
  panCacheEnabled: boolean
  panCacheFrozen: boolean
  panCacheCaptures: number
  panCacheLastDeltaX: number
  panCacheLastDeltaY: number
}

type LeaferSpikeProbeNode = {
  id: string
  type: MivoCanvasNode['type']
  canvasRect: { x: number; y: number; width: number; height: number }
  screenRect: { left: number; top: number; right: number; bottom: number; width: number; height: number }
}

declare global {
  interface Window {
    __MIVO_LEAFER_SPIKE__?: {
      getStats: () => LeaferSpikeStats
      getPaintedNodes: () => LeaferSpikeProbeNode[]
    }
  }
}

const EMPTY_STATS: LeaferSpikeStats = {
  expectedChildren: 0,
  children: 0,
  pixelNonEmpty: false,
  pixelSampleCount: 0,
  syncVersion: 0,
  panCacheEnabled: false,
  panCacheFrozen: false,
  panCacheCaptures: 0,
  panCacheLastDeltaX: 0,
  panCacheLastDeltaY: 0,
}

const parsePanCacheEnabled = () => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false
  const value = new URLSearchParams(window.location.search).get('panCache')
  return value === 'on' || value === 'true' || value === '1'
}

const leaferSpikePaintProps = (node: MivoCanvasNode) => {
  const base = {
    x: node.x,
    y: node.y,
    width: Math.max(1, node.width),
    height: Math.max(1, node.height),
  }
  if (node.type === 'image') {
    return { ...base, url: node.assetUrl ?? '' }
  }
  if (node.type === 'frame') {
    return {
      ...base,
      fill: node.sectionFillColor ?? node.frameColor ?? '#ffffff',
      stroke: node.sectionBorderColor ?? node.frameColor,
      strokeWidth: node.sectionBorderWidth ?? 0,
    }
  }
  // markup-rect
  return {
    ...base,
    fill: node.markupFillColor ?? 'rgba(105,87,232,0.08)',
    stroke: node.markupStrokeColor ?? '#6957e8',
    strokeWidth: node.markupStrokeWidth ?? 0,
  }
}

const createLeaferSpikeObject = (node: MivoCanvasNode): Image | Rect =>
  node.type === 'image' ? new Image(leaferSpikePaintProps(node)) : new Rect(leaferSpikePaintProps(node))

const paintSignatureFor = (node: MivoCanvasNode): string =>
  JSON.stringify({
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    assetUrl: node.assetUrl,
    markupKind: node.markupKind,
    markupFillColor: node.markupFillColor,
    markupStrokeColor: node.markupStrokeColor,
    markupStrokeWidth: node.markupStrokeWidth,
    sectionFillColor: node.sectionFillColor,
    sectionBorderColor: node.sectionBorderColor,
    sectionBorderWidth: node.sectionBorderWidth,
    frameColor: node.frameColor,
  })

const countLeaferChildren = (leafer: Leafer | null): number => {
  const children = leafer?.children
  return Array.isArray(children) ? children.length : 0
}

const sampleNonEmptyCanvasPixels = (host: HTMLDivElement | null) => {
  const canvas = host?.querySelector('canvas')
  if (!canvas) return { nonEmpty: false, sampleCount: 0 }

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || canvas.width < 1 || canvas.height < 1) return { nonEmpty: false, sampleCount: 0 }

  const columns = 48
  const rows = 32
  let sampleCount = 0
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(((column + 0.5) / columns) * canvas.width)))
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(((row + 0.5) / rows) * canvas.height)))
      const data = context.getImageData(x, y, 1, 1).data
      sampleCount += 1
      if (data[3] > 0) return { nonEmpty: true, sampleCount }
    }
  }
  return { nonEmpty: false, sampleCount }
}

const leaferCanvasFor = (host: HTMLDivElement | null): HTMLCanvasElement | null => host?.querySelector('canvas') || null

export const useLeaferSpikeRenderer = ({
  hostRef,
  viewport,
  nodes,
  rendererMode,
  isPanning,
}: {
  hostRef: React.MutableRefObject<HTMLDivElement | null>
  viewport: ViewportState
  nodes: MivoCanvasNode[]
  rendererMode: RendererMode
  isPanning: boolean
}): LeaferSpikeStats => {
  const leaferRef = useRef<Leafer | null>(null)
  const paintedRef = useRef<Map<string, PaintedEntry>>(new Map())
  const signatureRef = useRef<Map<string, string>>(new Map())
  const statsRef = useRef<LeaferSpikeStats>(EMPTY_STATS)
  const panCacheEnabled = useMemo(() => parsePanCacheEnabled(), [])
  const frozenViewportRef = useRef<ViewportState | null>(null)
  const frozenCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const panCacheCapturesRef = useRef(0)
  const panCacheLastDeltaRef = useRef({ x: 0, y: 0 })
  const panCacheEndTimerRef = useRef<number | undefined>(undefined)
  const [leaferReady, setLeaferReady] = useState(false)
  const [stats, setStats] = useState<LeaferSpikeStats>({
    ...EMPTY_STATS,
    panCacheEnabled,
  })
  const [, setStoreNodeVersion] = useState(0)

  const paintedNodes = useMemo(() => nodes.filter(isLeaferSpikePainted), [nodes])
  const paintedNodeSignature = useMemo(
    () => paintedNodes.map((node) => `${node.id}:${paintSignatureFor(node)}`).join('|'),
    [paintedNodes],
  )

  const publishStats = useCallback((next: LeaferSpikeStats) => {
    statsRef.current = next
    setStats((current) =>
      current.expectedChildren === next.expectedChildren &&
      current.children === next.children &&
      current.pixelNonEmpty === next.pixelNonEmpty &&
      current.pixelSampleCount === next.pixelSampleCount &&
      current.syncVersion === next.syncVersion &&
      current.panCacheEnabled === next.panCacheEnabled &&
      current.panCacheFrozen === next.panCacheFrozen &&
      current.panCacheCaptures === next.panCacheCaptures &&
      current.panCacheLastDeltaX === next.panCacheLastDeltaX &&
      current.panCacheLastDeltaY === next.panCacheLastDeltaY
        ? current
        : next,
    )
  }, [])

  const publishPanCacheStats = useCallback((patch: Partial<LeaferSpikeStats>) => {
    publishStats({
      ...statsRef.current,
      panCacheEnabled,
      panCacheCaptures: panCacheCapturesRef.current,
      ...patch,
    })
  }, [panCacheEnabled, publishStats])

  // Bench fixture injection calls replaceSnapshot from outside React. Subscribe to the store so
  // Leafer gets a deterministic sync pass after node content changes, independent of mount timing.
  useEffect(
    () =>
      useCanvasStore.subscribe((state, previousState) => {
        if (state.nodes !== previousState.nodes) setStoreNodeVersion((version) => version + 1)
      }),
    [],
  )

  // Init Leafer (dom + leafer 都 init，保留 dom 空白 canvas 行为；hittable:false D1 双保险).
  // 用 rAF 等 host 有非零尺寸再 init（mount 时 layout 未完成，getBoundingClientRect 可能 0×0，
  // Leafer canvas 会塌成 1px 高，paint 不可见）。
  useEffect(() => {
    if (rendererMode === 'pixi') return
    if (!hostRef.current || leaferRef.current) return

    const host = hostRef.current
    const painted = paintedRef.current
    const signatures = signatureRef.current
    const cacheEnabled = panCacheEnabled
    let raf = 0
    let resizeObserver: ResizeObserver | null = null
    let leafer: Leafer | null = null

    const init = () => {
      if (leaferRef.current) return
      const rect = host.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) {
        raf = requestAnimationFrame(init)
        return
      }
      leafer = new Leafer({
        view: host,
        type: 'design',
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
        fill: 'rgba(246, 243, 235, 0)',
        smooth: true,
        hittable: false,
      })
      leaferRef.current = leafer
      leafer.start()
      setLeaferReady(true)

      resizeObserver = new ResizeObserver(([entry]) => {
        if (!entry || !leaferRef.current) return
        const { width, height } = entry.contentRect
        leaferRef.current.resize({
          width: Math.max(1, Math.floor(width)),
          height: Math.max(1, Math.floor(height)),
          pixelRatio: window.devicePixelRatio,
        })
      })
      resizeObserver.observe(host)
    }
    raf = requestAnimationFrame(init)

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver?.disconnect()
      leafer?.destroy()
      leaferRef.current = null
      setLeaferReady(false)
      painted.clear()
      signatures.clear()
      window.clearTimeout(panCacheEndTimerRef.current)
      if (frozenCanvasRef.current) frozenCanvasRef.current.style.transform = ''
      if (frozenCanvasRef.current) {
        delete frozenCanvasRef.current.dataset.panCacheFrozen
        delete frozenCanvasRef.current.dataset.panCacheFrozenX
        delete frozenCanvasRef.current.dataset.panCacheFrozenY
      }
      frozenCanvasRef.current = null
      frozenViewportRef.current = null
      publishStats({ ...EMPTY_STATS, panCacheEnabled: cacheEnabled })
    }
  }, [hostRef, panCacheEnabled, publishStats, rendererMode])

  // Camera sync (leafer only, 单向 React → zoomLayer.set; D1 禁反向监听 zoomLayer.__).
  useEffect(() => {
    if (!leaferReady || rendererMode !== 'leafer') return
    if (panCacheEnabled && frozenCanvasRef.current) return
    const leafer = leaferRef.current
    if (!leafer) return
    leafer.zoomLayer.set({
      x: viewport.x,
      y: viewport.y,
      scaleX: viewport.scale,
      scaleY: viewport.scale,
    })
  }, [leaferReady, panCacheEnabled, rendererMode, viewport.x, viewport.y, viewport.scale])

  useEffect(() => {
    if (!leaferReady || rendererMode !== 'leafer' || !panCacheEnabled) return

    const host = hostRef.current
    if (isPanning) {
      window.clearTimeout(panCacheEndTimerRef.current)
      if (!frozenCanvasRef.current) {
        frozenCanvasRef.current = leaferCanvasFor(host)
        if (frozenCanvasRef.current) {
          frozenCanvasRef.current.style.transformOrigin = '0 0'
          frozenCanvasRef.current.dataset.panCacheFrozen = 'true'
          frozenCanvasRef.current.dataset.panCacheFrozenX = String(viewport.x)
          frozenCanvasRef.current.dataset.panCacheFrozenY = String(viewport.y)
          frozenViewportRef.current = { ...viewport }
          panCacheCapturesRef.current += 1
          publishPanCacheStats({ panCacheFrozen: true, panCacheLastDeltaX: 0, panCacheLastDeltaY: 0 })
        }
      }
    } else if (frozenCanvasRef.current) {
      window.clearTimeout(panCacheEndTimerRef.current)
      panCacheEndTimerRef.current = window.setTimeout(() => {
        if (frozenCanvasRef.current) {
          frozenCanvasRef.current.style.transform = ''
          delete frozenCanvasRef.current.dataset.panCacheFrozen
          delete frozenCanvasRef.current.dataset.panCacheFrozenX
          delete frozenCanvasRef.current.dataset.panCacheFrozenY
        }
        frozenCanvasRef.current = null
        frozenViewportRef.current = null
        const leafer = leaferRef.current
        if (leafer) {
          leafer.zoomLayer.set({
            x: viewport.x,
            y: viewport.y,
            scaleX: viewport.scale,
            scaleY: viewport.scale,
          })
        }
        publishPanCacheStats({
          panCacheFrozen: false,
          panCacheLastDeltaX: panCacheLastDeltaRef.current.x,
          panCacheLastDeltaY: panCacheLastDeltaRef.current.y,
        })
      }, 150)
    }

    return () => window.clearTimeout(panCacheEndTimerRef.current)
  }, [hostRef, isPanning, leaferReady, panCacheEnabled, publishPanCacheStats, rendererMode, viewport])

  useEffect(() => {
    const snapshot = frozenCanvasRef.current
    const frozenViewport = frozenViewportRef.current
    if (!snapshot || !frozenViewport) return
    const dx = viewport.x - frozenViewport.x
    const dy = viewport.y - frozenViewport.y
    snapshot.style.transform = `translate(${dx}px, ${dy}px)`
    panCacheLastDeltaRef.current = {
      x: Math.round(dx * 1000) / 1000,
      y: Math.round(dy * 1000) / 1000,
    }
  }, [viewport.x, viewport.y])

  // Paint (leafer only, diff add/update/remove).
  useEffect(() => {
    if (!leaferReady) return
    const leafer = leaferRef.current
    if (!leafer) return
    const painted = paintedRef.current
    const signatures = signatureRef.current

    if (rendererMode !== 'leafer') {
      // 切回 dom 时清空 Leafer 画布，避免残留.
      if (painted.size) {
        for (const { object } of painted.values()) object.remove()
        painted.clear()
        signatures.clear()
      }
      queueMicrotask(() => publishStats({ ...EMPTY_STATS, panCacheEnabled }))
      return
    }

    const nextIds = new Set<string>()
    for (const node of paintedNodes) {
      nextIds.add(node.id)
      const signature = paintSignatureFor(node)
      const existing = painted.get(node.id)
      if (existing) {
        if (signatures.get(node.id) !== signature) {
          existing.object.set(leaferSpikePaintProps(node))
          existing.node = node
          signatures.set(node.id, signature)
        }
      } else {
        const object = createLeaferSpikeObject(node)
        leafer.add(object)
        painted.set(node.id, { object, node })
        signatures.set(node.id, signature)
      }
    }

    for (const [id, entry] of painted) {
      if (!nextIds.has(id)) {
        entry.object.remove()
        painted.delete(id)
        signatures.delete(id)
      }
    }

    const syncVersion = statsRef.current.syncVersion + 1
    publishStats({
      ...statsRef.current,
      expectedChildren: paintedNodes.length,
      children: countLeaferChildren(leafer),
      pixelNonEmpty: false,
      pixelSampleCount: 0,
      syncVersion,
      panCacheEnabled,
      panCacheCaptures: panCacheCapturesRef.current,
    })

    let cancelled = false
    let attempts = 0
    const sampleSoon = () => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const sample = sampleNonEmptyCanvasPixels(hostRef.current)
        publishStats({
          ...statsRef.current,
          expectedChildren: paintedNodes.length,
          children: countLeaferChildren(leaferRef.current),
          pixelNonEmpty: sample.nonEmpty,
          pixelSampleCount: sample.sampleCount,
          syncVersion,
          panCacheEnabled,
          panCacheCaptures: panCacheCapturesRef.current,
        })
        attempts += 1
        if (!sample.nonEmpty && attempts < 30) {
          window.setTimeout(sampleSoon, 100)
        }
      })
    }
    requestAnimationFrame(sampleSoon)
    return () => {
      cancelled = true
    }
  }, [hostRef, leaferReady, panCacheEnabled, paintedNodes, paintedNodeSignature, publishStats, rendererMode])

  useEffect(() => {
    window.__MIVO_LEAFER_SPIKE__ = {
      getStats: () => statsRef.current,
      getPaintedNodes: () => {
        const shellRect = hostRef.current?.closest('.canvas-shell')?.getBoundingClientRect()
        return Array.from(paintedRef.current.values()).map(({ node }) => ({
          id: node.id,
          type: node.type,
          canvasRect: { x: node.x, y: node.y, width: node.width, height: node.height },
          screenRect: {
            left: (shellRect?.left || 0) + viewport.x + node.x * viewport.scale,
            top: (shellRect?.top || 0) + viewport.y + node.y * viewport.scale,
            right: (shellRect?.left || 0) + viewport.x + (node.x + node.width) * viewport.scale,
            bottom: (shellRect?.top || 0) + viewport.y + (node.y + node.height) * viewport.scale,
            width: node.width * viewport.scale,
            height: node.height * viewport.scale,
          },
        }))
      },
    }
    return () => {
      window.__MIVO_LEAFER_SPIKE__ = undefined
    }
  }, [hostRef, viewport.scale, viewport.x, viewport.y])

  return stats
}
