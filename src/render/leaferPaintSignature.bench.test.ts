import { describe, expect, it, vi } from 'vitest'

// PR-R2 §12.1 性能替代度量。本仓无 store-to-renderer-sync trace 采集手段
// （bench:collect 是 Playwright e2e，测 frame p95，非 sync() 调用本身）。
// 替代度量：vitest 微基准，mocked leafer-ui，直接测 sync() 调用耗时。
// 对比「拖 1 节点（R2 后，仅 1 node projectNode+set）」vs「全改（≈R2 前，每节点
// projectNode+set）」，验证未变节点跳过带来的 sync 耗时下降。

vi.mock('leafer-ui', () => {
  class FakeUI {
    props: Record<string, unknown> = {}
    set(props: Record<string, unknown>) {
      // 模拟 Leafer 的 merging set（真实 set 触发 paint invalidation，此处只做 JS 侧合并）
      for (const k of Object.keys(props)) this.props[k] = props[k]
    }
    remove() {}
    children: unknown[] = []
    add(child: unknown) {
      this.children.push(child)
    }
  }
  return { Rect: FakeUI, Ellipse: FakeUI, Line: FakeUI, Path: FakeUI, Image: FakeUI, Group: FakeUI }
})

import { createLeaferShapePaint } from './leaferShapePaint'
import type { Leafer } from 'leafer-ui'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'

type FakeObj = { set: (...p: unknown[]) => void; remove: () => void; children: unknown[]; add: (c: unknown) => void }

const makeFakeLeafer = () => {
  const children: FakeObj[] = []
  return { add: (c: FakeObj) => children.push(c), children } as unknown as Leafer & { children: FakeObj[] }
}
const ctx = (): RendererSyncContext => ({ viewport: { x: 0, y: 0, scale: 1 }, selectedNodeIds: new Set(), isPanning: false })
const rectNode = (id: string, x = 0): MivoCanvasNode =>
  ({ id, type: 'markup', status: 'ready', markupKind: 'rect', x, y: 0, width: 100, height: 80, markupFillColor: '#fff', markupStrokeColor: '#000', markupStrokeWidth: 2, markupStrokeStyle: 'solid' }) as unknown as MivoCanvasNode

const N = 1000
const RUNS = 20

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

const measureSync = (paint: ReturnType<typeof createLeaferShapePaint>, nodes: MivoCanvasNode[]): number => {
  const start = performance.now()
  paint.sync(nodes, ctx())
  return performance.now() - start
}

describe('PR-R2 §12.1 sync 微基准（1000 节点）', () => {
  it('拖 1 节点（R2 后）sync p95 远低于全改（≈R2 前）', async () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferShapePaint(leafer)
    const nodes = Array.from({ length: N }, (_, i) => rectNode(`s${i}`, 0))
    paint.sync(nodes, ctx()) // create 一次，建立 entries + signatures

    // R2 后：拖 s500，x 0→100（仅 1 节点签名变）
    const dragOneTimes: number[] = []
    for (let r = 0; r < RUNS; r += 1) {
      const variant = nodes.map((n, i) => (i === 500 ? { ...n, x: 100 + r } : n))
      dragOneTimes.push(measureSync(paint, variant))
    }

    // ≈R2 前：每节点 x 都变（每节点签名都翻 → 全 projectNode+set）
    const allChangedTimes: number[] = []
    for (let r = 0; r < RUNS; r += 1) {
      const variant = nodes.map((n, i) => ({ ...n, x: i + r }))
      allChangedTimes.push(measureSync(paint, variant))
    }

    dragOneTimes.sort((a, b) => a - b)
    allChangedTimes.sort((a, b) => a - b)
    const dragP95 = percentile(dragOneTimes, 95)
    const allP95 = percentile(allChangedTimes, 95)

    console.log(
      `[PR-R2 bench] 1000 nodes, ${RUNS} runs each\n` +
        `  drag-1 (R2 after): p50=${percentile(dragOneTimes, 50).toFixed(3)}ms p95=${dragP95.toFixed(3)}ms\n` +
        `  all-changed (≈R2 before): p50=${percentile(allChangedTimes, 50).toFixed(3)}ms p95=${allP95.toFixed(3)}ms\n` +
        `  ratio (all/drag p95): ${(allP95 / Math.max(dragP95, 0.001)).toFixed(1)}x`,
    )
    // 写文件供报告读取（console.log 被 rtk 摘要器剥离；tsconfig types 不含 node，
    // vitest runtime 提供 fs，@ts-expect-error 抑制 tsc2591）
    // @ts-expect-error tsconfig types 仅 vite/client，node:fs 由 vitest runtime 解析
    const fs = await import('node:fs/promises')
    await fs.writeFile(
      '/tmp/pr-r2-bench-result.json',
      JSON.stringify({
        nodes: N,
        runs: RUNS,
        dragOneP50Ms: percentile(dragOneTimes, 50),
        dragOneP95Ms: dragP95,
        allChangedP50Ms: percentile(allChangedTimes, 50),
        allChangedP95Ms: allP95,
      }),
    )

    // 契约：拖 1 节点 sync p95 ≤ 4ms（SC §12.1），且显著低于全改。
    expect(dragP95).toBeLessThan(4)
    expect(dragP95).toBeLessThan(allP95)
  })
})
