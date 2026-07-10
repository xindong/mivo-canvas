// src/kernel/useKernelRead.ts
// T1.2 S5:kernel=new shadow compare 读 hook(?kernel=new 护栏;legacy 默认零变化)。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.1(B 阶段 new shadow 从 legacy canonical
// 读,内存比对,不回写 UI/store/服务端)+ §4.7.1(契约测试:不读空派生缓存、比对走内存)。
//
// 设计(Lead 裁决 A+(1),2026-07-10):
// - ?kernel=legacy(默认):no-op。UI 读仍 canvasStore(App.tsx selectors 不变),shadow 不跑。
// - ?kernel=new:shadow compare。从 legacy canonical(canvasStore 内存态 = legacy writer 的
//   canonical 内存投影)hydrate DocKernel via S3 adapters → project 回 legacy shape → 与
//   canvasStore 输出比对(内存)。不一致 → debugLogger.warn(首个不一致 record id + 字段路径),
//   不回写 UI/store/服务端(§4.1)。
// - DocKernel 纯派生(useMemo 构建 projector 闭包,hydrate 延后到 scheduler timeout;S6 按需
//   演进独立态 + 回写)。
// - 比对开销护栏:createShadowScheduler 去抖(settle 后整个 round-trip+比对只跑一次),避免
//   ?kernel=new 下 20k 连续编辑在 render 期同步跑 hydrate 卡交互(S6d P2 修复,Greptile S5
//   resan:原 useMemo 每次 document 变更都重 hydrate,去抖只省 compare 不省 round-trip);护栏
//   纯函数 + fake timer 单测(见 shadowCompare.test)。
// - 不读空派生缓存 ${BASE}:${userId}:new(§4.1):shadow 只读 canvasStore 内存态,不碰 storage。
//
// S6 范围(Lead 2026-07-10):接活 UI 读 + 写(双写 vs 切主届时拍)。S5 只 shadow,不服务 UI 读。
//
// 比对 / 去抖纯逻辑在 src/kernel/shadowCompare.ts(不依赖 React / canvasStore / storage,
// 可 runtime + fake-timer 单测,无需 React hook render harness——项目无 @testing-library/react、
// 无 jsdom,见 src/canvas/useNodeTransform.contract.test.ts 说明)。本文件只留 hook 薄封装。

import { useEffect, useMemo, useState } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { isLegacyKernel } from '../app/kernelMode'
import { debugLogger } from '../store/debugLogStore'
import { hydrateDocKernel, projectToLegacyDocument } from './adapters'
import { createSessionStore } from './sessionStore'
import { createShadowScheduler, stableStringify } from './shadowCompare'
import type { ShadowScheduler } from './shadowCompare'
import type { CanvasDocument } from '../types/mivoCanvas'

const SOURCE = 'Kernel Shadow'

// S5 单 user/canvas sessionStore(占位;FX-6 auth userId 后取真实 user)。
const shadowSessionStore = createSessionStore()
const SHADOW_USER_ID = 'local-shadow'

/**
 * useKernelRead:kernel=new shadow compare 读 hook(?kernel=new 护栏;legacy 默认 no-op)。
 * shadow 从 legacy canonical(canvasStore 内存态)hydrate DocKernel via S3 → project 回 → 比对 →
 * 不一致 debugLogger.warn(带定位)。不回写 UI/store/服务端(§4.1)。比对去抖(settle 后一次)。
 *
 * UI 读仍走 canvasStore(App.tsx selectors 不变);本 hook 只跑 shadow 副作用。legacy 下所有
 * selector 返回常量(null/''),不订阅 store 变化、不触发 re-render,零行为变化(§8)。
 */
export function useKernelRead(): void {
  // legacy 下 selector 返回常量(null/''),不订阅 canvases/sceneId 变化 → 零 re-render。
  // isLegacyKernel 是模块常量(模块加载时解析一次,生命周期内不变),selector 内短路读它。
  const sceneId = useCanvasStore((s) => (isLegacyKernel ? '' : s.sceneId))
  const document = useCanvasStore((s) =>
    isLegacyKernel ? null : ((s.canvases[s.sceneId] ?? null) as CanvasDocument | null),
  )

  // projector:延迟 hydrate+project 到去抖 settle 后(S6d P2 修复)。useMemo 只构建廉价闭包,
  // 重活 hydrateDocKernel/projectToLegacyDocument 延后到 scheduler timeout 内跑——避免
  // ?kernel=new 下 20k 连续编辑在 render 期同步跑 round-trip 卡交互(原 useMemo 每次 document
  // 变更都重 hydrate,300ms 去抖只省 compare 不省 round-trip;Greptile S5 rescan P2)。shadow
  // 只比对不服务 UI(§4.1),故 round-trip 可安全延后。isLegacyKernel 不进 deps(模块常量,永不
  // 变化);document/sceneId 变触发闭包重建(廉价,不跑 hydrate)。legacy → null(契约:legacy 不
  // hydrate,见 useKernelRead.contract.test)。
  const projector = useMemo<((doc: CanvasDocument) => CanvasDocument) | null>(() => {
    if (isLegacyKernel || !document) return null
    return (doc: CanvasDocument) => {
      const dk = hydrateDocKernel(doc, {
        sessionStore: shadowSessionStore,
        userId: SHADOW_USER_ID,
        canvasId: sceneId,
      })
      return projectToLegacyDocument(dk, {
        sessionStore: shadowSessionStore,
        userId: SHADOW_USER_ID,
        canvasId: sceneId,
      })
    }
  }, [document, sceneId])

  // 去抖比对器(useState lazy init,稳定值不触发 re-render;React 19 替代 useRef lazy
  // pattern 避 react-hooks/refs render 期读 ref 警告;legacy 不创建省开销)。effect 在
  // document 变时 schedule 比对 + cleanup cancel 旧 timer → 连续变化只触发最后一次比对。
  const [scheduler] = useState<ShadowScheduler | null>(() =>
    isLegacyKernel
      ? null
      : createShadowScheduler((finding, sid) => {
          debugLogger.warn(
            SOURCE,
            `shadow divergence: record=${finding.recordId} field=${finding.fieldPath} expected=${stableStringify(finding.expected)} actual=${stableStringify(finding.actual)} (sceneId=${sid})`,
          )
        }),
  )
  useEffect(() => {
    if (projector == null || document == null || scheduler == null) return
    // 整个 round-trip(project+compare)延后到去抖 settle 后跑一次(S6d P2)。projector 闭包在
    // scheduler timeout 内才调 → N 次连续 document 变更只跑一次 round-trip,render 期零 hydrate。
    scheduler.scheduleProjected(document, projector, sceneId)
    return () => scheduler.cancel()
  }, [projector, document, sceneId, scheduler])
}
