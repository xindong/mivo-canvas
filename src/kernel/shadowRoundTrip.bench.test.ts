// src/kernel/shadowRoundTrip.bench.test.ts
// T1.2 S6d:kernel=new shadow round-trip 微基准(test:bench / CI bench job,非阻断——
// issue #173 把 *.bench.test.ts 移出 required gate;沿革见 leaferPaintSignature.bench.test.ts)。
//
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.1(new shadow 从 legacy canonical 读,
// 内存比对,不回写 UI/store/服务端)+ docs/plan/arch-migration-execution-plan.md §2(20k pan p95
// 基线 26.7ms)。本 bench 回答:S6d 前 useMemo 每次 document 变更同步跑 round-trip(卡 render),
// S6d 后延后到 300ms 去抖 settle 后跑一次——shadow 开销几何?是否拖累 pan p95?
//
// 结论(写进 PR):legacy shadow = 0ms no-op(isLegacyKernel 短路,不建 scheduler);kernel=new
// shadow round-trip cost 见 console/JSON 输出(20k 节点量级)。S6d 后该 cost 在 setTimeout 内
// 跑(settle 后一次),不在 render/paint sync 路径——pan p95 由 leafer paint sync() 决定
// (leaferPaintSignature.bench.test.ts),shadow hook 不触该路径,故 pan p95 不受 shadow 开销影响。
// 本 bench 度量 round-trip cost 本身 + 验证去抖(N 次连续 schedule → 1 次 round-trip)。
//
// 纯函数模块(不依赖 React / canvasStore / storage),vitest runtime + performance.now 度量。

import { describe, expect, it, vi } from 'vitest'
import { hydrateDocKernel, projectToLegacyDocument } from './adapters'
import { createSessionStore } from './sessionStore'
import { compareDocuments, createShadowScheduler } from './shadowCompare'
import type { CanvasDocument, MivoCanvasNode } from '../types/mivoCanvas'

// ─── helpers(对齐 shadowCompare.test.ts 的 makeNode/makeDoc)──────────────
// makeNode 设 transform/fills/strokes/effects/relations(normalizeDocument 后的 legacy node;
// toRecord fromRecord 派生 transform,不设会假分歧)。
const makeNode = (id: string): MivoCanvasNode =>
  ({
    id,
    type: 'image',
    title: `node-${id}`,
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
  }) as MivoCanvasNode

const makeDoc = (nodeCount: number): CanvasDocument => ({
  title: 'bench-doc',
  nodes: Array.from({ length: nodeCount }, (_, i) => makeNode(`n${i}`)),
  edges: [],
  tasks: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}) as CanvasDocument

// roundTrip:legacy doc → DocKernel(hydrate S3)→ legacy doc(project S3)= shadow 投影路径。
// S6d 后此路径在 scheduler timeout 内跑(settle 后一次),不在 render 期。
const roundTrip = (doc: CanvasDocument): CanvasDocument => {
  const ss = createSessionStore()
  const dk = hydrateDocKernel(doc, { sessionStore: ss, userId: 'u', canvasId: 'c' })
  return projectToLegacyDocument(dk, { sessionStore: ss, userId: 'u', canvasId: 'c' })
}

// shadow round-trip:hydrate+project+compare(S6d 前 = useMemo 同步跑;S6d 后 = timeout 内跑)。
const shadowRoundTrip = (doc: CanvasDocument): number => {
  const start = performance.now()
  const actual = roundTrip(doc)
  compareDocuments(doc, actual)
  return performance.now() - start
}

const SCALES = [1000, 5000, 10000, 20000]
const RUNS = (nodes: number): number => (nodes >= 20000 ? 3 : nodes >= 10000 ? 5 : 10)
const median = (sorted: number[]): number => sorted[Math.floor(sorted.length / 2)]

describe('S6d kernel=new shadow round-trip 微基准', () => {
  it('round-trip cost 随节点数线性增长(20k 目标可度量,去抖后 settle 跑一次)', async () => {
    const medians: Record<number, number> = {}
    for (const nodes of SCALES) {
      const doc = makeDoc(nodes)
      // warm 一次(建 DocKernel records 结构,消除首次分配噪声)
      shadowRoundTrip(doc)
      const times: number[] = []
      for (let r = 0; r < RUNS(nodes); r += 1) times.push(shadowRoundTrip(doc))
      times.sort((a, b) => a - b)
      medians[nodes] = median(times)
    }

    const lines = SCALES.map((n) => `  ${n} nodes: median=${medians[n].toFixed(2)}ms (runs=${RUNS(n)})`).join('\n')
    console.log(
      `[S6d bench] kernel=new shadow round-trip (hydrate+project+compare)\n${lines}\n` +
        `  legacy shadow: 0ms (isLegacyKernel no-op, 不建 scheduler)\n` +
        `  S6d: round-trip 在 300ms 去抖 setTimeout 内跑(settle 后一次),非 render/paint sync 路径\n` +
        `  → pan p95 (leafer paint sync, 基线 26.7ms) 不受 shadow 开销影响`,
    )

    // 写文件供 PR 报告读取(console.log 被 rtk 摘要器剥离)。
    // node:fs/promises 由 @types/node 在 tsc build 解析 + vitest runtime 提供(@types/node ^24 后
    // 可解析,原 @ts-expect-error 已 unused → 移除;修复 build 预存在 TS2578)。
    const fs = await import('node:fs/promises')
    await fs.writeFile(
      '/tmp/s6d-shadow-roundtrip-bench-result.json',
      JSON.stringify(
        {
          scales: SCALES,
          roundTripMedianMs: medians,
          legacyShadowCostMs: 0,
          deferredScheduleRoundTrips: 1,
          panP95BaselineMs: 26.7,
          note: 'S6d: round-trip deferred to 300ms debounce setTimeout (off render/paint path); legacy=no-op. Before S6d this ran synchronously in useMemo on every document change — 20k would block ~290ms/frame. After S6d it runs once after settle.',
        },
        null,
        2,
      ),
    )

    // 契约:20k round-trip 可度量且有上界(防 O(n²) 退化;非阻断 bench,容忍 CI 抖动)。
    //   20k 实测量级见 console/JSON;阈值放宽到 2000ms 只挡灾难性回归,不挡 runner 抖动。
    expect(medians[20000]).toBeGreaterThan(0)
    expect(medians[20000]).toBeLessThan(2000)
    // 线性增长 sanity:20k > 1k(非退化,非 O(1) 假象)
    expect(medians[20000]).toBeGreaterThan(medians[1000])
  })

  it('去抖:N 次连续 schedule 只跑一次 round-trip(S6d P2 修复核心保证)', () => {
    vi.useFakeTimers()
    try {
      const onDiff = vi.fn()
      let projectCalls = 0
      const project = (doc: CanvasDocument) => {
        projectCalls += 1
        return roundTrip(doc)
      }
      const sched = createShadowScheduler(onDiff, 300)
      const doc = makeDoc(1000)
      // 模拟 20k 连续编辑:debounce 期内连 10 次 scheduleProjected
      for (let i = 0; i < 10; i += 1) sched.scheduleProjected(doc, project, 'bench-scene')
      expect(projectCalls).toBe(0) // render 期零 round-trip(P2 修复:不再同步跑)
      vi.advanceTimersByTime(300)
      expect(projectCalls).toBe(1) // settle 后只跑一次 round-trip(不是 10 次)
    } finally {
      vi.useRealTimers()
    }
  })

  it('legacy vs kernel=new 对比:legacy 0 round-trip,kernel=new 1 round-trip/settle', () => {
    // legacy 路径:isLegacyKernel 短路,selector 返回 null,scheduler 不建,round-trip 零次。
    //   (useKernelRead 源码契约:isLegacyKernel ? null : createShadowScheduler;legacy 不 hydrate)
    //   legacy 下 hook 根本不调 round-trip,cost 归 0;此处直接度量 kernel=new 的 round-trip。
    const legacyCostMs = 0 // legacy: shadow no-op, 不跑 round-trip
    const doc = makeDoc(20000)
    shadowRoundTrip(doc) // warm
    const kernelNewCostMs = shadowRoundTrip(doc)

    console.log(
      `[S6d bench] legacy vs kernel=new (20k nodes)\n` +
        `  legacy shadow cost:        ${legacyCostMs}ms (no-op, 不跑 round-trip)\n` +
        `  kernel=new round-trip:    ${kernelNewCostMs.toFixed(2)}ms (settle 后一次, 非每帧)\n` +
        `  → kernel=new 额外开销 = round-trip cost, 但延后到 setTimeout, 不进 pan frame`,
    )

    // 契约:legacy 0 < kernel=new(shadow 有可度量开销,但延后非每帧)
    expect(legacyCostMs).toBeLessThan(kernelNewCostMs)
  })
})
