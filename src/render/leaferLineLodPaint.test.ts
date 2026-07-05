import { describe, expect, it, vi } from 'vitest'

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
  class FakeLine extends FakeUI {}
  class FakeRect extends FakeUI {}
  class FakeGroup extends FakeUI {
    children: FakeUI[] = []
    add(child: FakeUI) {
      this.children.push(child)
    }
  }
  return { Line: FakeLine, Rect: FakeRect, Group: FakeGroup }
})

vi.mock('./engineLodMode', () => ({
  engineLodMode: 'on',
  engineLodThresholdPx: 32,
  isEngineLodRequested: true,
}))

import { createLeaferLinePaint, lineLodPaintPropsFor } from './leaferLinePaint'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'
import type { Leafer } from 'leafer-ui'

type FakeUI = { props: Record<string, unknown>; removed: boolean }
type FakeLeafer = Leafer & { children: FakeUI[] }

const makeFakeLeafer = (): FakeLeafer => {
  const children: FakeUI[] = []
  return {
    add: (child: FakeUI) => children.push(child),
    children,
  } as unknown as FakeLeafer
}

const ctx = (scale: number): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
})

const arrowNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'a1',
    type: 'markup',
    status: 'ready',
    markupKind: 'arrow',
    x: 40,
    y: 60,
    width: 240,
    height: 80,
    text: 'flow',
    ...opts,
  }) as unknown as MivoCanvasNode

describe('leafer line LOD — 全景态降级纯 Rect', () => {
  it('below threshold uses one Rect, not Group + line/head children', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferLinePaint(leafer)

    paint.sync([arrowNode()], ctx(0.08))

    expect(paint.paintedCount()).toBe(1)
    expect(leafer.children.length).toBe(1)
    expect(leafer.children[0].props).toMatchObject({
      x: 40,
      y: 60,
      width: 240,
      height: 80,
      strokeWidth: 0,
      origin: 'center',
    })
    expect('children' in leafer.children[0]).toBe(false)
  })

  it('crossing threshold swaps LOD Rect back to HD Group', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferLinePaint(leafer)

    paint.sync([arrowNode()], ctx(0.08))
    const lodRect = leafer.children[0]
    const counts = paint.sync([arrowNode()], ctx(0.2))

    expect(counts).toEqual({ created: 0, updated: 1, deleted: 0 })
    expect(lodRect.removed).toBe(true)
    expect(leafer.children.length).toBe(2)
    expect('children' in leafer.children[1]).toBe(true)
  })

  it('LOD props keep rotated footprint and zIndex', () => {
    const props = lineLodPaintPropsFor(
      arrowNode({ transform: { x: 40, y: 60, width: 240, height: 80, rotation: 30 } }),
      42,
    )
    expect(props.rotation).toBe(30)
    expect(props.origin).toBe('center')
    expect(props.zIndex).toBe(42)
  })
})
