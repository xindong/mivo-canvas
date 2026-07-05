import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 'leafer-ui' with lightweight fake display objects so the paint module can
// be exercised without a real canvas. The fakes record props (for DOM-parity
// assertions), and no-op remove().
vi.mock('leafer-ui', () => {
  class FakeUI {
    props: Record<string, unknown>
    removed = false
    constructor(props: Record<string, unknown> = {}) {
      this.props = { ...props }
    }
    set(props: Record<string, unknown>) {
      this.props = { ...this.props, ...props }
    }
    remove() {
      this.removed = true
    }
  }
  class FakeRect extends FakeUI {}
  class FakeEllipse extends FakeUI {}
  class FakeImage extends FakeUI {}
  class FakeGroup extends FakeUI {
    children: FakeUI[] = []
    add(child: FakeUI) {
      this.children.push(child)
    }
  }
  return { Rect: FakeRect, Ellipse: FakeEllipse, Image: FakeImage, Group: FakeGroup }
})

// Importing AFTER vi.mock (hoisted) so the module sees the mocked deps.
// projection is REAL on purpose: the DOM-parity tests below lock the mapping
// from the Phase 1a sunk visual defaults, not from re-declared constants.
import {
  createLeaferShapePaint,
  dashPatternFor,
  leaferZOrderMapFor,
  LEAFER_Z_LAYER_STEP,
  shapeLayerFor,
  shapePaintPropsFor,
  SOURCE,
} from './leaferShapePaint'
import type { LeaferShapePaint } from './leaferShapePaint'
import { isLeaferShapePaintedNode } from './leaferSpikeFilter'
import { projectNode } from './projection'
import { Layer } from './layers'
import { debugLogger } from '../store/debugLogStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'
import type { Leafer } from 'leafer-ui'
import moduleSource from './leaferShapePaint.ts?raw'

type FakeUI = { props: Record<string, unknown>; removed: boolean; set: (p: Record<string, unknown>) => void; remove: () => void }

const makeFakeLeafer = () => {
  const children: FakeUI[] = []
  return {
    add: (child: FakeUI) => children.push(child),
    children,
  } as unknown as Leafer & { children: FakeUI[] }
}

const ctx = (layerOf?: (nodeId: string) => number | undefined): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale: 1 },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
  ...(layerOf ? { layerOf } : {}),
})

const frameNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'f1',
    type: 'frame',
    status: 'ready',
    x: 10,
    y: 20,
    width: 400,
    height: 300,
    ...opts,
  }) as unknown as MivoCanvasNode

const markupNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'm1',
    type: 'markup',
    status: 'ready',
    markupKind: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    ...opts,
  }) as unknown as MivoCanvasNode

describe('dashPatternFor — SVG strokeDasharray formula parity (CanvasNodeView:294)', () => {
  it('mirrors `${w * 2.2} ${w * 1.6}`', () => {
    expect(dashPatternFor(2)).toEqual([4.4, 3.2])
    expect(dashPatternFor(3)).toEqual([2.2 * 3, 1.6 * 3])
  })
})

describe('shapeLayerFor / leaferZOrderMapFor — 2b-2 z-order', () => {
  it('frame → Layer.Frame (bottom band), markup shapes → Layer.Content', () => {
    expect(shapeLayerFor(frameNode())).toBe(Layer.Frame)
    expect(shapeLayerFor(markupNode())).toBe(Layer.Content)
  })

  it('encodes layer band × document order: every frame stacks under every content node; doc order breaks ties', () => {
    const nodes = [
      markupNode({ id: 'm-early' }),
      frameNode({ id: 'f-late' }),
      markupNode({ id: 'm-late', markupKind: 'ellipse' }),
    ]
    const map = leaferZOrderMapFor(nodes)
    // frame is later in doc order but still below both markups (layer band wins)
    expect(map.get('f-late')!).toBeLessThan(map.get('m-early')!)
    // within Content, doc order holds
    expect(map.get('m-early')!).toBeLessThan(map.get('m-late')!)
    // band arithmetic: frame band starts at Layer.Frame * STEP
    expect(map.get('f-late')).toBe(Layer.Frame * LEAFER_Z_LAYER_STEP + 1)
  })
})

describe('shapePaintPropsFor — DOM 视觉等价（消费 projection 下沉缺省）', () => {
  it('frame 缺省：fill #ffffff + dashed #ff8a00 2px 内描边（frameRenderStyleFor / sinkVisualDefaults 同源）', () => {
    const props = shapePaintPropsFor(projectNode(frameNode()), 'frame', undefined)
    expect(props.fill).toBe('#ffffff')
    expect(props.stroke).toBe('#ff8a00')
    expect(props.strokeWidth).toBe(2)
    expect(props.strokeAlign).toBe('inside')
    // CSS dashed border → SVG dash formula（仓内唯一 dash 约定）
    expect(props.dashPattern).toEqual([4.4, 3.2])
    expect(props.x).toBe(10)
    expect(props.y).toBe(20)
    expect(props.width).toBe(400)
    expect(props.height).toBe(300)
  })

  it('frame 显式 section 字段：solid 边框时 dashPattern 显式清空（undefined）', () => {
    const node = frameNode({
      sectionFillColor: '#123456',
      sectionBorderColor: '#654321',
      sectionBorderWidth: 3,
      sectionBorderStyle: 'solid',
    })
    const props = shapePaintPropsFor(projectNode(node), 'frame', undefined)
    expect(props.fill).toBe('#123456')
    expect(props.stroke).toBe('#654321')
    expect(props.strokeWidth).toBe(3)
    expect(props.dashPattern).toBeUndefined()
    expect('dashPattern' in props).toBe(true) // 更新路径显式清除旧 dash
  })

  it('markup rect 缺省：fill rgba(105,87,232,0.08) + #6957e8 3px solid + cornerRadius 4（markupRenderStyleFor 同源）', () => {
    const props = shapePaintPropsFor(projectNode(markupNode()), 'markup-rect', undefined)
    expect(props.fill).toBe('rgba(105, 87, 232, 0.08)')
    expect(props.stroke).toBe('#6957e8')
    expect(props.strokeWidth).toBe(3)
    expect(props.strokeAlign).toBe('inside')
    expect(props.cornerRadius).toBe(4)
    expect(props.dashPattern).toBeUndefined()
  })

  it('markup rect：markupCornerRadius / dashed / 显式颜色全部透传', () => {
    const node = markupNode({
      markupFillColor: '#ffeecc',
      markupStrokeColor: '#112233',
      markupStrokeWidth: 5,
      markupStrokeStyle: 'dashed',
      markupCornerRadius: 12,
    })
    const props = shapePaintPropsFor(projectNode(node), 'markup-rect', undefined)
    expect(props.fill).toBe('#ffeecc')
    expect(props.stroke).toBe('#112233')
    expect(props.strokeWidth).toBe(5)
    expect(props.cornerRadius).toBe(12)
    expect(props.dashPattern).toEqual([11, 8])
  })

  it('markupOpacity < 1 → stroke 变 solid paint 对象携带 opacity（strokeOpacity 只作用于描边，fill 不受影响 — DOM parity）', () => {
    const node = markupNode({ markupOpacity: 0.5 })
    const props = shapePaintPropsFor(projectNode(node), 'markup-rect', undefined)
    expect(props.stroke).toEqual({ type: 'solid', color: '#6957e8', opacity: 0.5 })
    expect(props.fill).toBe('rgba(105, 87, 232, 0.08)')
  })

  it('V2 显式 fills/strokes（可见 solid fill + 可见 stroke）优先于 markup* 字段', () => {
    const node = markupNode({
      fills: [{ id: 'f', kind: 'solid', color: '#0000ff', opacity: 1, visible: true }],
      strokes: [{ id: 's', color: '#111111', width: 5, style: 'dashed', opacity: 1, visible: true }],
    } as Partial<MivoCanvasNode>)
    const props = shapePaintPropsFor(projectNode(node), 'markup-rect', undefined)
    expect(props.fill).toBe('#0000ff')
    expect(props.stroke).toBe('#111111')
    expect(props.strokeWidth).toBe(5)
    expect(props.dashPattern).toEqual([11, 8])
  })

  it('note：.dom-markup-note parity — transparent fill → #fff1a8、固定 2px solid + cornerRadius 6 + 阴影', () => {
    const node = markupNode({ markupKind: 'note', markupFillColor: 'transparent' })
    const props = shapePaintPropsFor(projectNode(node), 'markup-note', undefined)
    expect(props.fill).toBe('#fff1a8')
    expect(props.stroke).toBe('#6957e8')
    expect(props.strokeWidth).toBe(2) // note 无视 markupStrokeWidth，CSS 固定 2px
    expect(props.cornerRadius).toBe(6)
    expect(props.shadow).toEqual({ x: 0, y: 12, blur: 30, color: 'rgba(35, 35, 35, 0.14)' })
    expect(props.dashPattern).toBeUndefined()
  })

  it('note：显式 fill 颜色直接使用', () => {
    const node = markupNode({ markupKind: 'note', markupFillColor: '#ffd6e7', markupStrokeWidth: 9 })
    const props = shapePaintPropsFor(projectNode(node), 'markup-note', undefined)
    expect(props.fill).toBe('#ffd6e7')
    expect(props.strokeWidth).toBe(2) // 仍是固定 2px
  })

  it('zIndex 透传进 props（2b-2 z-order）', () => {
    const props = shapePaintPropsFor(projectNode(frameNode()), 'frame', 42)
    expect(props.zIndex).toBe(42)
  })
})

describe('createLeaferShapePaint — diffReconcilePlan 收支 (no leak, no resurrect)', () => {
  let leafer: ReturnType<typeof makeFakeLeafer>
  let paint: LeaferShapePaint

  beforeEach(() => {
    leafer = makeFakeLeafer()
    paint = createLeaferShapePaint(leafer)
  })

  it('create/update/delete counts match the id diff', () => {
    const c1 = paint.sync([frameNode({ id: 'a' }), markupNode({ id: 'b' })], ctx())
    expect(c1).toEqual({ created: 2, updated: 0, deleted: 0 })
    expect(paint.paintedCount()).toBe(2)

    const c2 = paint.sync([markupNode({ id: 'b' }), markupNode({ id: 'c', markupKind: 'ellipse' })], ctx())
    expect(c2).toEqual({ created: 1, updated: 1, deleted: 1 })
    expect(paint.paintedCount()).toBe(2)

    const c3 = paint.sync([], ctx())
    expect(c3).toEqual({ created: 0, updated: 0, deleted: 2 })
    expect(paint.paintedCount()).toBe(0)
  })

  it('markupKind 变更（rect → ellipse）触发 kind swap：旧对象移除、新对象类型正确', async () => {
    const { Rect, Ellipse } = (await import('leafer-ui')) as unknown as {
      Rect: new () => FakeUI
      Ellipse: new () => FakeUI
    }
    paint.sync([markupNode({ id: 'a', markupKind: 'rect' })], ctx())
    const before = leafer.children[0]
    expect(before).toBeInstanceOf(Rect)

    const counts = paint.sync([markupNode({ id: 'a', markupKind: 'ellipse' })], ctx())
    expect(counts).toEqual({ created: 0, updated: 1, deleted: 0 })
    expect(before.removed).toBe(true)
    expect(leafer.children[1]).toBeInstanceOf(Ellipse)
  })

  it('ellipse 不携带 cornerRadius（DOM <ellipse> 无圆角概念）', () => {
    paint.sync([markupNode({ id: 'a', markupKind: 'ellipse', markupCornerRadius: 12 })], ctx())
    expect(leafer.children[0].props.cornerRadius).toBeUndefined()
  })

  it('update 路径复用同一 props 构建：dashed → solid 回退时 dashPattern 被显式清除', () => {
    paint.sync([markupNode({ id: 'a', markupStrokeStyle: 'dashed' })], ctx())
    expect(leafer.children[0].props.dashPattern).toEqual([2.2 * 3, 1.6 * 3])

    paint.sync([markupNode({ id: 'a', markupStrokeStyle: 'solid' })], ctx())
    expect(leafer.children[0].props.dashPattern).toBeUndefined()
  })

  it('ctx.layerOf 提供 zIndex：frame 带 Frame 段、markup 带 Content 段，update 跟随 doc index 变化', () => {
    const nodes = [frameNode({ id: 'f' }), markupNode({ id: 'm' })]
    const map1 = leaferZOrderMapFor(nodes)
    paint.sync(nodes, ctx((id) => map1.get(id)))
    const [frameObj, markupObj] = leafer.children
    expect(frameObj.props.zIndex).toBe(Layer.Frame * LEAFER_Z_LAYER_STEP + 0)
    expect(markupObj.props.zIndex).toBe(Layer.Content * LEAFER_Z_LAYER_STEP + 1)

    // 文档顺序变化（markup 前移）→ update 路径刷新 zIndex
    const reordered = [markupNode({ id: 'm' }), frameNode({ id: 'f' })]
    const map2 = leaferZOrderMapFor(reordered)
    paint.sync(reordered, ctx((id) => map2.get(id)))
    expect(markupObj.props.zIndex).toBe(Layer.Content * LEAFER_Z_LAYER_STEP + 0)
    expect(frameObj.props.zIndex).toBe(Layer.Frame * LEAFER_Z_LAYER_STEP + 1)
  })

  it('dispose() 移除全部对象', () => {
    paint.sync([frameNode({ id: 'a' }), markupNode({ id: 'b' })], ctx())
    const objects = [...leafer.children]
    paint.dispose()
    expect(paint.paintedCount()).toBe(0)
    expect(objects.every((object) => object.removed)).toBe(true)
  })

  it('非 shape 节点（filter/paint drift）被跳过并 warn，其余收支不受影响', () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn').mockImplementation(() => {})
    try {
      const alien = { id: 'x', type: 'image', status: 'ready', x: 0, y: 0, width: 10, height: 10 } as unknown as MivoCanvasNode
      const counts = paint.sync([frameNode({ id: 'a' }), alien], ctx())
      expect(counts).toEqual({ created: 1, updated: 0, deleted: 0 })
      expect(paint.paintedCount()).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith(SOURCE, expect.stringContaining('x'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('filter/paint 同集（isLeaferShapePaintedNode 是唯一谓词）', () => {
  it('frame + markup rect/ellipse/note 在集内；line/arrow/brush/stamp/text 不在', () => {
    expect(isLeaferShapePaintedNode(frameNode())).toBe(true)
    for (const kind of ['rect', 'ellipse', 'note'] as const) {
      expect(isLeaferShapePaintedNode(markupNode({ markupKind: kind }))).toBe(true)
    }
    for (const kind of ['line', 'arrow', 'brush', 'stamp'] as const) {
      expect(isLeaferShapePaintedNode(markupNode({ markupKind: kind }))).toBe(false)
    }
    expect(isLeaferShapePaintedNode({ id: 't', type: 'text' } as unknown as MivoCanvasNode)).toBe(false)
  })
})

describe('createLeaferShapePaint — D1 source-contract (pure paint, no Leafer back-write)', () => {
  it('module source never subscribes to Leafer events (no .on( call)', () => {
    expect(moduleSource).not.toMatch(/\.on\(/)
  })

  it('module source never reads zoomLayer (no camera back-write)', () => {
    expect(moduleSource).not.toMatch(/zoomLayer/)
  })
})
