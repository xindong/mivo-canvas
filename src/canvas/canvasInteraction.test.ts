import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  canvasBoundsFromZoomMarquee,
  createZoomMarqueeBox,
  createGroupResizeState,
  createNodeResizeState,
  isZoomToBoundsMarqueeRect,
  resizeGroupSelection,
  resizeNodeTransform,
  runtimeToolFor,
  shouldStartCanvasSurfaceInteraction,
  zoomMarqueeOverlayRect,
  hasActiveTextSelection,
} from './canvasInteraction'

const baseNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'node-1',
  type: 'image',
  title: 'Node',
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  status: 'ready',
  ...overrides,
})

describe('resizeNodeTransform', () => {
  it('keeps the opposite corner anchored for a default corner resize', () => {
    const node = baseNode()
    const state = createNodeResizeState(node, 1, 'se', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 40, 0, 1)

    expect(result).toMatchObject({ x: 100, y: 100, width: 240, height: 120 })
  })

  it('keeps the node center anchored for a centered (Alt) corner resize', () => {
    const node = baseNode()
    const state = createNodeResizeState(node, 1, 'se', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 40, 0, 1, { centered: true })

    expect(result).toMatchObject({ x: 60, y: 80, width: 280, height: 140 })
    expect(result.x + result.width / 2).toBe(node.x + node.width / 2)
    expect(result.y + result.height / 2).toBe(node.y + node.height / 2)
    expect(result.guides).toEqual([])
  })

  it('keeps the section center anchored for a centered free resize from any corner', () => {
    const node = baseNode({ type: 'frame', x: 0, y: 0, width: 400, height: 300 })
    const state = createNodeResizeState(node, 1, 'nw', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 20, 10, 1, { centered: true })

    expect(result).toMatchObject({ x: 20, y: 10, width: 360, height: 280 })
    expect(result.x + result.width / 2).toBe(node.x + node.width / 2)
    expect(result.y + result.height / 2).toBe(node.y + node.height / 2)
  })

  it('keeps stamp resize square from a corner and anchors the opposite corner', () => {
    const node = baseNode({ type: 'markup', markupKind: 'stamp', x: 100, y: 100, width: 44, height: 44 })
    const state = createNodeResizeState(node, 1, 'nw', 100, 100)

    const result = resizeNodeTransform(state, node, [node], 70, 90, 1)

    expect(result).toMatchObject({ x: 70, y: 70, width: 74, height: 74 })
    expect(result.x + result.width).toBe(node.x + node.width)
    expect(result.y + result.height).toBe(node.y + node.height)
  })

  it('keeps stamp resize square for centered (Alt) corner resize', () => {
    const node = baseNode({ type: 'markup', markupKind: 'stamp', x: 100, y: 100, width: 44, height: 44 })
    const state = createNodeResizeState(node, 1, 'se', 0, 0)

    const result = resizeNodeTransform(state, node, [node], 20, 10, 1, { centered: true })

    expect(result).toMatchObject({ x: 80, y: 80, width: 84, height: 84 })
    expect(result.x + result.width / 2).toBe(node.x + node.width / 2)
    expect(result.y + result.height / 2).toBe(node.y + node.height / 2)
    expect(result.guides).toEqual([])
  })
})

describe('resizeGroupSelection', () => {
  const nodeA = baseNode({ id: 'node-a', x: 0, y: 0, width: 100, height: 100 })
  const nodeB = baseNode({ id: 'node-b', x: 200, y: 100, width: 100, height: 100 })
  const bounds = { x: 0, y: 0, width: 300, height: 200 }

  it('keeps the dragged-from corner anchored for a default group resize', () => {
    const state = createGroupResizeState(1, 'se', 0, 0, bounds, [nodeA, nodeB])

    const result = resizeGroupSelection(state, 60, 40, 1)

    expect(result.bounds).toEqual({ x: 0, y: 0, width: 360, height: 240 })
    expect(result.updates).toEqual([
      { id: 'node-a', x: 0, y: 0, width: 120, height: 120 },
      { id: 'node-b', x: 240, y: 120, width: 120, height: 120 },
    ])
  })

  it('keeps the selection center anchored for a centered (Alt) group resize', () => {
    const state = createGroupResizeState(1, 'se', 0, 0, bounds, [nodeA, nodeB])

    const result = resizeGroupSelection(state, 60, 40, 1, { centered: true })

    expect(result.bounds).toEqual({ x: -60, y: -40, width: 420, height: 280 })
    expect(result.bounds.x + result.bounds.width / 2).toBe(bounds.x + bounds.width / 2)
    expect(result.bounds.y + result.bounds.height / 2).toBe(bounds.y + bounds.height / 2)
    expect(result.updates).toEqual([
      { id: 'node-a', x: -60, y: -40, width: 140, height: 140 },
      { id: 'node-b', x: 220, y: 100, width: 140, height: 140 },
    ])
  })
})

describe('runtimeToolFor', () => {
  it('uses the temporary zoom tool without making zoom a persisted ToolId', () => {
    expect(runtimeToolFor('select', 'zoom')).toBe('zoom')
  })
})

describe('zoom marquee helpers', () => {
  it('converts a shell/client zoom marquee to canvas bounds', () => {
    const marquee = createZoomMarqueeBox(1, 110, 220, { left: 10, top: 20, width: 800, height: 600 })
    marquee.currentClientX = 310
    marquee.currentClientY = 420

    expect(zoomMarqueeOverlayRect(marquee)).toEqual({ x: 100, y: 200, width: 200, height: 200 })
    expect(canvasBoundsFromZoomMarquee(marquee, { x: 50, y: 100, scale: 2 })).toEqual({
      x: 25,
      y: 50,
      width: 100,
      height: 100,
    })
  })

  it('treats sub-4px zoom marquees as click zooms', () => {
    expect(isZoomToBoundsMarqueeRect({ x: 0, y: 0, width: 3, height: 4 })).toBe(false)
    expect(isZoomToBoundsMarqueeRect({ x: 0, y: 0, width: 4, height: 4 })).toBe(true)
  })
})

// Phase 1b-4 correction: shouldStartCanvasSurfaceInteraction 的 gate 用 instanceof Element
// (HTMLElement + SVGElement 基类),否则 line/arrow 的 .markup-hit-line(SVG <line>)会被
// 拒绝 → dispatchPointerDown 在 resolveCanvasHit 之前 skip → line/arrow 无法选中。
// 钉死防回潮:SVG canvas-surface 通过 + UI 容器内 SVG 被 isCanvasUiTarget 的 closest 兜底拒。
// 项目无 jsdom,用 vi.stubGlobal mock Element + closest(同 imageMaskGeometry.test.ts 风格)。
describe('shouldStartCanvasSurfaceInteraction (1b-4 SVG gate correction)', () => {
  // FakeElement:实例通过 instanceof Element 检查,closest 行为由构造参数决定
  // (模拟 SVG/HTMLElement 在 DOM 树中的位置)。
  class FakeElement {
    private readonly closestImpl: (selector: string) => FakeElement | null
    constructor(closestImpl: (selector: string) => FakeElement | null = () => null) {
      this.closestImpl = closestImpl
    }
    closest(selector: string): FakeElement | null {
      return this.closestImpl(selector)
    }
    // EventTarget stubs:shouldStartCanvasSurfaceInteraction 签名要 EventTarget,
    // 测试不调用这些方法,仅为结构类型兼容(空参方法可赋给多参可选签名的 EventTarget)。
    addEventListener(): void { /* noop */ }
    removeEventListener(): void { /* noop */ }
    dispatchEvent(): boolean { return false }
  }

  let originalElement: unknown
  beforeEach(() => {
    originalElement = (globalThis as { Element?: unknown }).Element
    ;(globalThis as { Element?: unknown }).Element = FakeElement as unknown
  })
  afterEach(() => {
    ;(globalThis as { Element?: unknown }).Element = originalElement
    vi.unstubAllGlobals()
  })

  it('accepts SVG canvas-surface target (markup-hit-line, no UI ancestor) — the 1b-4 bug', () => {
    const line = new FakeElement(() => null) // closest 不命中任何 UI 容器
    expect(shouldStartCanvasSurfaceInteraction(line)).toBe(true)
  })

  it('rejects SVG inside .node-handle via closest fallback', () => {
    const handle = new FakeElement()
    const icon = new FakeElement(() => handle) // closest 命中 UI 容器
    expect(shouldStartCanvasSurfaceInteraction(icon)).toBe(false)
  })

  it('rejects SVG inside .selection-quick-toolbar via closest fallback', () => {
    const toolbar = new FakeElement()
    const icon = new FakeElement(() => toolbar)
    expect(shouldStartCanvasSurfaceInteraction(icon)).toBe(false)
  })

  it('accepts HTMLElement canvas surface (regression)', () => {
    const shell = new FakeElement(() => null) // 无 UI 祖先
    expect(shouldStartCanvasSurfaceInteraction(shell)).toBe(true)
  })

  it('rejects null / non-Element targets', () => {
    expect(shouldStartCanvasSurfaceInteraction(null)).toBe(false)
  })
})


describe('hasActiveTextSelection (cmd+C/X 放行系统复制 guard)', () => {
  it('true for a non-collapsed selection (chat 气泡选中文本 → 放行浏览器复制)', () => {
    expect(hasActiveTextSelection({ isCollapsed: false })).toBe(true)
  })

  it('false for a collapsed selection (无选区 → 画布节点复制照常)', () => {
    expect(hasActiveTextSelection({ isCollapsed: true })).toBe(false)
  })

  it('false for null selection / non-browser environment', () => {
    expect(hasActiveTextSelection(null)).toBe(false)
    expect(hasActiveTextSelection()).toBe(false)
  })
})
