import { beforeEach, describe, expect, it, vi } from 'vitest'

// PR-R2 行为测试：拖动单节点时未变节点的 projectNode+set 调用次数=0（仅被拖节点 +1）。
// 用 fake leafer-ui 对象（set: vi.fn）+ spied projectNode 计数，不需 leafer runtime。

vi.mock('leafer-ui', () => {
  // class 形式才能被 `new`（vi.fn 箭头函数不行）；每个实例有独立 set spy。
  class FakeUI {
    set = vi.fn()
    remove = vi.fn()
    children: unknown[] = []
    add(child: unknown) {
      this.children.push(child)
    }
  }
  return { Rect: FakeUI, Ellipse: FakeUI, Line: FakeUI, Path: FakeUI, Image: FakeUI, Group: FakeUI }
})

// 包装 projectNode 以计数（委托真实实现，props 仍正确）。
vi.mock('./projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projection')>()
  return { ...actual, projectNode: vi.fn(actual.projectNode) }
})

// image 模块的 lease 走 acquireAssetUrl——mock 成同步 no-op，避免 async 计时干扰 set 计数。
vi.mock('../lib/assetUrlLease', () => ({
  acquireAssetUrl: vi.fn(() => Promise.resolve({ url: 'fake://url', release: () => {} })),
}))

import { projectNode } from './projection'
import { createLeaferShapePaint } from './leaferShapePaint'
import { createLeaferLinePaint } from './leaferLinePaint'
import { createLeaferBrushStampPaint } from './leaferBrushStampPaint'
import { createLeaferImagePaint } from './leaferImagePaint'
import type { Leafer } from 'leafer-ui'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'

type FakeObj = { set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; children: unknown[]; add: (c: unknown) => void }

const makeFakeLeafer = () => {
  const children: FakeObj[] = []
  return {
    add: (child: FakeObj) => children.push(child),
    children,
  } as unknown as Leafer & { children: FakeObj[] }
}

const ctx = (layerOf?: (id: string) => number | undefined): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale: 1 },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
  ...(layerOf ? { layerOf } : {}),
})

const rectNode = (id: string, x = 0): MivoCanvasNode =>
  ({ id, type: 'markup', status: 'ready', markupKind: 'rect', x, y: 0, width: 100, height: 80, markupFillColor: '#fff', markupStrokeColor: '#000', markupStrokeWidth: 2, markupStrokeStyle: 'solid' }) as unknown as MivoCanvasNode

const lineNode = (id: string, x = 0): MivoCanvasNode =>
  ({ id, type: 'markup', status: 'ready', markupKind: 'arrow', x, y: 0, width: 100, height: 80, markupStrokeColor: '#000', markupStrokeWidth: 2, markupStrokeStyle: 'solid', markupEndArrow: true, markupPoints: [{ x: 0, y: 80 }, { x: 100, y: 0 }] }) as unknown as MivoCanvasNode

const brushNode = (id: string, x = 0): MivoCanvasNode =>
  ({ id, type: 'markup', status: 'ready', markupKind: 'brush', markupBrushKind: 'marker', x, y: 0, width: 100, height: 80, markupStrokeColor: '#000', markupStrokeWidth: 2, markupStrokeStyle: 'solid', markupPoints: [{ x: 0, y: 40 }, { x: 100, y: 40 }] }) as unknown as MivoCanvasNode

const imageNode = (id: string, x = 0): MivoCanvasNode =>
  ({ id, type: 'image', status: 'ready', x, y: 0, width: 100, height: 80, assetUrl: 'http://example.com/a.png' }) as unknown as MivoCanvasNode

const flushMicrotasks = async () => {
  // 让 acquireAssetUrl 的 .then 落地，避免 lease-apply 的 set 计入第二次 sync。
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const countSets = (objs: FakeObj[]): number => objs.reduce((sum, o) => sum + o.set.mock.calls.length, 0)

const N = 50

describe('PR-R2 行为：拖单节点 → 未变节点 projectNode+set=0', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shape: 50 节点拖 1 → projectNode 调用 1 次,仅 1 个对象 set 被调用', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferShapePaint(leafer)
    const nodes = Array.from({ length: N }, (_, i) => rectNode(`s${i}`, 0))
    paint.sync(nodes, ctx())
    vi.clearAllMocks()
    // drag s25: x 0→100
    nodes[25] = { ...nodes[25], x: 100 } as MivoCanvasNode
    paint.sync(nodes, ctx())

    expect(projectNode).toHaveBeenCalledTimes(1)
    const children = (leafer as unknown as { children: FakeObj[] }).children
    const setCalls = countSets(children)
    expect(setCalls).toBe(1)
    // 仅被拖节点对象 set 被调用
    expect(children[25].set).toHaveBeenCalledTimes(1)
    for (let i = 0; i < N; i += 1) {
      if (i === 25) continue
      expect(children[i].set).not.toHaveBeenCalled()
    }
  })

  it('line: 50 节点拖 1 → projectNode 调用 1 次,仅被拖节点 Group set 被调用', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferLinePaint(leafer)
    const nodes = Array.from({ length: N }, (_, i) => lineNode(`l${i}`, 0))
    paint.sync(nodes, ctx())
    vi.clearAllMocks()
    nodes[25] = { ...nodes[25], x: 100 } as MivoCanvasNode
    paint.sync(nodes, ctx())

    expect(projectNode).toHaveBeenCalledTimes(1)
    const children = (leafer as unknown as { children: FakeObj[] }).children
    // 被拖节点 Group 的 set 至少 1 次（group + main）；其余 Group set=0
    expect(children[25].set.mock.calls.length).toBeGreaterThan(0)
    for (let i = 0; i < N; i += 1) {
      if (i === 25) continue
      expect(children[i].set).not.toHaveBeenCalled()
    }
  })

  it('brush: 50 节点拖 1 → projectNode 调用 1 次,仅 1 个对象 set 被调用', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferBrushStampPaint(leafer)
    const nodes = Array.from({ length: N }, (_, i) => brushNode(`b${i}`, 0))
    paint.sync(nodes, ctx())
    vi.clearAllMocks()
    nodes[25] = { ...nodes[25], x: 100 } as MivoCanvasNode
    paint.sync(nodes, ctx())

    expect(projectNode).toHaveBeenCalledTimes(1)
    const children = (leafer as unknown as { children: FakeObj[] }).children
    expect(countSets(children)).toBe(1)
    expect(children[25].set).toHaveBeenCalledTimes(1)
  })

  it('image: 50 节点拖 1 → image 不调 projectNode(走 raw node),仅 1 个对象 set(几何)', async () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferImagePaint(leafer)
    const nodes = Array.from({ length: N }, (_, i) => imageNode(`i${i}`, 0))
    paint.sync(nodes, ctx())
    await flushMicrotasks()
    vi.clearAllMocks()
    nodes[25] = { ...nodes[25], x: 100 } as MivoCanvasNode
    paint.sync(nodes, ctx())

    // image 模块 HD 走 updateGeometry（raw node），不调 projectNode。
    expect(projectNode).not.toHaveBeenCalled()
    const children = (leafer as unknown as { children: FakeObj[] }).children
    // 仅被拖节点对象的 set 被调用（几何 set）；其余 0。
    expect(children[25].set).toHaveBeenCalledTimes(1)
    for (let i = 0; i < N; i += 1) {
      if (i === 25) continue
      expect(children[i].set).not.toHaveBeenCalled()
    }
  })

  it('shape: 全部未变（第二次 sync 同状态）→ projectNode=0, set=0', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferShapePaint(leafer)
    const nodes = Array.from({ length: N }, (_, i) => rectNode(`s${i}`, 0))
    paint.sync(nodes, ctx())
    vi.clearAllMocks()
    // 同状态再 sync 一次
    paint.sync(nodes, ctx())
    expect(projectNode).not.toHaveBeenCalled()
    expect(countSets((leafer as unknown as { children: FakeObj[] }).children)).toBe(0)
  })
})
