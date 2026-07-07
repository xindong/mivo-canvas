import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock leafer-ui with fakes that record props + track add/remove (no real canvas).
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
  class FakeGroup extends FakeUI {
    children: FakeUI[] = []
    add(child: FakeUI) {
      this.children.push(child)
    }
  }
  return { Rect: FakeRect, Group: FakeGroup }
})

// Mock canvasStore with a controllable fake so the fx subscribe + getState().nodes
// are deterministic. The fx only uses subscribe((state, prev) => …) + getState().
vi.mock('../store/canvasStore', () => {
  type S = {
    lastPlacedStampId: string | undefined
    nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>
  }
  let state: S = { lastPlacedStampId: undefined, nodes: [] }
  const listeners = new Set<(s: S, prev: S) => void>()
  return {
    useCanvasStore: {
      subscribe: (l: (s: S, prev: S) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      getState: () => state,
      setState: (patch: Partial<S>) => {
        const prev = state
        state = { ...state, ...patch }
        listeners.forEach((l) => l(state, prev))
      },
    },
  }
})

// Mock debugLogStore to silence warn noise.
vi.mock('../store/debugLogStore', () => ({
  debugLogger: { warn: () => {}, log: () => {}, error: () => {} },
}))

// Imports AFTER vi.mock (hoisted) so modules see the mocked deps.
import { createLeaferStampFx } from './leaferStampFx'
import type { StampObjectHandle } from './leaferBrushStampPaint'
import { Rect, Group } from 'leafer-ui'
import { useCanvasStore } from '../store/canvasStore'
import fxModuleSource from './leaferStampFx.ts?raw'

type FakeUI = {
  props: Record<string, unknown>
  removed: boolean
  set: (p: Record<string, unknown>) => void
  remove: () => void
  children?: FakeUI[]
}

// The mocked store exposes a custom setState (real Zustand doesn't) — cast for tests.
const store = useCanvasStore as unknown as {
  setState: (patch: {
    lastPlacedStampId?: string
    nodes?: Array<{ id: string; x: number; y: number; width: number; height: number }>
  }) => void
}

const STAMP_NODE = { id: 's1', x: 100, y: 100, width: 80, height: 80 }

const makeHandle = (): StampObjectHandle => {
  const sticker = new Rect({ x: 100, y: 100, width: 80, height: 80, rotation: 0, origin: 'center' }) as unknown as FakeUI
  const group = new Group() as unknown as FakeUI & { children: FakeUI[]; add: (c: FakeUI) => void }
  return {
    nodeId: 's1',
    sticker: sticker as unknown as StampObjectHandle['sticker'],
    group: group as unknown as StampObjectHandle['group'],
  }
}

const makeClock = () => {
  let t = 0
  const queue = new Map<number, () => void>()
  let id = 0
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    raf: (cb: () => void) => {
      const h = ++id
      queue.set(h, cb)
      return h
    },
    cancelRaf: (h: number) => {
      queue.delete(h)
    },
    step: () => {
      // run one frame: drain pending callbacks; a tick scheduling the next rAF
      // re-queues after the drain (copy→clear so re-entries are next-frame).
      const pending = [...queue.values()]
      queue.clear()
      for (const cb of pending) cb()
    },
    pending: () => queue.size,
  }
}

const setLastPlaced = (id: string | undefined) => store.setState({ lastPlacedStampId: id })
const setNodes = (nodes: typeof STAMP_NODE[]) => store.setState({ nodes })

describe('createLeaferStampFx — V2 stamp drop animation', () => {
  let clock: ReturnType<typeof makeClock>

  beforeEach(() => {
    clock = makeClock()
    setNodes([STAMP_NODE])
    setLastPlaced(undefined)
    // Stub a minimal window so the dev-only probe (guarded by typeof window) is
    // exercised — vitest runs in Node by default (no jsdom in this project).
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      __MIVO_STAMP_FX__: undefined,
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('触发:lastPlacedStampId 出现 → play(pop 作用于 sticker,8 条 ray 入 Group,probe 暴露 active)', () => {
    const handle = makeHandle()
    const getStampObject = vi.fn((id: string) => (id === 's1' ? handle : undefined))
    const fx = createLeaferStampFx({ getStampObject, now: clock.now, raf: clock.raf, cancelRaf: clock.cancelRaf })

    setLastPlaced('s1') // store 通知 fx
    clock.step() // 第一帧 (t=0)
    const sticker = handle.sticker as unknown as FakeUI
    expect(sticker.props.scaleX as number).toBeCloseTo(0.6, 5)
    expect(sticker.props.scaleY as number).toBeCloseTo(0.6, 5)
    const group = handle.group as unknown as FakeUI & { children: FakeUI[] }
    expect(group.children.length).toBe(8)
    const probe = window.__MIVO_STAMP_FX__
    expect(probe?.getActive().find((a) => a.nodeId === 's1')).toBeTruthy()
    expect(probe?.getLastPlayed()?.nodeId).toBe('s1')

    fx.dispose()
  })

  it('动画曲线:60% 处 scale≈1.12(峰值),pop 末 scale=1,420ms 后 ray 销毁 + active 清空', () => {
    const handle = makeHandle()
    const fx = createLeaferStampFx({ getStampObject: () => handle, now: clock.now, raf: clock.raf, cancelRaf: clock.cancelRaf })

    setLastPlaced('s1')
    clock.step() // t=0
    const group = handle.group as unknown as FakeUI & { children: FakeUI[] }
    const rays = [...group.children] // 捕获 8 条 ray（fake remove 不从数组弹出，断言 removed）
    expect(rays.length).toBe(8)
    // 推进到 60% pop (156ms) — 峰值 ≈1.12
    clock.advance(156)
    clock.step()
    expect((handle.sticker as unknown as FakeUI).props.scaleX as number).toBeCloseTo(1.12, 1)
    // 推进到 pop 末 (260ms) — scale 回到 1
    clock.advance(104)
    clock.step()
    expect((handle.sticker as unknown as FakeUI).props.scaleX as number).toBeCloseTo(1, 5)
    expect((handle.sticker as unknown as FakeUI).props.opacity).toBe(1)
    // 推进到 impact 末 (420ms) — finalize：ray 全部 remove、active 清空
    clock.advance(160)
    clock.step()
    expect(rays.every((r) => r.removed)).toBe(true)
    expect(window.__MIVO_STAMP_FX__?.getActive().length).toBe(0)
    expect(clock.pending()).toBe(0) // 末帧后不再排 rAF

    fx.dispose()
  })

  it('retry:对象未创建时 after-sync 重试一次(下一 frame)成功 play', () => {
    const handle = makeHandle()
    let available = false
    const getStampObject = vi.fn((id: string) => (available && id === 's1' ? handle : undefined))
    const fx = createLeaferStampFx({ getStampObject, now: clock.now, raf: clock.raf, cancelRaf: clock.cancelRaf })

    setLastPlaced('s1') // 首次查不到 → 排 retry rAF
    expect(getStampObject).toHaveBeenCalledWith('s1')
    expect(clock.pending()).toBe(1)
    // 下一 frame 前让对象可用 → retry 命中 → play 又排了 tick rAF
    available = true
    clock.step() // 运行 retry 回调（调用 play，play 内排 tick）
    expect(getStampObject.mock.calls.length).toBe(2)
    expect(clock.pending()).toBe(1) // tick 待跑
    clock.step() // 运行 tick → pop 起步
    expect((handle.sticker as unknown as FakeUI).props.scaleX as number).toBeCloseTo(0.6, 5)

    fx.dispose()
  })

  it('undo:动画中节点被删(getStampObject 返回 undefined) → tick 取消 rAF + 清 active', () => {
    const handle = makeHandle()
    let live = true
    const fx = createLeaferStampFx({
      getStampObject: () => (live ? handle : undefined),
      now: clock.now,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
    })

    setLastPlaced('s1')
    clock.step() // t=0, pop 起步, 8 rays
    expect((handle.group as unknown as FakeUI & { children: FakeUI[] }).children.length).toBe(8)
    expect(clock.pending()).toBe(1)
    // undo：节点删除 → paint 模块 dispose 了 entry → getStampObject 返回 undefined
    live = false
    clock.advance(50)
    clock.step() // tick 内 stale 检查命中 → cleanup
    expect(clock.pending()).toBe(0)
    expect(window.__MIVO_STAMP_FX__?.getActive().length).toBe(0)

    fx.dispose()
  })

  it('unmount:dispose() 清 rAF + 清 active + 清 probe + 取消订阅', () => {
    const handle = makeHandle()
    const fx = createLeaferStampFx({ getStampObject: () => handle, now: clock.now, raf: clock.raf, cancelRaf: clock.cancelRaf })

    setLastPlaced('s1')
    clock.step()
    expect(window.__MIVO_STAMP_FX__?.getActive().length).toBe(1)
    expect(clock.pending()).toBe(1)

    fx.dispose()
    expect(clock.pending()).toBe(0)
    expect(window.__MIVO_STAMP_FX__).toBeUndefined()
    // 订阅已取消：再触发 lastPlacedStampId 不再 play
    setLastPlaced('s1')
    clock.step()
    expect(window.__MIVO_STAMP_FX__).toBeUndefined()
  })

  it('D5 硬约束:模块源不订阅 Leafer events、不读 zoomLayer、不读 Leafer 几何回写', () => {
    expect(fxModuleSource).not.toMatch(/\.on\(/)
    expect(fxModuleSource).not.toMatch(/zoomLayer/)
    expect(fxModuleSource).not.toMatch(/worldTransform|getBounds|__world/)
  })
})

describe('createLeaferStampFx — pop 曲线对齐 CSS stamp-pop (cubic-bezier(0.34,1.56,0.64,1))', () => {
  it('overshoot:峰值 > 1.12（back-out 在 0→60% 段内越过终点）', () => {
    const handle = makeHandle()
    const clock = makeClock()
    const fx = createLeaferStampFx({ getStampObject: () => handle, now: clock.now, raf: clock.raf, cancelRaf: clock.cancelRaf })
    setNodes([STAMP_NODE])
    setLastPlaced('s1')
    clock.step() // t=0

    let peak = 0
    for (let ms = 8; ms <= 156; ms += 8) {
      clock.advance(8)
      clock.step()
      const s = (handle.sticker as unknown as FakeUI).props.scaleX as number
      if (s > peak) peak = s
    }
    // back-out y1=1.56 让 lerp(0.6,1.12, easedT>1) 越过 1.12
    expect(peak).toBeGreaterThan(1.12)
    fx.dispose()
  })
})
