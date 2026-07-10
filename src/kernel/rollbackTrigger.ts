// src/kernel/rollbackTrigger.ts
// T1.2 S6c:rollbackFromV11 的人可触发口子(§4.3 checkpointed rollback 仪式的"可操作"缺口)。
// rollbackFromV11 在 main 上已有函数无入口——真出事时没人能调它。本文件接 console 口子。
//
// 调用链(lead 契约):口子 → triggerRollbackFromV11 → rollbackFromV11(rawIdbStorage
// as RawStorage)→ 结果(成功/失败/无 ckpt)经 debugLogger 输出 + toastFeedback 提示。
// S6b(#189 合入 main)把 cast as RawStorage 集中在 rawIdbStorage 导出点——本处直接传 rawIdbStorage
// (已是 RawStorage 类型),无需再 cast。
//
// 仅开发/诊断用途:生产构建不暴露 window 全局(import.meta.env.DEV 正向门控,
// 生产 if(false) 整块 tree-shake,零 window 写——同 R-06 failsafe 仪式,见
// useLeaferSpikeRenderer.failsafe.test.ts)。
//
// 边界:不动 useStoreHydration / canvasPersistConfig / persistIdbStorage /
// docKernelPersistAdapter(S6b 领地)。本文件只读消费 rawIdbStorage + rollbackFromV11。
//
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.3;docs/development-logging.md。

import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
import { namespacedKey } from '../lib/persistUserId'
import { rawIdbStorage } from '../lib/persistIdbStorage'
import { rollbackFromV11 } from './persistMigration'
import type { RawStorage } from './persistMigration'

const SOURCE = 'Kernel Rollback'

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export type RollbackTriggerOutcome = 'success' | 'no-ckpt' | 'failure'

export type RollbackTriggerResult = {
  outcome: RollbackTriggerOutcome
  baseName: string
  baseKey: string
  ckptKey: string
  error?: string
}

/**
 * triggerRollbackFromV11:人可触发的 rollbackFromV11 包装(核心,纯计算 + 存储 I/O,无日志/toast 副作用)。
 * 先预读 ckpt-v10 区分"无 ckpt"(无可回滚的迁移快照)与"成功";再调 rollbackFromV11
 * (从 ckpt 恢复 v10 单 blob + 删 document/session key,§4.3 第 3 步)。存储抛错捕获成
 * 'failure' 结果——不向上抛,口子调用方拿 result 统一报告(docs/development-logging.md)。
 *
 * rollbackFromV11 返回 void,无法自行区分"无 ckpt"与"成功"——故本包装预读 ckpt
 * (同一 ckptKey,rollbackFromV11 内部也读一次;一次性诊断操作,冗余读可接受,不碰 rollbackFromV11 契约)。
 *
 * storage 默认 rawIdbStorage(raw IDB;S6b #189 已在 export 处 cast as RawStorage,
 * 本处直接传无需再 cast);单测注入 mock。
 */
export async function triggerRollbackFromV11(
  baseName = 'mivo-canvas-demo',
  storage: RawStorage = rawIdbStorage,
): Promise<RollbackTriggerResult> {
  const baseKey = namespacedKey(baseName)
  const ckptKey = `${baseKey}:ckpt-v10`

  // 预读 ckpt 区分 no-ckpt(rollbackFromV11 返回 void,无法自行区分)。
  // 无初始化器:try 赋值或 catch 早返回,到下方读取时必定已赋值(避免 useless-assignment)。
  let ckptPresent: boolean
  try {
    const ckpt = await storage.getItem(ckptKey)
    ckptPresent = ckpt != null && (typeof ckpt !== 'string' || ckpt.length > 0)
  } catch (error) {
    // 预读失败 → failure(连 ckpt 都读不了,rollback 必然也炸;不调 rollbackFromV11 避免盲调)。
    return {
      outcome: 'failure',
      baseName,
      baseKey,
      ckptKey,
      error: `ckpt read failed: ${errMessage(error)}`,
    }
  }

  try {
    await rollbackFromV11(storage, baseName)
  } catch (error) {
    return { outcome: 'failure', baseName, baseKey, ckptKey, error: errMessage(error) }
  }

  return ckptPresent
    ? { outcome: 'success', baseName, baseKey, ckptKey }
    : { outcome: 'no-ckpt', baseName, baseKey, ckptKey }
}

/**
 * reportRollbackResult:把结果经 debugLogger + toastFeedback 输出(docs/development-logging.md)。
 * success → log + success toast;no-ckpt → warn + warn toast(无可回滚的迁移);failure → error + error toast。
 * 拆出独立函数便于单测(无需 storage,传 result 即可断言日志/toast 落点)。
 */
export function reportRollbackResult(result: RollbackTriggerResult): void {
  switch (result.outcome) {
    case 'success':
      debugLogger.log(
        SOURCE,
        `rollback ok: v10 blob restored from ${result.ckptKey}, v11 domain keys cleared (base=${result.baseKey})`,
      )
      toastFeedback.success('已从 v10 快照回滚。')
      break
    case 'no-ckpt':
      debugLogger.warn(
        SOURCE,
        `no ckpt at ${result.ckptKey} — nothing to roll back (no migration snapshot, base=${result.baseKey})`,
      )
      toastFeedback.warn('无回滚快照，未执行回滚。')
      break
    case 'failure':
      debugLogger.error(
        SOURCE,
        `rollback failed (${result.ckptKey}, base=${result.baseKey}): ${result.error ?? 'unknown error'}`,
      )
      toastFeedback.error('回滚失败，请查看 Debug Log。')
      break
  }
}

export type RollbackRunOptions = {
  /** 防误触:必须显式 true 才执行回滚。裸调 no-op + warn(防止 console 误触删除已迁移数据)。 */
  confirm?: boolean
  /** 覆盖默认 baseName(默认 'mivo-canvas-demo',与 canvasPersistConfig persist name 一致)。 */
  baseName?: string
}

/**
 * runRollbackWithConfirm:口子 run 的核心——confirm 防误触 + 触发 + 报告。
 * 独立于 window(window probe 只转发到此),便于单测无需 DOM。返回 result 或 null(被拒)。
 */
export async function runRollbackWithConfirm(
  opts: RollbackRunOptions = {},
  storage: RawStorage = rawIdbStorage,
): Promise<RollbackTriggerResult | null> {
  if (opts.confirm !== true) {
    debugLogger.warn(
      SOURCE,
      'rollback trigger needs { confirm: true } — refusing to run (防误触)',
    )
    toastFeedback.warn('回滚未执行：需显式确认。')
    return null
  }
  const result = await triggerRollbackFromV11(
    opts.baseName ?? 'mivo-canvas-demo',
    storage,
  )
  reportRollbackResult(result)
  return result
}

export type KernelRollbackProbe = {
  /**
   * 触发 rollbackFromV11。需 { confirm: true } 防误触;可选 baseName。
   * 返回结果(success/no-ckpt/failure)或 null(未确认)。
   */
  run: (opts?: RollbackRunOptions) => Promise<RollbackTriggerResult | null>
}

declare global {
  interface Window {
    /** DEV-only 诊断口子:触发 persist v10→v11 迁移回滚(§4.3 checkpointed rollback)。 */
    __MIVO_KERNEL_ROLLBACK__?: KernelRollbackProbe
  }
}

/**
 * installRollbackTrigger:把口子挂到 window.__MIVO_KERNEL_ROLLBACK__(仅 DEV)。
 * 正向 `if (import.meta.env.DEV)` 让生产构建整块 tree-shake,零 window 写(同 R-06 failsafe)。
 * typeof window 守卫防 SSR/node 测试环境炸。run 需显式 { confirm: true }——裸调 no-op + warn。
 *
 * 用法(dev console):window.__MIVO_KERNEL_ROLLBACK__.run({ confirm: true })
 */
export function installRollbackTrigger(): void {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    window.__MIVO_KERNEL_ROLLBACK__ = {
      run: (opts?: RollbackRunOptions) => runRollbackWithConfirm(opts ?? {}),
    }
  }
}
