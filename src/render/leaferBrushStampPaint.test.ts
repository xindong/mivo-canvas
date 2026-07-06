import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 'leafer-ui' with lightweight fake display objects so the paint module can
// be exercised without a real canvas. The fakes record props (for DOM-parity
// assertions), record their class, and mark remove().
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
  class FakePath extends FakeUI {}
  class FakeGroup extends FakeUI {
    children: FakeUI[] = []
    add(child: FakeUI) {
      this.children.push(child)
    }
  }
  return { Rect: FakeRect, Ellipse: FakeEllipse, Image: FakeImage, Line: FakeLine, Path: FakePath, Group: FakeGroup }
})

// Importing AFTER vi.mock (hoisted) so the module sees the mocked deps.
// projection + brushGeometry (perfect-freehand) + stampDefs are REAL on
// purpose: the parity tests lock "DOM and Leafer consume the SAME outline /
// sticker url" with the actual render helpers, not re-declared fixtures.
import {
  brushLocalPointsFor,
  brushStampPaintPlanFor,
  createLeaferBrushStampPaint,
  defaultBrushPaintPointsFor,
  SOURCE,
  STAMP_SHADOW,
} from './leaferBrushStampPaint'
import type { LeaferBrushStampPaint } from './leaferBrushStampPaint'
import { isLeaferBrushStampPaintedNode, isLeaferSpikePainted } from './leaferSpikeFilter'
import { projectNode } from './projection'
import { brushOutlinePathFor } from '../canvas/brushGeometry'
import { stampSrcFor } from '../canvas/stampDefs'
import { debugLogger } from '../store/debugLogStore'
import type { MarkupPoint, MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'
import type { Leafer } from 'leafer-ui'
import moduleSource from './leaferBrushStampPaint.ts?raw'

type FakeUI = {
  props: Record<string, unknown>
  removed: boolean
  set: (p: Record<string, unknown>) => void
  remove: () => void
}

const makeFakeLeafer = () => {
  const children: FakeUI[] = []
  return {
    add: (child: FakeUI) => children.push(child),
    children,
  } as unknown as Leafer & { children: FakeUI[] }
}

const childAt = (leafer: { children: unknown }, index: number): FakeUI =>
  (leafer.children as FakeUI[])[index]

const ctx = (layerOf?: (nodeId: string) => number | undefined): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale: 1 },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
  ...(layerOf ? { layerOf } : {}),
})

const WAVE: MarkupPoint[] = [
  { x: 12, y: 96 },
  { x: 83, y: 40 },
  { x: 145, y: 108 },
  { x: 248, y: 48 },
]

const brushNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'b1',
    type: 'markup',
    status: 'ready',
    markupKind: 'brush',
    markupBrushKind: 'marker',
    x: 40,
    y: 60,
    width: 260,
    height: 160,
    markupPoints: WAVE,
    ...opts,
  }) as unknown as MivoCanvasNode

const stampNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 's1',
    type: 'markup',
    status: 'ready',
    markupKind: 'stamp',
    markupStampKind: 'heart',
    x: 400,
    y: 300,
    width: 112,
    height: 112,
    ...opts,
  }) as unknown as MivoCanvasNode

const expectClose = (actual: number, expected: number, digits = 9) =>
  expect(actual).toBeCloseTo(expected, digits)

describe('defaultBrushPaintPointsFor — DOM render fallback parity (CanvasNodeView defaultMarkupPointsFor brush 波形)', () => {
  it('(8,h*.6)(w*.32,h*.25)(w*.56,h*.68)(w-8,h*.3) — 与 DOM 同式（含同样的浮点算法）', () => {
    const width = 100
    const height = 50
    const r = projectNode(brushNode({ markupPoints: undefined, width, height }))
    expect(defaultBrushPaintPointsFor(r)).toEqual([
      { x: 8, y: height * 0.6 },
      { x: width * 0.32, y: height * 0.25 },
      { x: width * 0.56, y: height * 0.68 },
      { x: width - 8, y: height * 0.3 },
    ])
  })
})

describe('brushLocalPointsFor — FU-8 rotation 烘进局部点', () => {
  it('无 rotation：原样返回 markupPoints', () => {
    const r = projectNode(brushNode())
    expect(brushLocalPointsFor(r)).toEqual(WAVE)
  })

  it('90° 绕节点盒中心旋转，pressure 保留', () => {
    const r = projectNode(
      brushNode({
        width: 200,
        height: 100,
        markupPoints: [
          { x: 0, y: 50, pressure: 0.7 },
          { x: 200, y: 50 },
        ],
        transform: { x: 40, y: 60, width: 200, height: 100, rotation: 90 },
      }),
    )
    const [p0, p1] = brushLocalPointsFor(r)
    // 水平中线 (0,50)-(200,50) 绕 (100,50) 转 90° → 竖直 (100,-50)-(100,150)
    expectClose(p0.x, 100)
    expectClose(p0.y, -50)
    expect(p0.pressure).toBe(0.7)
    expectClose(p1.x, 100)
    expectClose(p1.y, 150)
    expect(p1.pressure).toBeUndefined()
  })
})

describe('brushStampPaintPlanFor — DOM 视觉等价（消费 projection 下沉缺省 + brushGeometry 单一来源）', () => {
  it('marker 实心笔迹 → brush-path：path === brushOutlinePathFor 同参输出，fill = 描边色，opacity 键始终存在', () => {
    const plan = brushStampPaintPlanFor(projectNode(brushNode()), undefined)
    expect(plan.kind).toBe('brush-path')
    expect(plan.props.x).toBe(40)
    expect(plan.props.y).toBe(60)
    expect(plan.props.path).toBe(brushOutlinePathFor(WAVE, 3, 'marker'))
    expect(plan.props.fill).toBe('#6957e8') // projection 下沉的 markup 默认描边色
    expect(plan.props.opacity).toBe(1)
    expect('rotation' in plan.props).toBe(false) // rotation 烘进点，不在对象上
  })

  it('highlighter：markupOpacity(0.42) 落对象级 opacity（Path 无独立 stroke，等价 DOM fillOpacity），outline 用 highlighter 宽度', () => {
    const node = brushNode({ markupBrushKind: 'highlighter', markupStrokeWidth: 6, markupOpacity: 0.42 })
    const plan = brushStampPaintPlanFor(projectNode(node), undefined)
    expect(plan.kind).toBe('brush-path')
    expect(plan.props.opacity).toBe(0.42)
    expect(plan.props.path).toBe(brushOutlinePathFor(WAVE, 6, 'highlighter'))
    expect(plan.props.path).not.toBe(brushOutlinePathFor(WAVE, 6, 'marker'))
  })

  it('dashed → brush-polyline：raw strokeWidth（非 brushRenderWidthFor）+ round caps + 仓内唯一 dash 公式 + 对象级 opacity', () => {
    const node = brushNode({ markupStrokeColor: '#2563eb', markupStrokeStyle: 'dashed', markupStrokeWidth: 5, markupOpacity: 0.6 })
    const plan = brushStampPaintPlanFor(projectNode(node), undefined)
    expect(plan.kind).toBe('brush-polyline')
    expect(plan.props.points).toEqual(WAVE.flatMap((point) => [point.x, point.y]))
    expect(plan.props.stroke).toBe('#2563eb')
    expect(plan.props.strokeWidth).toBe(5)
    expect(plan.props.strokeCap).toBe('round')
    expect(plan.props.strokeJoin).toBe('round')
    expect(plan.props.dashPattern).toEqual([11, 8])
    expect(plan.props.opacity).toBe(0.6)
  })

  it('FU-8 rotation：path 等于旋转后点的 outline（perfect-freehand 旋转等变）', () => {
    const node = brushNode({
      transform: { x: 40, y: 60, width: 260, height: 160, rotation: 30 },
    } as Partial<MivoCanvasNode>)
    const projected = projectNode(node)
    const plan = brushStampPaintPlanFor(projected, undefined)
    expect(plan.props.path).toBe(brushOutlinePathFor(brushLocalPointsFor(projected), 3, 'marker'))
    expect(plan.props.path).not.toBe(brushOutlinePathFor(WAVE, 3, 'marker'))
  })

  it('markupPoints 缺省：波形 fallback 参与 outline（与 DOM defaultMarkupPointsFor 同式）', () => {
    const projected = projectNode(brushNode({ markupPoints: undefined }))
    const plan = brushStampPaintPlanFor(projected, undefined)
    expect(plan.props.path).toBe(
      brushOutlinePathFor(defaultBrushPaintPointsFor(projected), 3, 'marker'),
    )
  })

  it('stamp：Rect + image fill mode fit（DOM object-fit:contain）+ 贴纸 url + drop-shadow 数值 + rotation/origin center', () => {
    const node = stampNode({
      transform: { x: 400, y: 300, width: 112, height: 112, rotation: -20 },
    } as Partial<MivoCanvasNode>)
    const plan = brushStampPaintPlanFor(projectNode(node), undefined)
    expect(plan.kind).toBe('stamp')
    expect(plan.props.x).toBe(400)
    expect(plan.props.y).toBe(300)
    expect(plan.props.width).toBe(112)
    expect(plan.props.height).toBe(112)
    expect(plan.props.fill).toEqual({ type: 'image', url: stampSrcFor('heart'), mode: 'fit' })
    expect(plan.props.shadow).toEqual({ x: 0, y: 3, blur: 6, color: 'rgba(0, 0, 0, 0.22)' })
    expect(plan.props.shadow).toEqual(STAMP_SHADOW)
    expect(plan.props.rotation).toBe(-20)
    expect(plan.props.origin).toBe('center')
  })

  it('stamp：markupStampKind 未设 → stampSrcFor fallback（plus-one），rotation 键始终存在（0 缺省清旧角度）', () => {
    const plan = brushStampPaintPlanFor(projectNode(stampNode({ markupStampKind: undefined })), undefined)
    expect(plan.props.fill).toEqual({ type: 'image', url: stampSrcFor(undefined), mode: 'fit' })
    expect((plan.props.fill as { url: string }).url).toBe('/stickers/plus-one.svg')
    expect(plan.props.rotation).toBe(0)
  })

  it('zIndex 透传（2b-2 z-order）— brush 直传 props；stamp 走 groupProps（Group 是 z-order 容器）', () => {
    expect(brushStampPaintPlanFor(projectNode(brushNode()), 42).props.zIndex).toBe(42)
    const stampPlan = brushStampPaintPlanFor(projectNode(stampNode()), 7)
    // V2: stamp 顶层是 Group，zIndex 在 groupProps；sticker 无 zIndex（子对象）
    expect(stampPlan.groupProps?.zIndex).toBe(7)
    expect(stampPlan.props.zIndex).toBeUndefined()
  })
})

describe('createLeaferBrushStampPaint — diffReconcilePlan 收支 (no leak, no resurrect)', () => {
  let leafer: ReturnType<typeof makeFakeLeafer>
  let paint: LeaferBrushStampPaint

  beforeEach(() => {
    leafer = makeFakeLeafer()
    paint = createLeaferBrushStampPaint(leafer)
  })

  it('create/update/delete counts match the id diff；每节点 1 个顶层 child', () => {
    const c1 = paint.sync([brushNode({ id: 'a' }), stampNode({ id: 'b' })], ctx())
    expect(c1).toEqual({ created: 2, updated: 0, deleted: 0 })
    expect(paint.paintedCount()).toBe(2)
    expect(leafer.children.length).toBe(2) // hook children 记账口径：1 object / node

    const c2 = paint.sync([stampNode({ id: 'b' }), brushNode({ id: 'c' })], ctx())
    expect(c2).toEqual({ created: 1, updated: 1, deleted: 1 })
    expect(paint.paintedCount()).toBe(2)

    const c3 = paint.sync([], ctx())
    expect(c3).toEqual({ created: 0, updated: 0, deleted: 2 })
    expect(paint.paintedCount()).toBe(0)
  })

  it('V2 stamp 顶层 Group 结构：1 顶层 Group + 1 sticker 子对象；getStampObject 返回 handle', () => {
    paint.sync([stampNode({ id: 's' })], ctx(() => 25))
    expect(leafer.children.length).toBe(1) // 1 顶层 Group
    const group = childAt(leafer, 0) as unknown as { children: FakeUI[]; props: Record<string, unknown> }
    expect(group.children.length).toBe(1) // sticker 是唯一子对象（fx 的 rays 此时不存在）
    const sticker = group.children[0]
    expect((sticker.props.fill as { type: string }).type).toBe('image')
    expect((sticker.props.fill as { url: string }).url).toBe('/stickers/heart.svg')
    expect(sticker.props.origin).toBe('center')
    // zIndex 在 Group 上，不在 sticker 上
    expect(group.props.zIndex).toBe(25)
    expect(sticker.props.zIndex).toBeUndefined()
    // getStampObject 返回同一 sticker + Group
    const handle = paint.getStampObject('s')
    expect(handle?.nodeId).toBe('s')
    expect(handle?.sticker).toBe(sticker)
    expect(handle?.group).toBe(group)
  })

  it('getStampObject：brush 节点 / 不存在 id / dispose 后均返回 undefined', () => {
    paint.sync([brushNode({ id: 'b' }), stampNode({ id: 's' })], ctx())
    expect(paint.getStampObject('b')).toBeUndefined() // brush 不是 stamp
    expect(paint.getStampObject('missing')).toBeUndefined()
    paint.dispose()
    expect(paint.getStampObject('s')).toBeUndefined() // dispose 后 entry 清空
  })

  it('update 路径：同 kind 复用对象（stamp 换贴纸只 set 新 fill url 到 sticker）', () => {
    paint.sync([stampNode({ id: 'a', markupStampKind: 'heart' })], ctx())
    const object = childAt(leafer, 0) // Group
    const handleBefore = paint.getStampObject('a')
    paint.sync([stampNode({ id: 'a', markupStampKind: 'star' })], ctx())
    expect(leafer.children.length).toBe(1) // 1 顶层 Group / node
    expect(childAt(leafer, 0)).toBe(object) // Group 复用
    // V2: fill 在 sticker（Group 子对象）上，不在 Group 上；getStampObject 返回同一 sticker
    const handle = paint.getStampObject('a')
    expect(handle?.sticker).toBe(handleBefore?.sticker)
    expect(((handle?.sticker as unknown as FakeUI).props.fill as { url: string }).url).toBe('/stickers/star.svg')
    expect(object.removed).toBe(false)
  })

  it('kind swap：dashed↔solid 笔迹销毁重建（Path ↔ Line 类不同）', () => {
    paint.sync([brushNode({ id: 'a' })], ctx())
    const solid = childAt(leafer, 0)
    expect('path' in solid.props).toBe(true)

    paint.sync([brushNode({ id: 'a', markupStrokeStyle: 'dashed' })], ctx())
    expect(solid.removed).toBe(true)
    const dashed = childAt(leafer, 1)
    expect(Array.isArray(dashed.props.points)).toBe(true)
    expect(paint.paintedCount()).toBe(1)
  })

  it('kind swap：同 id brush → stamp 销毁重建（Group 顶层，image fill 在 sticker）', () => {
    paint.sync([brushNode({ id: 'a' })], ctx())
    const brush = childAt(leafer, 0)
    const counts = paint.sync([stampNode({ id: 'a' })], ctx())
    expect(counts).toEqual({ created: 0, updated: 1, deleted: 0 })
    expect(brush.removed).toBe(true)
    // V2: stamp 顶层是 Group；image fill 在其 sticker 子对象上
    const stampGroup = childAt(leafer, 1) as unknown as { children: FakeUI[] }
    expect(stampGroup.children.length).toBe(1)
    expect((stampGroup.children[0].props.fill as { type: string }).type).toBe('image')
    expect(paint.getStampObject('a')?.sticker).toBe(stampGroup.children[0])
  })

  it('ctx.layerOf 提供 zIndex 且 update 跟随变化（brush props / stamp groupProps）', () => {
    paint.sync([brushNode({ id: 'a' })], ctx(() => 7))
    const object = childAt(leafer, 0)
    expect(object.props.zIndex).toBe(7)
    paint.sync([brushNode({ id: 'a' })], ctx(() => 9))
    expect(object.props.zIndex).toBe(9)

    // V2 stamp: zIndex 落在 Group（顶层），sticker 不带 zIndex
    paint.sync([stampNode({ id: 's' })], ctx(() => 25))
    const group = childAt(leafer, 1)
    expect(group.props.zIndex).toBe(25)
    expect((paint.getStampObject('s')?.sticker as unknown as FakeUI).props.zIndex).toBeUndefined()
    paint.sync([stampNode({ id: 's' })], ctx(() => 30))
    expect(group.props.zIndex).toBe(30)
  })

  it('dispose() 移除全部对象', () => {
    paint.sync([brushNode({ id: 'a' }), stampNode({ id: 'b' })], ctx())
    const objects = [...leafer.children]
    paint.dispose()
    expect(paint.paintedCount()).toBe(0)
    expect(objects.every((object) => object.removed)).toBe(true)
  })

  it('非 brush/stamp 节点（filter/paint drift）被跳过并 warn，其余收支不受影响', () => {
    const warnSpy = vi.spyOn(debugLogger, 'warn').mockImplementation(() => {})
    try {
      const alien = { id: 'x', type: 'markup', status: 'ready', markupKind: 'rect', x: 0, y: 0, width: 10, height: 10 } as unknown as MivoCanvasNode
      const counts = paint.sync([brushNode({ id: 'a' }), alien], ctx())
      expect(counts).toEqual({ created: 1, updated: 0, deleted: 0 })
      expect(paint.paintedCount()).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith(SOURCE, expect.stringContaining('x'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('filter/paint 同集（isLeaferBrushStampPaintedNode 是唯一谓词）', () => {
  it('markup brush/stamp 在集内；rect/ellipse/note/line/arrow、frame、image、text 不在', () => {
    expect(isLeaferBrushStampPaintedNode(brushNode())).toBe(true)
    expect(isLeaferBrushStampPaintedNode(stampNode())).toBe(true)
    for (const kind of ['rect', 'ellipse', 'note', 'line', 'arrow'] as const) {
      expect(isLeaferBrushStampPaintedNode(brushNode({ markupKind: kind }))).toBe(false)
    }
    expect(isLeaferBrushStampPaintedNode({ id: 'f', type: 'frame' } as unknown as MivoCanvasNode)).toBe(false)
    expect(isLeaferBrushStampPaintedNode({ id: 'i', type: 'image' } as unknown as MivoCanvasNode)).toBe(false)
    expect(isLeaferBrushStampPaintedNode({ id: 't', type: 'text' } as unknown as MivoCanvasNode)).toBe(false)
  })

  it('isLeaferSpikePainted（DOM 过滤总谓词）自 4c 起包含 brush/stamp', () => {
    expect(isLeaferSpikePainted(brushNode())).toBe(true)
    expect(isLeaferSpikePainted(stampNode())).toBe(true)
  })
})

describe('createLeaferBrushStampPaint — D1 source-contract (pure paint, no Leafer back-write)', () => {
  it('module source never subscribes to Leafer events (no .on( call)', () => {
    expect(moduleSource).not.toMatch(/\.on\(/)
  })

  it('module source never reads zoomLayer (no camera back-write)', () => {
    expect(moduleSource).not.toMatch(/zoomLayer/)
  })

  it('module source never reads geometry back from Leafer objects', () => {
    expect(moduleSource).not.toMatch(/worldTransform|getBounds|__world/)
  })
})
