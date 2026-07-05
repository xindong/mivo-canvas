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
  class FakeRect extends FakeUI {}
  class FakeEllipse extends FakeUI {}
  return { Rect: FakeRect, Ellipse: FakeEllipse }
})

vi.mock('./engineLodMode', () => ({
  engineLodMode: 'on',
  engineLodThresholdPx: 32,
  isEngineLodRequested: true,
}))

import { createLeaferShapePaint } from './leaferShapePaint'
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

const noteNode = (opts: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'n1',
    type: 'markup',
    status: 'ready',
    markupKind: 'note',
    x: 10,
    y: 20,
    width: 200,
    height: 120,
    ...opts,
  }) as unknown as MivoCanvasNode

describe('leafer shape LOD — 全景态降级纯 Rect', () => {
  it('below threshold strips note shadow/border complexity', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferShapePaint(leafer)

    paint.sync([noteNode()], ctx(0.1))

    expect(leafer.children[0].props).toMatchObject({
      x: 10,
      y: 20,
      width: 200,
      height: 120,
      strokeWidth: 0,
      origin: 'center',
    })
    expect('shadow' in leafer.children[0].props).toBe(false)
    expect('dashPattern' in leafer.children[0].props).toBe(false)
  })

  it('crossing threshold swaps LOD Rect back to HD note props', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferShapePaint(leafer)

    paint.sync([noteNode()], ctx(0.1))
    const lodRect = leafer.children[0]
    const counts = paint.sync([noteNode()], ctx(0.3))

    expect(counts).toEqual({ created: 0, updated: 1, deleted: 0 })
    expect(lodRect.removed).toBe(true)
    expect(leafer.children[1].props.shadow).toEqual({ x: 0, y: 12, blur: 30, color: 'rgba(35, 35, 35, 0.14)' })
  })
})
