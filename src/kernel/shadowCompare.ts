// src/kernel/shadowCompare.ts
// T1.2 S5:kernel=new shadow compare 纯函数(比对 + 定位 + 去抖护栏)。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.1(B 阶段 new shadow 从 legacy canonical
// 读,内存比对,不回写)+ §4.7.1(契约测试:不读空派生缓存、比对走内存)。
//
// 纯函数模块(不依赖 React / canvasStore / storage)——可 fake-timer + runtime 单测,无需
// React hook render harness(项目无 @testing-library/react、无 jsdom,见
// src/canvas/useNodeTransform.contract.test.ts 说明)。useKernelRead hook 薄封装调本模块。
//
// 设计(Lead 裁决 A+(1),2026-07-10):
// - compareDocuments:legacy canonical(expected,canvasStore 输出)vs shadow 投影(actual,
//   DocKernel round-trip via S3 adapters)。逐 nodes/edges/selection/meta 比,跳过已知非
//   round-trip 项(node.status fallback 派生;meta.updatedAt DocKernel bump;tasks:[] DP-8)。
//   返回首个不一致点(record id + 字段路径 + 期望/实际),供 debugLogger.warn 定位排查。
// - createShadowScheduler:去抖比对器(连续 schedule 只在 settle 后比对一次),避免 ?kernel=new
//   下 20k 连续重 hydrate 卡交互(Lead 补充要求 1);护栏纯函数 + fake timer 单测。

import type { CanvasDocument } from '../types/mivoCanvas'

// 比对去抖:文档变更 settle 后比对一次,避免 ?kernel=new 下 20k 连续重 hydrate 卡交互。
// 300ms 覆盖典型拖拽/连击的 settle 窗口;更大值更省但分歧发现更晚。
export const SHADOW_DEBOUNCE_MS = 300

// node 级已知非 round-trip 字段(比对时跳过,避免 shadow 噪声 warn):
// - status:D24 派生,mapping.fromRecord 用 fallback(asset/url→ready,无→failed),S1 无 task
//   上下文无法派生 generating/queued(真实派生在 tasks registry);原 node.status 可能与 fallback
//   不一致,这是已知派生限制非 mapping bug。
const NODE_SKIP_KEYS = new Set<string>(['status'])

export type ShadowDiff = {
  recordId: string
  fieldPath: string
  expected: unknown
  actual: unknown
}

/** emptyish:undefined / null / 空数组 / 空对象。双方 emptyish 视为一致(normalize 容差,
 * 避免 fromRecord 把 undefined effects 规范成 [] 触发假分歧)。 */
const isEmptyish = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && v !== null && Object.keys(v).length === 0)

/**
 * deepDiff:首个不一致点定位(undefined-insensitive + emptyish 容差)。
 * fromRecord 重算会设 extra undefined keys(toRecord fallback []),emptyish 容差吸收 normalize 差异;
 * skipKeys 跳过已知非 round-trip 字段(node 级 status)。返回首个不一致 {fieldPath, expected, actual}。
 */
export const deepDiff = (
  expected: unknown,
  actual: unknown,
  path: string,
  skipKeys: Set<string> = new Set(),
): Omit<ShadowDiff, 'recordId'> | null => {
  if (expected === actual) return null
  // emptyish 容差:undefined/null/[] /{} 互相视为一致(normalize:undefined effects ↔ [] effects)
  if (isEmptyish(expected) && isEmptyish(actual)) return null
  // primitive / null / 类型不同(非 emptyish)
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  ) {
    return { fieldPath: path, expected, actual }
  }
  const exp = expected as Record<string, unknown>
  const act = actual as Record<string, unknown>
  const allKeys = new Set([...Object.keys(exp), ...Object.keys(act)])
  for (const key of allKeys) {
    if (skipKeys.has(key)) continue
    const sub = deepDiff(exp[key], act[key], `${path}.${key}`, skipKeys)
    if (sub) return sub
  }
  return null
}

/** stableStringify:值 → 稳定字符串(用于 selection 比对 + warn 消息摘要,避开 [object Object])。 */
export const stableStringify = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * compareDocuments:legacy canonical(expected,canvasStore 输出)vs shadow 投影(actual,
 * DocKernel round-trip via S3 adapters)。逐 nodes/edges/selection/meta 比,跳过已知非
 * round-trip 项(node.status fallback 派生;meta.updatedAt DocKernel bump;tasks:[] DP-8
 * 迁服务端)。返回首个不一致点(record id + 字段路径 + 期望/实际)。
 */
export const compareDocuments = (expected: CanvasDocument, actual: CanvasDocument): ShadowDiff | null => {
  // nodes(by index;round-trip 保序——listNodes = upsert 顺序 = doc.nodes 顺序)
  const expNodes = expected.nodes
  const actNodes = actual.nodes
  if (expNodes.length !== actNodes.length) {
    return {
      recordId: actNodes[expNodes.length]?.id ?? '<none>',
      fieldPath: 'nodes.length',
      expected: expNodes.length,
      actual: actNodes.length,
    }
  }
  for (let i = 0; i < expNodes.length; i += 1) {
    const e = expNodes[i]
    const a = actNodes[i]
    if (e.id !== a.id) {
      return { recordId: a.id, fieldPath: `nodes[${i}].id`, expected: e.id, actual: a.id }
    }
    const diff = deepDiff(e, a, `nodes[${i}]`, NODE_SKIP_KEYS)
    if (diff) return { recordId: e.id, ...diff }
  }

  // edges(by index)
  const expEdges = expected.edges ?? []
  const actEdges = actual.edges ?? []
  if (expEdges.length !== actEdges.length) {
    return {
      recordId: '<edges>',
      fieldPath: 'edges.length',
      expected: expEdges.length,
      actual: actEdges.length,
    }
  }
  for (let i = 0; i < expEdges.length; i += 1) {
    const e = expEdges[i]
    const a = actEdges[i]
    const diff = deepDiff(e, a, `edges[${i}]`)
    if (diff) return { recordId: String(a.id ?? `${a.from}→${a.to}`), ...diff }
  }

  // selection(sessionStore round-trip;DP-1)
  const expSel = expected.selectedNodeIds ?? (expected.selectedNodeId ? [expected.selectedNodeId] : [])
  const actSel = actual.selectedNodeIds ?? (actual.selectedNodeId ? [actual.selectedNodeId] : [])
  if (stableStringify(expSel) !== stableStringify(actSel)) {
    return { recordId: '<selection>', fieldPath: 'selectedNodeIds', expected: expSel, actual: actSel }
  }

  // meta(跳过 updatedAt:DocKernel hydrate 会 bump updatedAt,非 round-trip;不比 revision:
  // legacy CanvasDocument 无 revision 字段,DocKernel.documentMeta.revision 是内核概念不入 legacy)
  if (expected.title !== actual.title) {
    return { recordId: '<meta>', fieldPath: 'title', expected: expected.title, actual: actual.title }
  }
  if (expected.sourceTemplateId !== actual.sourceTemplateId) {
    return { recordId: '<meta>', fieldPath: 'sourceTemplateId', expected: expected.sourceTemplateId, actual: actual.sourceTemplateId }
  }
  if (expected.projectId !== actual.projectId) {
    return { recordId: '<meta>', fieldPath: 'projectId', expected: expected.projectId, actual: actual.projectId }
  }
  if (expected.createdAt !== actual.createdAt) {
    return { recordId: '<meta>', fieldPath: 'createdAt', expected: expected.createdAt, actual: actual.createdAt }
  }

  return null
}

/**
 * ShadowScheduler:去抖比对器(纯函数 factory,不依赖 React——可 fake-timer 单测)。
 * schedule(expected, actual, sceneId):连续调用只在 settle(debounceMs 无新调用)后比对一次;
 *   调用方已 project 好 actual——只省 compare 不省 round-trip,保留供既有调用方/单测。
 * scheduleProjected(expected, project, sceneId)(S6d):整个 round-trip(project+compare)延后到
 *   settle 后跑一次。hook 用本方法——project 闭包在 timeout 内才调,N 次连续 schedule 只跑一次
 *   round-trip,避免 ?kernel=new 下 20k 连续编辑在 render 期同步跑 hydrate+project 卡交互(P2)。
 * cancel():清未触发的比对(effect cleanup 用)。比对调 compareDocuments,不一致 → onDiff(finding, sceneId)。
 */
export type ShadowScheduler = {
  schedule: (expected: CanvasDocument, actual: CanvasDocument, sceneId: string) => void
  scheduleProjected: (
    expected: CanvasDocument,
    project: (doc: CanvasDocument) => CanvasDocument,
    sceneId: string,
  ) => void
  cancel: () => void
}

export const createShadowScheduler = (
  onDiff: (finding: ShadowDiff, sceneId: string) => void,
  debounceMs: number = SHADOW_DEBOUNCE_MS,
): ShadowScheduler => {
  let handle: ReturnType<typeof setTimeout> | undefined
  // arm:去抖 arm——连续调用 reset timer,settle(debounceMs 无新调用)后跑一次 run。
  const arm = (run: () => void) => {
    if (handle !== undefined) clearTimeout(handle)
    handle = setTimeout(() => {
      handle = undefined
      run()
    }, debounceMs)
  }
  return {
    // 调用方已 project 好 actual——arm 只去抖 compareDocuments。注意:此路径不省 project
    // round-trip;hook 路径(需省 round-trip)用 scheduleProjected。
    schedule(expected, actual, sceneId) {
      arm(() => {
        const finding = compareDocuments(expected, actual)
        if (finding) onDiff(finding, sceneId)
      })
    },
    // S6d:整个 round-trip(project+compare)延后到 settle 后。project 闭包在 timeout 内才调,
    // N 次连续 schedule 只跑一次 round-trip(P2 修复:render 期不再同步跑 hydrate+project)。
    scheduleProjected(expected, project, sceneId) {
      arm(() => {
        const actual = project(expected)
        const finding = compareDocuments(expected, actual)
        if (finding) onDiff(finding, sceneId)
      })
    },
    cancel() {
      if (handle !== undefined) {
        clearTimeout(handle)
        handle = undefined
      }
    },
  }
}
