import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Rect, Leafer, Text } from 'leafer-ui'
import '@leafer-in/view'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererMode } from './rendererMode'
import { isLeaferLinePaintedNode, isLeaferShapePaintedNode, isLeaferSpikePainted } from './leaferSpikeFilter'
import { useCanvasStore } from '../store/canvasStore'
import { debugLogger } from '../store/debugLogStore'
import { registerEngineSpikeCamera } from './engineSpikeCameraBridge'
import { isEngineLodRequested } from './engineLodMode'
import {
  emptyEngineLodStats,
  engineLodFillFor,
  recordEngineLodSummary,
  shouldUseEngineLod,
  summarizeEngineLod,
  withEngineLodStats,
  type EngineLodStatsCarrier,
} from './engineSpikeLod'
import { createLeaferImagePaint } from './leaferImagePaint'
import { createLeaferLinePaint } from './leaferLinePaint'
import { createLeaferShapePaint, leaferZOrderMapFor } from './leaferShapePaint'

/**
 * 0b spike — Phase 2b 正式化时按 phase2b-adapter-camera-zorder.md 重构
 * （届时拆 useLeaferHost + useLeaferCameraSync + RendererAdapter + EditOverlayLayer）。
 *
 * 最小 LeaferRenderer：初始化 Leafer（hittable:false，D1 不抢 pointer；canvas-host CSS
 * pointer-events:none 已是双保险）+ 相机单向同步（React viewport → leafer.zoomLayer.set，
 * 禁反向监听）+ paint 编排：image → leaferImagePaint（3c），frame/markup shape →
 * leaferShapePaint（4a），markup line/arrow/connector → leaferLinePaint（4b），
 * bench-only LOD text → inline loop（diff add/update/remove）。
 *
 * dom 模式仅保留 Leafer init（空白 canvas，与 PR-1 前行为一致），不 paint、不 sync。
 * leafer 模式画 image/frame/rect/ellipse/note/line/arrow；其余节点继续 DOM
 * （见 leaferSpikeFilter）。
 *
 * 交互在 leafer 模式下允许暂时残缺（spike 只测渲染性能；pan/zoom 走 viewport 不依赖节点命中）。
 */

export type ViewportState = { x: number; y: number; scale: number }

type LeaferDisplayObject = Image | Rect | Text
type LeaferObjectKind = 'image' | 'rect' | 'text'
type PaintedEntry = { object: LeaferDisplayObject; node: MivoCanvasNode; kind: LeaferObjectKind }
type LeaferSpikeStats = EngineLodStatsCarrier & {
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
  ...emptyEngineLodStats(),
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

// Stable empty set for RendererSyncContext.selectedNodeIds — the image paint
// module does not read selection (selection stroke is a DOM overlay concern),
// so a shared empty set avoids allocating one per sync.
const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set()

const parsePanCacheEnabled = () => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false
  const value = new URLSearchParams(window.location.search).get('panCache')
  return value === 'on' || value === 'true' || value === '1'
}

const isLeaferEngineComboPainted = (node: MivoCanvasNode): boolean =>
  isLeaferSpikePainted(node) || (isEngineLodRequested && node.type === 'text')

const leaferObjectKindFor = (node: MivoCanvasNode, viewport: ViewportState): LeaferObjectKind => {
  if (shouldUseEngineLod(node, viewport)) return 'rect'
  if (node.type === 'image') return 'image'
  if (node.type === 'text') return 'text'
  return 'rect'
}

const leaferSpikePaintProps = (node: MivoCanvasNode, viewport: ViewportState) => {
  const base = {
    x: node.x,
    y: node.y,
    width: Math.max(1, node.width),
    height: Math.max(1, node.height),
  }
  if (shouldUseEngineLod(node, viewport)) {
    return { ...base, fill: engineLodFillFor(node), strokeWidth: 0 }
  }
  if (node.type === 'image') {
    return { ...base, url: node.assetUrl ?? '' }
  }
  if (node.type === 'text') {
    return {
      ...base,
      text: node.text || '',
      fill: node.textColor || '#2f2f2f',
      fontSize: node.fontSize || 18,
      fontWeight: node.fontWeight || 400,
      textAlign: node.textAlign || 'left',
    }
  }
  // 4a 之后 inline loop 只会收到 bench-only LOD text（frame/markup shape 走
  // leaferShapePaint，image 走 leaferImagePaint）；这里兜底画占位矩形并 fail
  // visibly，避免路由 drift 时静默画错。
  debugLogger.warn(
    'Leafer Spike',
    `inline loop received unexpected node ${node.id} (type=${node.type}) — paint routing drift, drawing placeholder rect`,
  )
  return { ...base, fill: 'rgba(105,87,232,0.08)', strokeWidth: 0 }
}

const createLeaferSpikeObject = (node: MivoCanvasNode, viewport: ViewportState): PaintedEntry => {
  const kind = leaferObjectKindFor(node, viewport)
  const props = leaferSpikePaintProps(node, viewport)
  const object = kind === 'image' ? new Image(props) : kind === 'text' ? new Text(props) : new Rect(props)
  return { object, node, kind }
}

const setLeaferSpikeObjectProps = (object: LeaferDisplayObject, node: MivoCanvasNode, viewport: ViewportState) => {
  const mutableObject = object as { set: (props: unknown) => void }
  mutableObject.set(leaferSpikePaintProps(node, viewport))
}

const paintSignatureFor = (node: MivoCanvasNode, viewport: ViewportState): string =>
  JSON.stringify({
    type: node.type,
    lod: shouldUseEngineLod(node, viewport),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    assetUrl: node.assetUrl,
    text: node.text,
    fontSize: node.fontSize,
    textColor: node.textColor,
    textAlign: node.textAlign,
    fontWeight: node.fontWeight,
    markupKind: node.markupKind,
    markupFillColor: node.markupFillColor,
    markupStrokeColor: node.markupStrokeColor,
    markupStrokeWidth: node.markupStrokeWidth,
    // 4b line paint inputs: endpoint edits change markupPoints without touching
    // x/y; arrow toggles / dash / opacity / rotation likewise must re-sync.
    markupPoints: node.markupPoints,
    markupStrokeStyle: node.markupStrokeStyle,
    markupOpacity: node.markupOpacity,
    markupStartArrow: node.markupStartArrow,
    markupEndArrow: node.markupEndArrow,
    rotation: node.transform?.rotation,
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
  // Phase 3c: image paint is formalized into leaferImagePaint (lease + crop +
  // diffReconcilePlan). One instance per Leafer; created on init, disposed on
  // teardown so every image lease is released when Leafer is destroyed.
  const imagePaintRef = useRef<ReturnType<typeof createLeaferImagePaint> | null>(null)
  // Phase 4a: frame / markup shape (rect/ellipse/note) paint is formalized into
  // leaferShapePaint (projection sunk defaults + diffReconcilePlan + 2b-2 z-order).
  const shapePaintRef = useRef<ReturnType<typeof createLeaferShapePaint> | null>(null)
  // Phase 4b: markup line/arrow (incl. connector / derivation edge) paint is
  // formalized into leaferLinePaint — consumes normalized markupPoints from the
  // store only (connector geometry stays model-driven, D1).
  const linePaintRef = useRef<ReturnType<typeof createLeaferLinePaint> | null>(null)
  const lodSummaryRef = useRef<string | undefined>(undefined)
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
  const lodViewport = useMemo(() => ({ x: 0, y: 0, scale: viewport.scale }), [viewport.scale])

  const paintedNodes = useMemo(() => nodes.filter(isLeaferEngineComboPainted), [nodes])
  // Phase 3c/4a: image nodes are painted by leaferImagePaint (lease + crop +
  // contract), frame/markup shapes by leaferShapePaint (projection defaults +
  // contract + z-order). The inline loop only handles what neither module owns
  // — in practice text under the bench-only engine-LOD combo mode.
  // paintedNodes (incl. image/shape) still drives expectedChildren + lodStats +
  // the signature dep so the effect re-runs when any painted node changes.
  const inlinePaintedNodes = useMemo(
    () =>
      paintedNodes.filter(
        (node) =>
          node.type !== 'image' && !isLeaferShapePaintedNode(node) && !isLeaferLinePaintedNode(node),
      ),
    [paintedNodes],
  )
  const shapePaintedNodes = useMemo(
    () => paintedNodes.filter(isLeaferShapePaintedNode),
    [paintedNodes],
  )
  const linePaintedNodes = useMemo(
    () => paintedNodes.filter(isLeaferLinePaintedNode),
    [paintedNodes],
  )
  const imagePaintedNodes = useMemo(
    () => paintedNodes.filter((node) => node.type === 'image'),
    [paintedNodes],
  )
  const paintedNodeSignature = useMemo(
    () => paintedNodes.map((node) => `${node.id}:${paintSignatureFor(node, lodViewport)}`).join('|'),
    [lodViewport, paintedNodes],
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
      current.panCacheLastDeltaY === next.panCacheLastDeltaY &&
      current.lodMode === next.lodMode &&
      current.lodEnabled === next.lodEnabled &&
      current.lodThresholdPx === next.lodThresholdPx &&
      current.lodNodeCount === next.lodNodeCount &&
      current.lodImageCount === next.lodImageCount &&
      current.lodTextCount === next.lodTextCount &&
      current.highFidelityNodeCount === next.highFidelityNodeCount
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
      // Bind the image paint module to this Leafer instance. Disposed in the
      // cleanup below so every image lease is released on Leafer teardown.
      imagePaintRef.current = createLeaferImagePaint(leafer)
      // Bind the shape paint module (4a) to the same Leafer instance.
      shapePaintRef.current = createLeaferShapePaint(leafer)
      // Bind the line paint module (4b) to the same Leafer instance.
      linePaintRef.current = createLeaferLinePaint(leafer)

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
      imagePaintRef.current?.dispose()
      imagePaintRef.current = null
      shapePaintRef.current?.dispose()
      shapePaintRef.current = null
      linePaintRef.current?.dispose()
      linePaintRef.current = null
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
    if (!leaferReady || rendererMode !== 'leafer') return undefined
    return registerEngineSpikeCamera((nextViewport) => {
      if (panCacheEnabled && frozenCanvasRef.current) return
      const leafer = leaferRef.current
      if (!leafer) return
      leafer.zoomLayer.set({
        x: nextViewport.x,
        y: nextViewport.y,
        scaleX: nextViewport.scale,
        scaleY: nextViewport.scale,
      })
    })
  }, [leaferReady, panCacheEnabled, rendererMode])

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
      // Release every image lease too (3c): sync([]) deletes all image entries,
      // revoking shared blob URLs so dom mode owns the only outstanding leases.
      const emptyCtx = {
        viewport: lodViewport,
        selectedNodeIds: EMPTY_SELECTED_IDS,
        // isPanning is informational only; the paint modules do not read it.
        // Passing false (not the prop) keeps this effect off the isPanning dep
        // so pan does not re-run paint → no setStats → 0g invariant 1 holds.
        isPanning: false,
      }
      imagePaintRef.current?.sync([], emptyCtx)
      // 4a: clear all shape objects the same way when leaving leafer mode.
      shapePaintRef.current?.sync([], emptyCtx)
      // 4b: clear all line/arrow objects too.
      linePaintRef.current?.sync([], emptyCtx)
      queueMicrotask(() => publishStats({ ...EMPTY_STATS, panCacheEnabled }))
      return
    }

    const lodStats = summarizeEngineLod(paintedNodes, lodViewport)
    recordEngineLodSummary('Leafer Spike', lodStats, lodSummaryRef)
    // 4a (2b-2 z-order): one z-order map over the FULL painted list (shapes +
    // images + inline text), shared by every paint module via ctx.layerOf, so
    // frames stack under content and document order holds across modules —
    // matching the DOM zIndex / hitTest defaultZOrderCompare policy.
    const zOrder = leaferZOrderMapFor(paintedNodes)
    const syncCtx = {
      viewport: lodViewport,
      selectedNodeIds: EMPTY_SELECTED_IDS,
      layerOf: (nodeId: string) => zOrder.get(nodeId),
      // isPanning informational only (modules ignore); passing false (not the
      // prop) keeps this effect off the isPanning dep → 0g invariant 1 holds.
      isPanning: false,
    }
    const nextIds = new Set<string>()
    // Phase 3c/4a: image nodes → leaferImagePaint, frame/markup shapes →
    // leaferShapePaint (both after this loop). The inline loop only handles
    // inlinePaintedNodes (bench-only engine-LOD text).
    for (const node of inlinePaintedNodes) {
      nextIds.add(node.id)
      const signature = paintSignatureFor(node, lodViewport)
      const existing = painted.get(node.id)
      if (existing) {
        if (signatures.get(node.id) !== signature) {
          const nextKind = leaferObjectKindFor(node, lodViewport)
          if (existing.kind === nextKind) {
            setLeaferSpikeObjectProps(existing.object, node, lodViewport)
            existing.node = node
            signatures.set(node.id, signature)
          } else {
            existing.object.remove()
            const nextEntry = createLeaferSpikeObject(node, lodViewport)
            leafer.add(nextEntry.object)
            painted.set(node.id, nextEntry)
            signatures.set(node.id, signature)
          }
        }
      } else {
        const entry = createLeaferSpikeObject(node, lodViewport)
        leafer.add(entry.object)
        painted.set(node.id, entry)
        signatures.set(node.id, signature)
      }
      // z-order also applies to inline objects (outside the signature gate:
      // the doc index can shift without the node's own fields changing).
      const zIndex = zOrder.get(node.id)
      if (zIndex !== undefined) {
        ;(painted.get(node.id)?.object as unknown as { set: (props: unknown) => void } | undefined)?.set({ zIndex })
      }
    }

    for (const [id, entry] of painted) {
      if (!nextIds.has(id)) {
        entry.object.remove()
        painted.delete(id)
        signatures.delete(id)
      }
    }

    // 4a: reconcile frame/markup shapes through the projection-defaults +
    // diffReconcilePlan contract (创建/更新/删除收支 asserted in unit tests).
    shapePaintRef.current?.sync(shapePaintedNodes, syncCtx)

    // 4b: reconcile markup line/arrow (incl. connectors) — consumes the store's
    // normalized markupPoints only; never reads geometry back from Leafer (D1).
    linePaintRef.current?.sync(linePaintedNodes, syncCtx)

    // 3c: reconcile image nodes through the lease + clip + diffReconcilePlan
    // contract. Acquire/release is balanced per sync (created/updated/deleted
    // returned here for accounting; lease balance asserted in unit tests).
    imagePaintRef.current?.sync(imagePaintedNodes, syncCtx)

    const syncVersion = statsRef.current.syncVersion + 1
    publishStats(withEngineLodStats({
      ...statsRef.current,
      expectedChildren: paintedNodes.length,
      children: countLeaferChildren(leafer),
      pixelNonEmpty: false,
      pixelSampleCount: 0,
      syncVersion,
      panCacheEnabled,
      panCacheCaptures: panCacheCapturesRef.current,
    }, lodStats))

    let cancelled = false
    let attempts = 0
    const sampleSoon = () => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const sample = sampleNonEmptyCanvasPixels(hostRef.current)
        publishStats(withEngineLodStats({
          ...statsRef.current,
          expectedChildren: paintedNodes.length,
          children: countLeaferChildren(leaferRef.current),
          pixelNonEmpty: sample.nonEmpty,
          pixelSampleCount: sample.sampleCount,
          syncVersion,
          panCacheEnabled,
          panCacheCaptures: panCacheCapturesRef.current,
        }, lodStats))
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
  }, [hostRef, imagePaintedNodes, inlinePaintedNodes, leaferReady, linePaintedNodes, lodViewport, panCacheEnabled, paintedNodes, paintedNodeSignature, publishStats, rendererMode, shapePaintedNodes])

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
