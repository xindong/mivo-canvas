import { useEffect, useRef, useState } from 'react'
import { Image, Rect, Leafer } from 'leafer-ui'
import '@leafer-in/view'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererMode } from './rendererMode'
import { isLeaferSpikePainted } from './leaferSpikeFilter'

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

export const useLeaferSpikeRenderer = ({
  hostRef,
  viewport,
  nodes,
  rendererMode,
}: {
  hostRef: React.MutableRefObject<HTMLDivElement | null>
  viewport: ViewportState
  nodes: MivoCanvasNode[]
  rendererMode: RendererMode
}) => {
  const leaferRef = useRef<Leafer | null>(null)
  const paintedRef = useRef<Map<string, PaintedEntry>>(new Map())
  const [leaferReady, setLeaferReady] = useState(false)

  // Init Leafer (dom + leafer 都 init，保留 dom 空白 canvas 行为；hittable:false D1 双保险).
  // 用 rAF 等 host 有非零尺寸再 init（mount 时 layout 未完成，getBoundingClientRect 可能 0×0，
  // Leafer canvas 会塌成 1px 高，paint 不可见）。
  useEffect(() => {
    if (!hostRef.current || leaferRef.current) return

    const host = hostRef.current
    const painted = paintedRef.current
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
    }
  }, [hostRef])

  // Camera sync (leafer only, 单向 React → zoomLayer.set; D1 禁反向监听 zoomLayer.__).
  useEffect(() => {
    if (!leaferReady || rendererMode !== 'leafer') return
    const leafer = leaferRef.current
    if (!leafer) return
    leafer.zoomLayer.set({
      x: viewport.x,
      y: viewport.y,
      scaleX: viewport.scale,
      scaleY: viewport.scale,
    })
  }, [leaferReady, rendererMode, viewport.x, viewport.y, viewport.scale])

  // Paint (leafer only, diff add/update/remove).
  useEffect(() => {
    if (!leaferReady) return
    const leafer = leaferRef.current
    if (!leafer) return
    const painted = paintedRef.current

    if (rendererMode !== 'leafer') {
      // 切回 dom 时清空 Leafer 画布，避免残留.
      if (painted.size) {
        for (const { object } of painted.values()) object.remove()
        painted.clear()
      }
      return
    }

    const nextIds = new Set<string>()
    for (const node of nodes) {
      if (!isLeaferSpikePainted(node)) continue
      nextIds.add(node.id)
      const existing = painted.get(node.id)
      if (existing) {
        if (existing.node !== node) {
          existing.object.set(leaferSpikePaintProps(node))
          existing.node = node
        }
      } else {
        const object = createLeaferSpikeObject(node)
        leafer.add(object)
        painted.set(node.id, { object, node })
      }
    }

    for (const [id, entry] of painted) {
      if (!nextIds.has(id)) {
        entry.object.remove()
        painted.delete(id)
      }
    }
  }, [leaferReady, rendererMode, nodes])
}
