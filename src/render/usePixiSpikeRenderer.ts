import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Application, BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { useCanvasStore } from '../store/canvasStore'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import type { RendererMode } from './rendererMode'
import { isPixiSpikePainted } from './leaferSpikeFilter'
import type { ViewportState } from './useLeaferSpikeRenderer'

type PixiModule = typeof import('pixi.js')
type PixiDisplayObject = Sprite | Graphics | BitmapText

type PixiStats = {
  expectedChildren: number
  children: number
  pixelNonEmpty: boolean
  pixelSampleCount: number
  syncVersion: number
  textStrategy: 'bitmap'
  texturePoolSize: number
  fallbackToDom: boolean
}

type PaintedEntry = {
  object: PixiDisplayObject
  node: MivoCanvasNode
  signature: string
}

type PixiRefs = {
  pixi: PixiModule
  app: Application
  stage: Container
  textures: Map<string, Texture>
}

declare global {
  interface Window {
    __MIVO_PIXI_SPIKE__?: {
      getStats: () => PixiStats
    }
  }
}

const SOURCE = 'Pixi Spike'
const FONT_NAME = 'MivoPixiSpikeBitmap'
const TEXT_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,;:!?()[]{}+-=/&%#@"\'_<>|\\\n'

const EMPTY_STATS: PixiStats = {
  expectedChildren: 0,
  children: 0,
  pixelNonEmpty: false,
  pixelSampleCount: 0,
  syncVersion: 0,
  textStrategy: 'bitmap',
  texturePoolSize: 0,
  fallbackToDom: false,
}

const colorToInt = (value: string | undefined, fallback = 0xffffff) => {
  if (!value) return fallback
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    return Number.parseInt(hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex, 16)
  }
  return fallback
}

const paintSignatureFor = (node: MivoCanvasNode): string =>
  JSON.stringify({
    type: node.type,
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
    sectionFillColor: node.sectionFillColor,
    sectionBorderColor: node.sectionBorderColor,
    sectionBorderWidth: node.sectionBorderWidth,
    frameColor: node.frameColor,
  })

const ensureBitmapFont = (pixi: PixiModule) => {
  pixi.BitmapFont.install({
    name: FONT_NAME,
    chars: TEXT_CHARS,
    resolution: 1,
    padding: 4,
    skipKerning: true,
    dynamicFill: true,
    style: {
      fontFamily: 'Arial',
      fontSize: 24,
      fill: 0xffffff,
    },
  })
}

const createFallbackTexture = (pixi: PixiModule, seed: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  if (context) {
    const hue = (seed * 47) % 360
    const gradient = context.createLinearGradient(0, 0, 256, 256)
    gradient.addColorStop(0, `hsl(${hue}, 70%, 56%)`)
    gradient.addColorStop(1, `hsl(${(hue + 64) % 360}, 58%, 34%)`)
    context.fillStyle = gradient
    context.fillRect(0, 0, 256, 256)
  }
  return pixi.Texture.from(canvas)
}

const loadTextures = async (pixi: PixiModule, nodes: MivoCanvasNode[]) => {
  const urls = Array.from(new Set(nodes.filter((node) => node.type === 'image').map((node) => node.assetUrl).filter(Boolean))) as string[]
  const textures = new Map<string, Texture>()
  await Promise.all(
    urls.map(async (url, index) => {
      try {
        textures.set(url, await pixi.Assets.load<Texture>(url))
      } catch {
        textures.set(url, createFallbackTexture(pixi, index))
      }
    }),
  )
  return textures
}

const createObject = (pixi: PixiModule, node: MivoCanvasNode, textures: Map<string, Texture>): PixiDisplayObject => {
  if (node.type === 'image') {
    const sprite = new pixi.Sprite((node.assetUrl && textures.get(node.assetUrl)) || pixi.Texture.WHITE)
    sprite.x = node.x
    sprite.y = node.y
    sprite.width = Math.max(1, node.width)
    sprite.height = Math.max(1, node.height)
    return sprite
  }
  if (node.type === 'text') {
    const text = new pixi.BitmapText({
      text: node.text || '',
      style: {
        fontFamily: FONT_NAME,
        fontSize: node.fontSize || 18,
        fill: colorToInt(node.textColor, 0x2f2f2f),
        align: node.textAlign || 'left',
        wordWrap: true,
        wordWrapWidth: Math.max(1, node.width),
      },
    })
    text.x = node.x
    text.y = node.y
    return text
  }
  const graphic = new pixi.Graphics()
  const fill = node.type === 'frame'
    ? colorToInt(node.sectionFillColor ?? node.frameColor, 0xffffff)
    : colorToInt(node.markupFillColor, 0x6957e8)
  const stroke = node.type === 'frame'
    ? colorToInt(node.sectionBorderColor ?? node.frameColor, 0x999999)
    : colorToInt(node.markupStrokeColor, 0x6957e8)
  const strokeWidth = node.type === 'frame' ? node.sectionBorderWidth ?? 0 : node.markupStrokeWidth ?? 0
  graphic.rect(node.x, node.y, Math.max(1, node.width), Math.max(1, node.height))
    .fill({ color: fill, alpha: node.type === 'frame' ? 0.86 : 0.08 })
  if (strokeWidth > 0) graphic.stroke({ width: strokeWidth, color: stroke, alpha: 0.95 })
  return graphic
}

const updateObject = (entry: PaintedEntry, pixi: PixiModule, node: MivoCanvasNode, textures: Map<string, Texture>) => {
  const next = createObject(pixi, node, textures)
  const parent = entry.object.parent
  if (parent) {
    const index = parent.getChildIndex(entry.object)
    parent.addChildAt(next, index)
    entry.object.destroy({ children: true })
    parent.removeChild(entry.object)
  }
  entry.object = next
  entry.node = node
  entry.signature = paintSignatureFor(node)
}

const countChildren = (stage: Container | null) => stage?.children.length ?? 0

const sampleNonEmptyWebglPixels = (app: Application | null) => {
  const renderer = app?.renderer as { gl?: WebGLRenderingContext | WebGL2RenderingContext; render?: (input: unknown) => void } | undefined
  const canvas = app?.canvas
  const gl = renderer?.gl
  if (!app || !renderer || !canvas || !gl) return { nonEmpty: false, sampleCount: 0 }
  try {
    renderer.render?.(app.stage)
    const width = Math.max(1, Math.min(canvas.width, 1920 * (window.devicePixelRatio || 1)))
    const height = Math.max(1, Math.min(canvas.height, 1080 * (window.devicePixelRatio || 1)))
    const columns = 48
    const rows = 32
    const pixel = new Uint8Array(4)
    let sampleCount = 0
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = Math.min(width - 1, Math.max(0, Math.round(((column + 0.5) / columns) * width)))
        const y = Math.min(height - 1, Math.max(0, Math.round(((row + 0.5) / rows) * height)))
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        sampleCount += 1
        if (pixel[3] > 0 && (pixel[0] > 4 || pixel[1] > 4 || pixel[2] > 4)) return { nonEmpty: true, sampleCount }
      }
    }
    return { nonEmpty: false, sampleCount }
  } catch {
    return { nonEmpty: false, sampleCount: 0 }
  }
}

export const usePixiSpikeRenderer = ({
  hostRef,
  viewport,
  nodes,
  rendererMode,
}: {
  hostRef: React.MutableRefObject<HTMLDivElement | null>
  viewport: ViewportState
  nodes: MivoCanvasNode[]
  rendererMode: RendererMode
}): PixiStats => {
  const refs = useRef<PixiRefs | null>(null)
  const paintedRef = useRef<Map<string, PaintedEntry>>(new Map())
  const statsRef = useRef<PixiStats>(EMPTY_STATS)
  const [ready, setReady] = useState(false)
  const [stats, setStats] = useState<PixiStats>(EMPTY_STATS)
  const [, setStoreNodeVersion] = useState(0)

  const paintedNodes = useMemo(() => nodes.filter(isPixiSpikePainted), [nodes])
  const paintedNodeSignature = useMemo(
    () => paintedNodes.map((node) => `${node.id}:${paintSignatureFor(node)}`).join('|'),
    [paintedNodes],
  )

  const publishStats = useCallback((next: PixiStats) => {
    statsRef.current = next
    setStats((current) =>
      current.expectedChildren === next.expectedChildren &&
      current.children === next.children &&
      current.pixelNonEmpty === next.pixelNonEmpty &&
      current.pixelSampleCount === next.pixelSampleCount &&
      current.syncVersion === next.syncVersion &&
      current.texturePoolSize === next.texturePoolSize &&
      current.fallbackToDom === next.fallbackToDom
        ? current
        : next,
    )
  }, [])

  const failToDom = useCallback((message: string) => {
    const current = refs.current
    refs.current = null
    paintedRef.current.clear()
    if (current) current.app.destroy(true, { children: true, texture: true })
    setReady(false)
    debugLogger.error(SOURCE, message)
    toastFeedback.error('Pixi renderer failed; falling back to DOM.')
    publishStats({ ...EMPTY_STATS, fallbackToDom: true })
  }, [publishStats])

  useEffect(
    () =>
      useCanvasStore.subscribe((state, previousState) => {
        if (state.nodes !== previousState.nodes) setStoreNodeVersion((version) => version + 1)
      }),
    [],
  )

  useEffect(() => {
    if (rendererMode !== 'pixi') return
    const host = hostRef.current
    if (!host || refs.current) return
    const painted = paintedRef.current
    let cancelled = false
    let resizeObserver: ResizeObserver | undefined

    const init = async () => {
      try {
        const pixi = await import('pixi.js')
        if (cancelled) return
        ensureBitmapFont(pixi)
        const rect = host.getBoundingClientRect()
        const app = new pixi.Application()
        await app.init({
          width: Math.max(1, Math.floor(rect.width || host.clientWidth || 1)),
          height: Math.max(1, Math.floor(rect.height || host.clientHeight || 1)),
          backgroundAlpha: 0,
          antialias: false,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
          preference: 'webgl',
          powerPreference: 'high-performance',
        })
        if (cancelled) {
          app.destroy(true, { children: true, texture: true })
          return
        }
        app.canvas.style.position = 'absolute'
        app.canvas.style.inset = '0'
        app.canvas.style.width = '100%'
        app.canvas.style.height = '100%'
        app.canvas.style.pointerEvents = 'none'
        app.stage.eventMode = 'none'
        app.stage.sortableChildren = false
        host.appendChild(app.canvas)
        refs.current = { pixi, app, stage: app.stage, textures: new Map() }
        resizeObserver = new ResizeObserver(([entry]) => {
          if (!entry || !refs.current) return
          refs.current.app.renderer.resize(Math.max(1, Math.floor(entry.contentRect.width)), Math.max(1, Math.floor(entry.contentRect.height)))
        })
        resizeObserver.observe(host)
        setReady(true)
      } catch (error) {
        failToDom(`pixi init/dynamic import failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    void init()
    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      const current = refs.current
      refs.current = null
      painted.clear()
      if (current) {
        current.app.destroy(true, { children: true, texture: true })
      }
      setReady(false)
    }
  }, [failToDom, hostRef, rendererMode])

  useEffect(() => {
    if (!ready || rendererMode !== 'pixi') return
    const current = refs.current
    if (!current) return
    current.stage.position.set(viewport.x, viewport.y)
    current.stage.scale.set(viewport.scale)
  }, [ready, rendererMode, viewport.scale, viewport.x, viewport.y])

  useEffect(() => {
    if (!ready || rendererMode !== 'pixi') {
      if (rendererMode !== 'pixi') queueMicrotask(() => publishStats(EMPTY_STATS))
      return
    }

    let cancelled = false
    const sync = async () => {
      const current = refs.current
      if (!current) return
      current.textures = await loadTextures(current.pixi, paintedNodes)
      if (cancelled) return

      const painted = paintedRef.current
      const nextIds = new Set(paintedNodes.map((node) => node.id))
      for (const [id, entry] of painted) {
        if (!nextIds.has(id)) {
          entry.object.destroy({ children: true })
          painted.delete(id)
        }
      }
      for (const node of paintedNodes) {
        const signature = paintSignatureFor(node)
        const existing = painted.get(node.id)
        if (existing && existing.signature === signature) continue
        if (existing) {
          updateObject(existing, current.pixi, node, current.textures)
        } else {
          const object = createObject(current.pixi, node, current.textures)
          object.eventMode = 'none'
          current.stage.addChild(object)
          painted.set(node.id, { object, node, signature })
        }
      }

      const syncVersion = statsRef.current.syncVersion + 1
      publishStats({
        ...statsRef.current,
        expectedChildren: paintedNodes.length,
        children: countChildren(current.stage),
        pixelNonEmpty: false,
        pixelSampleCount: 0,
        syncVersion,
        textStrategy: 'bitmap',
        texturePoolSize: current.textures.size,
      })

      let attempts = 0
      const sample = () => {
        if (cancelled) return
        const latest = refs.current
        const pixels = sampleNonEmptyWebglPixels(latest?.app ?? null)
        publishStats({
          ...statsRef.current,
          expectedChildren: paintedNodes.length,
          children: countChildren(latest?.stage ?? null),
          pixelNonEmpty: pixels.nonEmpty,
          pixelSampleCount: pixels.sampleCount,
          syncVersion,
          textStrategy: 'bitmap',
          texturePoolSize: latest?.textures.size ?? 0,
        })
        attempts += 1
        if (!pixels.nonEmpty && attempts < 30) window.setTimeout(sample, 50)
      }
      window.requestAnimationFrame(() => window.requestAnimationFrame(sample))
    }

    void sync().catch((error) => failToDom(`pixi reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
    return () => {
      cancelled = true
    }
  }, [failToDom, paintedNodeSignature, paintedNodes, publishStats, ready, rendererMode])

  useEffect(() => {
    window.__MIVO_PIXI_SPIKE__ = {
      getStats: () => statsRef.current,
    }
    return () => {
      delete window.__MIVO_PIXI_SPIKE__
    }
  }, [])

  return stats
}
