// src/kernel/shadowCompare.test.ts
// T1.2 S5:shadow compare 纯函数单测(比对 + 定位 + 去抖护栏)。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.1(B 阶段 new shadow 内存比对,不回写)+
// §4.7.1(契约测试:不读空派生缓存、比对走内存)。
//
// 纯函数模块(不依赖 React / canvasStore / storage)——runtime + fake-timer 单测,无需 React
// hook render harness(项目无 @testing-library/react、无 jsdom,见
// src/canvas/useNodeTransform.contract.test.ts 说明)。hook 行为(去抖/比对)由本文件覆盖;
// hook 接缝(legacy no-op / 不读 storage)由 useKernelRead.contract.test.ts 源码契约覆盖。

import { describe, expect, it, vi } from 'vitest'
import type { CanvasDocument, MivoCanvasNode } from '../types/mivoCanvas'
import { hydrateDocKernel, projectToLegacyDocument } from './adapters'
import { createSessionStore } from './sessionStore'
import { compareDocuments, createShadowScheduler, deepDiff } from './shadowCompare'

// ─── helpers ──────────────────────────────────────────────────────────
// makeNode 设 transform/fills/strokes/effects/relations(模拟 normalizeDocument 后的 legacy
// node;不设则 doc 无 transform vs projected 有 → 假分歧,transform 是 K40 toRecord 派生 fromRecord 设)。
const makeNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    id: 'n1',
    type: 'image',
    title: 'Image',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    transform: { x: 10, y: 20, width: 300, height: 200, rotation: 0 },
    fills: [],
    strokes: [],
    effects: [],
    relations: {},
    status: 'ready',
    ...overrides,
  } as MivoCanvasNode)

const makeDoc = (overrides: Partial<CanvasDocument> & { nodes?: MivoCanvasNode[] } = {}): CanvasDocument =>
  ({
    title: 'doc-title',
    nodes: [],
    edges: [],
    tasks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  } as CanvasDocument)

// roundTrip:legacy doc → DocKernel(hydrate S3)→ legacy doc(project S3)= shadow 投影路径。
const roundTrip = (doc: CanvasDocument): CanvasDocument => {
  const ss = createSessionStore()
  const dk = hydrateDocKernel(doc, { sessionStore: ss, userId: 'u', canvasId: 'c' })
  return projectToLegacyDocument(dk, { sessionStore: ss, userId: 'u', canvasId: 'c' })
}

// ─── deepDiff(纯函数:定位单元)─────────────────────────────────────────
describe('S5 deepDiff — 首个不一致点定位', () => {
  it('primitive 一致 → null', () => {
    expect(deepDiff('a', 'a', 'p')).toBeNull()
  })
  it('primitive 分歧 → {fieldPath, expected, actual}', () => {
    expect(deepDiff('a', 'b', 'p')).toEqual({ fieldPath: 'p', expected: 'a', actual: 'b' })
  })
  it('emptyish 容差:undefined ↔ [] 视为一致', () => {
    expect(deepDiff(undefined, [], 'p')).toBeNull()
    expect(deepDiff([], undefined, 'p')).toBeNull()
    expect(deepDiff(undefined, {}, 'p')).toBeNull()
  })
  it('嵌套对象:递归找首个不一致', () => {
    const diff = deepDiff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }, 'p')
    expect(diff).toEqual({ fieldPath: 'p.a.c', expected: 2, actual: 3 })
  })
  it('skipKeys 跳过指定 key', () => {
    const diff = deepDiff({ status: 'a', x: 1 }, { status: 'b', x: 1 }, 'p', new Set(['status']))
    expect(diff).toBeNull()
  })
})

// ─── compareDocuments(比对 + 定位 + 已知非 round-trip 跳过)───────────────
describe('S5 compareDocuments — 比对 + 定位 + 已知非 round-trip 跳过', () => {
  it('一致(round-trip 无损,status 跳过 + emptyish 容差)→ null', () => {
    const doc = makeDoc({ nodes: [makeNode({ id: 'n1' })] })
    // image 无 asset → projected.status=deriveStatus='failed',原 status='ready' → status 跳过
    expect(roundTrip(doc).nodes[0].status).toBe('failed')
    expect(doc.nodes[0].status).toBe('ready')
    expect(compareDocuments(doc, roundTrip(doc))).toBeNull()
  })

  it('分歧(node.title 篡改)→ 定位 record id + field path', () => {
    const doc = makeDoc({ nodes: [makeNode({ id: 'n1', title: 'orig' })] })
    const projected = roundTrip(doc)
    projected.nodes[0].title = 'TAMPERED'
    const diff = compareDocuments(doc, projected)
    expect(diff).not.toBeNull()
    expect(diff!.recordId).toBe('n1')
    expect(diff!.fieldPath).toBe('nodes[0].title')
    expect(diff!.expected).toBe('orig')
    expect(diff!.actual).toBe('TAMPERED')
  })

  it('status 跳过(generating ai-slot vs fallback failed → 不 warn)', () => {
    // fromRecord deriveStatus(无 asset)='failed';原 status='generating' → 已知派生限制,跳过
    const doc = makeDoc({ nodes: [makeNode({ id: 'slot1', type: 'ai-slot', status: 'generating' })] })
    const projected = roundTrip(doc)
    expect(projected.nodes[0].status).toBe('failed')
    expect(doc.nodes[0].status).toBe('generating')
    expect(compareDocuments(doc, projected)).toBeNull()
  })

  it('emptyish 容差(effects undefined vs [] → 一致)', () => {
    const doc = makeDoc({ nodes: [makeNode({ id: 'n1', effects: undefined })] })
    const projected = roundTrip(doc)
    expect(projected.nodes[0].effects).toEqual([]) // fromRecord 规范成 []
    expect(doc.nodes[0].effects).toBeUndefined()
    expect(compareDocuments(doc, projected)).toBeNull()
  })

  it('selection 分歧 → 定位 <selection>', () => {
    const doc = makeDoc({ nodes: [makeNode({ id: 'n1' })], selectedNodeIds: ['n1'] })
    const projected = roundTrip(doc)
    projected.selectedNodeIds = ['n2']
    const diff = compareDocuments(doc, projected)
    expect(diff!.recordId).toBe('<selection>')
    expect(diff!.fieldPath).toBe('selectedNodeIds')
  })

  it('meta.title 分歧 → 定位 <meta>', () => {
    const doc = makeDoc({ title: 'orig' })
    const projected = roundTrip(doc)
    projected.title = 'other'
    const diff = compareDocuments(doc, projected)
    expect(diff!.recordId).toBe('<meta>')
    expect(diff!.fieldPath).toBe('title')
  })

  it('nodes.length 分歧 → 定位', () => {
    const doc = makeDoc({ nodes: [makeNode({ id: 'n1' })] })
    const projected = roundTrip(doc)
    projected.nodes = []
    const diff = compareDocuments(doc, projected)
    expect(diff!.fieldPath).toBe('nodes.length')
    expect(diff!.expected).toBe(1)
    expect(diff!.actual).toBe(0)
  })

  it('meta.updatedAt 跳过(DocKernel hydrate bump 非一致 → 不 warn)', () => {
    const doc = makeDoc({ nodes: [makeNode({ id: 'n1' })], updatedAt: '2026-01-02T00:00:00.000Z' })
    const projected = roundTrip(doc)
    // DocKernel hydrate bump updatedAt → projected.updatedAt != doc.updatedAt
    expect(projected.updatedAt).not.toBe(doc.updatedAt)
    expect(compareDocuments(doc, projected)).toBeNull()
  })

  it('edges 分歧 → 定位 edge id', () => {
    const edge = { id: 'e1', from: 'a', to: 'b', type: 'generate' as const, prompt: 'p', createdAt: 1 }
    const doc = makeDoc({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })], edges: [edge] })
    const projected = roundTrip(doc)
    projected.edges[0].prompt = 'TAMPERED'
    const diff = compareDocuments(doc, projected)
    expect(diff!.recordId).toBe('e1')
    expect(diff!.fieldPath).toBe('edges[0].prompt')
  })
})

// ─── createShadowScheduler(去抖护栏)──────────────────────────────────
describe('S5 createShadowScheduler — 去抖护栏(Lead 补充要求 1)', () => {
  it('去抖:连续 schedule 只比对一次(settle 后)', () => {
    vi.useFakeTimers()
    try {
      const onDiff = vi.fn()
      const sched = createShadowScheduler(onDiff, 300)
      const doc = makeDoc({ nodes: [makeNode({ id: 'n1', title: 'a' })] })
      const projected = roundTrip(doc)
      projected.nodes[0].title = 'b' // 分歧
      // 连续三次(模拟 20k 拖拽连击):debounce 期内只 reset timer,不触发
      sched.schedule(doc, projected, 'scene1')
      sched.schedule(doc, projected, 'scene1')
      sched.schedule(doc, projected, 'scene1')
      expect(onDiff).not.toHaveBeenCalled()
      vi.advanceTimersByTime(299)
      expect(onDiff).not.toHaveBeenCalled() // 299ms 仍未到 300
      vi.advanceTimersByTime(2) // 总 301ms → settle
      expect(onDiff).toHaveBeenCalledTimes(1) // 只一次
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel:清未触发的比对(effect cleanup 语义)', () => {
    vi.useFakeTimers()
    try {
      const onDiff = vi.fn()
      const sched = createShadowScheduler(onDiff, 300)
      const doc = makeDoc({ nodes: [makeNode({ id: 'n1', title: 'a' })] })
      const projected = roundTrip(doc)
      projected.nodes[0].title = 'b'
      sched.schedule(doc, projected, 'scene1')
      sched.cancel()
      vi.advanceTimersByTime(1000)
      expect(onDiff).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('分歧定位:onDiff 收到 finding(record id + field path + sceneId)', () => {
    vi.useFakeTimers()
    try {
      const onDiff = vi.fn()
      const sched = createShadowScheduler(onDiff, 300)
      const doc = makeDoc({ nodes: [makeNode({ id: 'n1', title: 'a' })] })
      const projected = roundTrip(doc)
      projected.nodes[0].title = 'b'
      sched.schedule(doc, projected, 'sceneX')
      vi.advanceTimersByTime(300)
      expect(onDiff).toHaveBeenCalledTimes(1)
      const [finding, sid] = onDiff.mock.calls[0]
      expect(finding.recordId).toBe('n1')
      expect(finding.fieldPath).toBe('nodes[0].title')
      expect(finding.expected).toBe('a')
      expect(finding.actual).toBe('b')
      expect(sid).toBe('sceneX')
    } finally {
      vi.useRealTimers()
    }
  })

  it('一致:onDiff 不调(shadow 静默)', () => {
    vi.useFakeTimers()
    try {
      const onDiff = vi.fn()
      const sched = createShadowScheduler(onDiff, 300)
      const doc = makeDoc({ nodes: [makeNode({ id: 'n1' })] })
      sched.schedule(doc, roundTrip(doc), 's')
      vi.advanceTimersByTime(300)
      expect(onDiff).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('默认 debounce = SHADOW_DEBOUNCE_MS(300)', () => {
    vi.useFakeTimers()
    try {
      const onDiff = vi.fn()
      const sched = createShadowScheduler(onDiff) // 默认 300
      const doc = makeDoc({ nodes: [makeNode({ id: 'n1', title: 'a' })] })
      const projected = roundTrip(doc)
      projected.nodes[0].title = 'b'
      sched.schedule(doc, projected, 's')
      vi.advanceTimersByTime(299)
      expect(onDiff).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onDiff).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
