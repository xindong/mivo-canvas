// src/kernel/useKernelRead.contract.test.ts
// T1.2 S5:useKernelRead hook 源码契约(防回潮)。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.1(new shadow 从 legacy canonical 读,
// 内存比对,不回写 UI/store/服务端;禁止读 :new 空派生缓存)+ §8(legacy 默认零变化)。
//
// 项目无 React hook render harness(见 src/canvas/useNodeTransform.contract.test.ts 说明),
// 故 hook 行为用源码契约验证(防回潮:未来若有人误把 isLegacyKernel 短路删了、或误引入
// storage getItem 读 :new 派生缓存、或 shadow 误回写 UI/store,本测试 fail)。去抖/比对纯逻辑
// runtime 单测见 shadowCompare.test.ts。

import { describe, expect, it } from 'vitest'
// ?raw 读源码字符串(不执行模块 → 不触发 canvasStore 初始化链,无需 mock demoImages 等)
import useKernelReadSource from './useKernelRead.ts?raw'

describe('S5 useKernelRead 源码契约 — §4.1 不读空派生缓存 / 数据源', () => {
  it('shadow 数据源 = canvasStore 内存态(legacy canonical),不读 storage', () => {
    // §4.1:new shadow 从 legacy canonical key 读(B 阶段即 canvasStore 内存态 = legacy writer
    // canonical 的内存投影)。useKernelRead 只 import useCanvasStore;不 import storage getItem /
    // localStorage / IndexedDB / createJSONStorage —— shadow 不碰 storage,自然不读 :new 派生缓存
    // (注释里 "${BASE}:${userId}:new" 是契约说明文字,非代码;不读 storage 即不读 :new 的根因断言)。
    expect(useKernelReadSource).toContain("from '../store/canvasStore'")
    expect(useKernelReadSource).not.toMatch(/\bgetItem\b|\blocalStorage\b|\bIndexedDB\b|createJSONStorage/)
  })

  it('比对走内存(createShadowScheduler 纯函数,shadowCompare 模块)', () => {
    // 比对逻辑在 shadowCompare.ts(纯函数,无 storage);hook 只调 createShadowScheduler。
    expect(useKernelReadSource).toContain('createShadowScheduler')
    expect(useKernelReadSource).toContain("from './shadowCompare'")
  })
})

describe('S5 useKernelRead 源码契约 — §8 legacy 默认零变化', () => {
  it('isLegacyKernel 时 selector 短路返回常量(零订阅/零 re-render)', () => {
    // ?kernel=legacy:sceneId selector 返回 '',document selector 返回 null(不订阅 canvases/sceneId)
    expect(useKernelReadSource).toMatch(/isLegacyKernel\s*\?\s*''\s*:\s*s\.sceneId/)
    expect(useKernelReadSource).toMatch(/isLegacyKernel\s*\?\s*null\s*:/)
  })

  it('legacy 时 useMemo 跳过 hydrate(不调 hydrateDocKernel)', () => {
    // useMemo: isLegacyKernel || !document → null(不 hydrate DocKernel)
    expect(useKernelReadSource).toMatch(/if\s*\(isLegacyKernel\s*\|\|\s*!document\)\s*return\s*null/)
  })

  it('legacy 时 scheduler 不创建(isLegacyKernel ? null : createShadowScheduler)', () => {
    // useState lazy: isLegacyKernel ? null : createShadowScheduler(...)——legacy 不创建比对器省开销
    expect(useKernelReadSource).toMatch(/isLegacyKernel[\s\S]*?\?\s*null[\s\S]*?:[\s\S]*?createShadowScheduler/)
  })
})

describe('S5 useKernelRead 源码契约 — §4.1 shadow 不回写 UI/store/服务端', () => {
  it('shadow 分歧仅 debugLogger.warn,不回写(无 setState/setItem/fetch)', () => {
    // §4.1:new shadow 不一致只走 debugLogger.warn,不回写 UI/store/服务端。
    // hook 内无 setState/setItem/fetch(只 scheduler.schedule + debugLogger.warn)。
    expect(useKernelReadSource).toContain('debugLogger.warn')
    expect(useKernelReadSource).not.toMatch(/\.setState\(|\.setItem\(|\bfetch\(/)
  })

  it('shadow 去抖(settle 后比对一次,非每次 render 比对)', () => {
    // 比对护栏:createShadowScheduler 去抖;hook 在 effect 里 schedule(非 render 期直接比对)。
    expect(useKernelReadSource).toContain('scheduler.schedule')
    expect(useKernelReadSource).toContain('scheduler.cancel') // effect cleanup 去抖语义
  })
})
