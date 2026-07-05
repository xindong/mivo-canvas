import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 'leafer-ui' with lightweight fake display objects so the paint module can
// be exercised without a real canvas. The fakes record props (for DOM-parity
// assertions), track group children, and mark remove().
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
  class FakeLine extends FakeUI {}
  class FakeGroup extends FakeUI {
    children: FakeUI[] = []
    add(child: FakeUI) {
      this.children.push(child)
    }
  }
  return { Rect: FakeRect, Ellipse: FakeEllipse, Image: FakeImage, Line: FakeLine, Group: FakeGroup }
})

// canvasDocumentModel 传递引入 demoScenes → demoImages 需要 document（node 测试
// 环境没有）——与 canvasDocumentModel.test.ts 同款 mock。
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

// Importing AFTER vi.mock (hoisted) so the module sees the mocked deps.
// projection + the connector normalize helpers are REAL on purpose: the parity
// tests below lock "DOM and Leafer read the SAME normalized markupPoints" with
// the actual store/model code, not re-declared fixtures.
import {
  arrowHeadPointsFor,
  arrowHeadStrokeWidthFor,
  createLeaferLinePaint,
  defaultLinePaintPointsFor,
  lineEndpointsFor,
  linePaintPropsFor,
  SOURCE,
} from './leaferLinePaint'
import type { LeaferLinePaint } from './leaferLinePaint'
import { isLeaferLinePaintedNode } from './leaferSpikeFilter'
import { projectNode } from './projection'
import { markupPointsToCanvas } from './hitTest'
import { normalizeConnectorMarkupNodes } from '../store/canvasDocumentModel'
import { connectorAnchorPointFor } from '../canvas/connectorGeometry'
import { debugLogger } from '../store/debugLogStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'
import type { Leafer } from 'leafer-ui'
import moduleSource from './leaferLinePaint.ts?raw'

type FakeUI = {
  props: Record<string, unknown>
  removed: boolean
  set: (p: Record<string, unknown>) => void
  remove: () => void
}
type FakeGroupUI = FakeUI & { children: FakeUI[] }

const makeFakeLeafer = () => {
  const children: FakeUI[] = []
  return {
    add: (child: FakeUI) => children.push(child),
    children,
  } as unknown as Leafer & { children: FakeUI[] }
}

/** 类型安全地取第 i 个顶层 Group（绕开 Leafer.children 的 IUI 类型交叉）。 */
const groupAt = (leafer: { children: unknown }, index: number): FakeGroupUI =>
  (leafer.children as FakeGroupUI[])[index]

const ctx = (layerOf?: (nodeId: string) => number | undefined): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale: 1 },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
  ...(layerOf ? { layerOf } : {}),
})

const lineNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'l1',
    type: 'markup',
    status: 'ready',
    markupKind: 'line',
    x: 40,
    y: 60,
    width: 200,
    height: 100,
    ...opts,
  }) as unknown as MivoCanvasNode

const arrowNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  lineNode({ id: 'a1', markupKind: 'arrow', ...opts })

const expectClose = (actual: number, expected: number, digits = 9) =>
  expect(actual).toBeCloseTo(expected, digits)

describe('defaultLinePaintPointsFor — DOM render fallback parity (CanvasNodeView defaultMarkupPointsFor)', () => {
  it('insets by markupStrokeWidth||3 from bottom-left → top-right (NOT the hitTest (0,h)-(w,0) fallback)', () => {
    const r = projectNode(lineNode())
    expect(defaultLinePaintPointsFor(r)).toEqual([
      { x: 3, y: 97 },
      { x: 197, y: 3 },
    ])
  })

  it('uses explicit markupStrokeWidth and clamps at 2', () => {
    const r = projectNode(lineNode({ markupStrokeWidth: 8, width: 10, height: 10 }))
    expect(defaultLinePaintPointsFor(r)).toEqual([
      { x: 8, y: 2 },
      { x: 2, y: 8 },
    ])
  })
})

describe('lineEndpointsFor — SVG attr fallback chain', () => {
  it('uses markupPoints when present', () => {
    const r = projectNode(lineNode({ markupPoints: [{ x: 10, y: 20 }, { x: 150, y: 80 }] }))
    expect(lineEndpointsFor(r)).toEqual({ start: { x: 10, y: 20 }, end: { x: 150, y: 80 } })
  })

  it('markupPoints.length === 1 → end falls back to (width, 0) like the SVG ?? chain', () => {
    const r = projectNode(lineNode({ markupPoints: [{ x: 10, y: 20 }] }))
    expect(lineEndpointsFor(r)).toEqual({ start: { x: 10, y: 20 }, end: { x: 200, y: 0 } })
  })
})

describe('arrow head — SVG marker chevron parity (M 5 3 L 15 9 L 5 15, ref 15,9, userSpaceOnUse)', () => {
  it('strokeWidth clamp mirrors Math.max(2.5, Math.min(5.5, w))', () => {
    expect(arrowHeadStrokeWidthFor(1)).toBe(2.5)
    expect(arrowHeadStrokeWidthFor(3)).toBe(3)
    expect(arrowHeadStrokeWidthFor(9)).toBe(5.5)
  })

  it('end head on a horizontal line: chevron arms trail the tip by 10px, spread ±6px', () => {
    // anchor (100, 0), angle 0 → points = anchor + (p - ref)
    const flat = arrowHeadPointsFor({ x: 100, y: 0 }, 0)
    expect(flat).toEqual([90, -6, 100, 0, 90, 6])
  })

  it('start head uses angle + π (SVG orient auto-start-reverse): tip at start, arms toward line interior', () => {
    const flat = arrowHeadPointsFor({ x: 0, y: 0 }, Math.PI)
    expectClose(flat[0], 10)
    expectClose(flat[1], 6)
    expectClose(flat[2], 0)
    expectClose(flat[3], 0)
    expectClose(flat[4], 10)
    expectClose(flat[5], -6)
  })
})

describe('linePaintPropsFor — DOM 视觉等价（消费 projection 下沉缺省）', () => {
  it('line 缺省：#6957e8 3px solid、round cap、无箭头头部、group 携带 geometry offset', () => {
    const props = linePaintPropsFor(projectNode(lineNode()), undefined)
    expect(props.group).toEqual({ x: 40, y: 60 })
    expect(props.main.stroke).toBe('#6957e8')
    expect(props.main.strokeWidth).toBe(3)
    expect(props.main.strokeCap).toBe('round')
    expect(props.main.dashPattern).toBeUndefined()
    expect('dashPattern' in props.main).toBe(true) // update 路径显式清除旧 dash
    expect(props.main.points).toEqual([3, 97, 197, 3])
    expect(props.startHead).toBeNull()
    expect(props.endHead).toBeNull()
  })

  it('arrow 缺省：只有 end head（markupEndArrow ?? kind === "arrow"），cap 变 butt', () => {
    const props = linePaintPropsFor(projectNode(arrowNode()), undefined)
    expect(props.main.strokeCap).toBe('butt')
    expect(props.startHead).toBeNull()
    expect(props.endHead).not.toBeNull()
    expect(props.endHead!.strokeCap).toBe('round')
    expect(props.endHead!.strokeJoin).toBe('round')
    expect(props.endHead!.strokeWidth).toBe(3)
  })

  it('markupStartArrow → start head 出现；markupEndArrow=false 显式关掉 arrow 的 end head', () => {
    const both = linePaintPropsFor(
      projectNode(arrowNode({ markupStartArrow: true })),
      undefined,
    )
    expect(both.startHead).not.toBeNull()
    expect(both.endHead).not.toBeNull()

    const none = linePaintPropsFor(
      projectNode(arrowNode({ markupEndArrow: false })),
      undefined,
    )
    expect(none.endHead).toBeNull()
    expect(none.main.strokeCap).toBe('round')
  })

  it('line + markupEndArrow=true：line kind 也能带箭头（DOM showEndArrow 同式）', () => {
    const props = linePaintPropsFor(projectNode(lineNode({ markupEndArrow: true })), undefined)
    expect(props.endHead).not.toBeNull()
    expect(props.main.strokeCap).toBe('butt')
  })

  it('dashed：dashPattern 沿用仓内唯一公式 w*2.2 / w*1.6', () => {
    const props = linePaintPropsFor(
      projectNode(lineNode({ markupStrokeWidth: 5, markupStrokeStyle: 'dashed' })),
      undefined,
    )
    expect(props.main.dashPattern).toEqual([11, 8])
  })

  it('markupOpacity < 1：opacity 落在 Line 对象级（Leafer 运行时不吃 solid paint 对象的 stroke opacity，像素实证），头部保持满透明（DOM marker 无 strokeOpacity）', () => {
    const props = linePaintPropsFor(projectNode(arrowNode({ markupOpacity: 0.82 })), undefined)
    expect(props.main.stroke).toBe('#6957e8')
    expect(props.main.opacity).toBe(0.82)
    expect(props.endHead!.stroke).toBe('#6957e8')
    expect('opacity' in props.endHead!).toBe(false)
  })

  it('opacity 键始终存在（1 缺省）——update 回退时清除旧的半透明', () => {
    const props = linePaintPropsFor(projectNode(lineNode()), undefined)
    expect(props.main.opacity).toBe(1)
  })

  it('端点几何：end head 锚在 p1、沿线方向；horizontal markupPoints 时坐标精确', () => {
    const props = linePaintPropsFor(
      projectNode(arrowNode({ markupPoints: [{ x: 0, y: 50 }, { x: 200, y: 50 }] })),
      undefined,
    )
    expect(props.main.points).toEqual([0, 50, 200, 50])
    expect(props.endHead!.points).toEqual([190, 44, 200, 50, 190, 56])
  })

  it('FU-8 rotation：旋转烘进局部点（绕节点盒中心 w/2,h/2），group 不携带 rotation', () => {
    // 水平线 (0,50)-(200,50) 绕中心 (100,50) 旋转 90° → 竖直线 (100,-50)-(100,150)
    const props = linePaintPropsFor(
      projectNode(
        lineNode({
          markupPoints: [{ x: 0, y: 50 }, { x: 200, y: 50 }],
          transform: { x: 40, y: 60, width: 200, height: 100, rotation: 90 },
        }),
      ),
      undefined,
    )
    const [x0, y0, x1, y1] = props.main.points as number[]
    expectClose(x0, 100)
    expectClose(y0, -50)
    expectClose(x1, 100)
    expectClose(y1, 150)
    expect('rotation' in props.group).toBe(false)
  })

  it('FU-8 rotation：箭头头部角度随旋转后的端点走（90° 后指向 +y）', () => {
    const props = linePaintPropsFor(
      projectNode(
        arrowNode({
          markupPoints: [{ x: 0, y: 50 }, { x: 200, y: 50 }],
          transform: { x: 40, y: 60, width: 200, height: 100, rotation: 90 },
        }),
      ),
      undefined,
    )
    const head = props.endHead!.points as number[]
    // 端点 (100,150)，方向 +y：arms 在 y=140，tip 在 (100,150)
    expectClose(head[0], 106)
    expectClose(head[1], 140)
    expectClose(head[2], 100)
    expectClose(head[3], 150)
    expectClose(head[4], 94)
    expectClose(head[5], 140)
  })

  it('zIndex 透传进 group props（2b-2 z-order）', () => {
    const props = linePaintPropsFor(projectNode(lineNode()), 42)
    expect(props.group.zIndex).toBe(42)
  })
})

describe('createLeaferLinePaint — diffReconcilePlan 收支 (no leak, no resurrect)', () => {
  let leafer: ReturnType<typeof makeFakeLeafer>
  let paint: LeaferLinePaint

  beforeEach(() => {
    leafer = makeFakeLeafer()
    paint = createLeaferLinePaint(leafer)
  })

  it('create/update/delete counts match the id diff；每节点 1 个顶层 Group child', () => {
    const c1 = paint.sync([lineNode({ id: 'a' }), arrowNode({ id: 'b' })], ctx())
    expect(c1).toEqual({ created: 2, updated: 0, deleted: 0 })
    expect(paint.paintedCount()).toBe(2)
    expect(leafer.children.length).toBe(2) // hook children 记账口径：1 group / node

    const c2 = paint.sync([arrowNode({ id: 'b' }), lineNode({ id: 'c' })], ctx())
    expect(c2).toEqual({ created: 1, updated: 1, deleted: 1 })
    expect(paint.paintedCount()).toBe(2)

    const c3 = paint.sync([], ctx())
    expect(c3).toEqual({ created: 0, updated: 0, deleted: 2 })
    expect(paint.paintedCount()).toBe(0)
  })

  it('group 子对象顺序：main line 在前、head 在后（DOM marker 画在线身之上）', () => {
    paint.sync([arrowNode({ id: 'a', markupStartArrow: true })], ctx())
    const group = groupAt(leafer, 0)
    expect(group.children.length).toBe(3)
    const [main, startHead, endHead] = group.children
    expect(Array.isArray(main.props.points)).toBe(true)
    expect((main.props.points as number[]).length).toBe(4)
    expect((startHead.props.points as number[]).length).toBe(6)
    expect((endHead.props.points as number[]).length).toBe(6)
  })

  it('update 路径：箭头开关触发 head 创建/移除，group/main 对象复用', () => {
    paint.sync([arrowNode({ id: 'a' })], ctx())
    const group = groupAt(leafer, 0)
    const main = group.children[0]
    expect(group.children.length).toBe(2) // main + end head

    // 关 end arrow → head 移除
    paint.sync([arrowNode({ id: 'a', markupEndArrow: false })], ctx())
    expect(leafer.children[0]).toBe(group)
    expect(group.children[0]).toBe(main)
    expect(group.children[1].removed).toBe(true)

    // 开 start arrow → 新 head 挂到同一 group
    paint.sync([arrowNode({ id: 'a', markupEndArrow: false, markupStartArrow: true })], ctx())
    const liveChildren = group.children.filter((child) => !child.removed)
    expect(liveChildren.length).toBe(2)
    expect(main.props.strokeCap).toBe('butt')
  })

  it('update 路径：dashed → solid 回退时 dashPattern 被显式清除', () => {
    paint.sync([lineNode({ id: 'a', markupStrokeStyle: 'dashed' })], ctx())
    const main = groupAt(leafer, 0).children[0]
    expect(main.props.dashPattern).toEqual([2.2 * 3, 1.6 * 3])

    paint.sync([lineNode({ id: 'a', markupStrokeStyle: 'solid' })], ctx())
    expect(main.props.dashPattern).toBeUndefined()
  })

  it('ctx.layerOf 提供 zIndex 且 update 跟随变化', () => {
    paint.sync([lineNode({ id: 'a' })], ctx(() => 7))
    const group = groupAt(leafer, 0)
    expect(group.props.zIndex).toBe(7)
    paint.sync([lineNode({ id: 'a' })], ctx(() => 9))
    expect(group.props.zIndex).toBe(9)
  })

  it('dispose() 移除全部 group', () => {
    paint.sync([lineNode({ id: 'a' }), arrowNode({ id: 'b' })], ctx())
    const groups = [...leafer.children]
    paint.dispose()
    expect(paint.paintedCount()).toBe(0)
    expect(groups.every((group) => group.removed)).toBe(true)
  })

  it('非 line 节点（filter/paint drift）被跳过并 warn，其余收支不受影响', () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn').mockImplementation(() => {})
    try {
      const alien = { id: 'x', type: 'markup', status: 'ready', markupKind: 'rect', x: 0, y: 0, width: 10, height: 10 } as unknown as MivoCanvasNode
      const counts = paint.sync([lineNode({ id: 'a' }), alien], ctx())
      expect(counts).toEqual({ created: 1, updated: 0, deleted: 0 })
      expect(paint.paintedCount()).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith(SOURCE, expect.stringContaining('x'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('connector 几何真相源对照 — 节点移动后 DOM/Leafer 读同一 normalized points（总计划 Phase 4 要求）', () => {
  const boxNode = (id: string, x: number, y: number): MivoCanvasNode =>
    ({ id, type: 'image', status: 'ready', title: id, x, y, width: 100, height: 100 }) as unknown as MivoCanvasNode

  const connector = (): MivoCanvasNode =>
    ({
      id: 'conn',
      type: 'markup',
      status: 'ready',
      markupKind: 'arrow',
      x: 0,
      y: 0,
      width: 24,
      height: 24,
      markupPoints: [
        { x: 0, y: 0 },
        { x: 24, y: 24 },
      ],
      connectorStart: { nodeId: 'A', anchor: 'right', offset: 0.5 },
      connectorEnd: { nodeId: 'B', anchor: 'left', offset: 0.5 },
    }) as unknown as MivoCanvasNode

  it('normalize 后：Leafer main.points === 节点局部 markupPoints；画布坐标 == binding 锚点 == hitTest markupPointsToCanvas', () => {
    const nodes = normalizeConnectorMarkupNodes([boxNode('A', 0, 0), boxNode('B', 300, 200), connector()])
    const normalized = nodes.find((node) => node.id === 'conn')!

    const projected = projectNode(normalized)
    const props = linePaintPropsFor(projected, undefined)

    // Leafer 消费的就是 store 归一化后的局部 markupPoints（DOM SVG 同一来源）
    expect(props.main.points).toEqual(
      normalized.markupPoints!.flatMap((point) => [point.x, point.y]),
    )
    expect(props.group.x).toBe(normalized.x)
    expect(props.group.y).toBe(normalized.y)

    // 画布坐标 = geometry offset + 局部点（1b-2 坐标契约，与 hitTest 完全同式）
    const canvasPts = markupPointsToCanvas(projected, normalized.markupPoints!)
    expect(canvasPts[0]).toEqual(connectorAnchorPointFor(boxNode('A', 0, 0), 'right', 0.5))
    expect(canvasPts[1]).toEqual(connectorAnchorPointFor(boxNode('B', 300, 200), 'left', 0.5))
  })

  it('目标节点移动 → 重新 normalize → Leafer update 后端点跟随新锚点（绝不读 Leafer 位移，D1）', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferLinePaint(leafer)

    const before = normalizeConnectorMarkupNodes([boxNode('A', 0, 0), boxNode('B', 300, 200), connector()])
    paint.sync(before.filter(isLeaferLinePaintedNode), ctx())

    // 节点 B 移动（store 侧动作）→ store 重新归一化 connector 几何
    const after = normalizeConnectorMarkupNodes([
      boxNode('A', 0, 0),
      boxNode('B', 440, 260),
      before.find((node) => node.id === 'conn')!,
    ])
    const moved = after.find((node) => node.id === 'conn')!
    const counts = paint.sync(after.filter(isLeaferLinePaintedNode), ctx())
    expect(counts).toEqual({ created: 0, updated: 1, deleted: 0 })

    const group = groupAt(leafer, 0)
    const main = group.children[0]
    // Leafer 读到的仍是 store 归一化输出——端点画布坐标 == 移动后的 binding 锚点
    const [x0, y0, x1, y1] = main.props.points as number[]
    expect({ x: (group.props.x as number) + x0, y: (group.props.y as number) + y0 }).toEqual(
      connectorAnchorPointFor(boxNode('A', 0, 0), 'right', 0.5),
    )
    expect({ x: (group.props.x as number) + x1, y: (group.props.y as number) + y1 }).toEqual(
      connectorAnchorPointFor(boxNode('B', 440, 260), 'left', 0.5),
    )
    // DOM 对照：SVG 消费的 markupPoints 与 Leafer points 同源同值
    expect([x0, y0, x1, y1]).toEqual(moved.markupPoints!.flatMap((point) => [point.x, point.y]))
  })
})

describe('filter/paint 同集（isLeaferLinePaintedNode 是唯一谓词）', () => {
  it('markup line/arrow 在集内；rect/ellipse/note/brush/stamp、frame、image、text 不在', () => {
    expect(isLeaferLinePaintedNode(lineNode())).toBe(true)
    expect(isLeaferLinePaintedNode(arrowNode())).toBe(true)
    for (const kind of ['rect', 'ellipse', 'note', 'brush', 'stamp'] as const) {
      expect(isLeaferLinePaintedNode(lineNode({ markupKind: kind }))).toBe(false)
    }
    expect(isLeaferLinePaintedNode({ id: 'f', type: 'frame' } as unknown as MivoCanvasNode)).toBe(false)
    expect(isLeaferLinePaintedNode({ id: 'i', type: 'image' } as unknown as MivoCanvasNode)).toBe(false)
    expect(isLeaferLinePaintedNode({ id: 't', type: 'text' } as unknown as MivoCanvasNode)).toBe(false)
  })
})

describe('createLeaferLinePaint — D1 source-contract (pure paint, no Leafer back-write)', () => {
  it('module source never subscribes to Leafer events (no .on( call)', () => {
    expect(moduleSource).not.toMatch(/\.on\(/)
  })

  it('module source never reads zoomLayer (no camera back-write)', () => {
    expect(moduleSource).not.toMatch(/zoomLayer/)
  })

  it('module source never reads connector geometry from Leafer objects (consumes markupPoints only)', () => {
    // 反向依赖的常见形态：读取 Leafer 对象的 x/y/worldTransform 回写 store。
    expect(moduleSource).not.toMatch(/worldTransform|getBounds|__world/)
  })
})
