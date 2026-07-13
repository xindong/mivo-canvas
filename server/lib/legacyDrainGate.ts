// server/lib/legacyDrainGate.ts
// A2-S2 §14.3:LEGACY_DRAIN gate(cutover drain 窗口开启,retirement 后关)+ retirement 观测。
// 权威:docs/decisions/n20-truth-source-decision.md §14.3 + §1.2 状态表 row 2 +
//   src/kernel/__spike__/n20-truth-source.spike.test.ts CutoverHarness(L2273-2403,审计参考)。
//
// 立场(lead 拍板 2026-07-13):retirement 状态**进程内**(匹配 spike),不建 PG 表——
//   - 重启重置 quiet-window = 保守方向(只会推迟 retirement,不会提前关闸);临时 drain 通道不值得持久化;
//   - pending gauge 每次从队列实况推导(非持久累计);drainCount 只作累计总量(observability,非 retirement 条件)。
//   - 若未来观察期发现反复重启导致 retire 不了,再升级持久化——那是运维问题不是正确性问题。
//
// 单例进程内状态:多 worker / 部署多实例各自独立观测(retirement 是 per-deployment ops 决策,非强一致)。

import type { LegacyDrainStatus } from '../../shared/persist-contract.ts'

/** 冻结配置名 + 绝对时长(quiet-window;§14.7:窗口内任一 envelope 到达即重新计时)。 */
export const LEGACY_DRAIN_QUIET_WINDOW_MS = 60_000

// clock 须先于 windowStartAt 声明(now() 闭包引用 clock,首调 windowStartAt=now() 时 clock 已赋值)。
let clock: () => number = () => Date.now()
const now = (): number => clock()

let open = process.env.LEGACY_DRAIN === '1' || process.env.LEGACY_DRAIN === 'on'
let drainCount = 0
let windowStartAt = now()
let envelopeIncrementInWindow = 0

export const legacyDrainGate = {
  /** gate 是否开启(cutover drain 窗口;关 → envelope 400 payload-rejected,§14.3)。 */
  isOpen(): boolean {
    return open
  },
  /** ops/test 控制 gate 开关(retirement 后关 → 主写唯一 DomainOp)。 */
  setOpen(v: boolean): void {
    open = v
  },
  /** 注入 fake clock(测试 quiet-window 用;生产不调,走 Date.now)。 */
  setClock(fn: () => number): void {
    clock = fn
  },
  /** 任一 envelope 到达(经 authz+gate+scope)→ 重新计时窗口 + envelope 增量 +1(§14.7)。 */
  touchWindow(): void {
    windowStartAt = now()
    envelopeIncrementInWindow += 1
  },
  /** 推进 clock 判定;完整连续 quiet 窗口(elapsed>=quietMs,期间无 envelope 到达)→ 归零增量返 true。 */
  tickObservationWindow(): boolean {
    if (now() - windowStartAt >= LEGACY_DRAIN_QUIET_WINDOW_MS) {
      envelopeIncrementInWindow = 0
      return true
    }
    return false
  },
  incrementDrainCount(): void {
    drainCount += 1
  },
  drainCountValue(): number {
    return drainCount
  },
  envelopeIncrementInWindowValue(): number {
    return envelopeIncrementInWindow
  },
  /**
   * retirement 可达指标(§14.3):pending gauge=0 + 窗内增量=0 + elapsed>=quietMs(连续 quiet-window 无 envelope)。
   * pendingGauge 由调用方从队列实况推导(非本模块持久累计)。
   */
  canRetire(pendingGauge: number): boolean {
    return (
      pendingGauge === 0 &&
      envelopeIncrementInWindow === 0 &&
      now() - windowStartAt >= LEGACY_DRAIN_QUIET_WINDOW_MS
    )
  },
  /** 观测快照(ops/readyz 用;drainCount 累计 + pending gauge + window 指标 + canRetire)。 */
  status(pendingGauge: number): LegacyDrainStatus {
    const elapsed = now() - windowStartAt
    return {
      drainCount,
      pendingGauge,
      envelopeIncrementInWindow,
      quietWindowMs: LEGACY_DRAIN_QUIET_WINDOW_MS,
      elapsedMs: elapsed,
      canRetire: this.canRetire(pendingGauge),
    }
  },
  /** test-only:重置全部状态(测试隔离用;生产不调)。 */
  __reset(): void {
    clock = () => Date.now()
    open = process.env.LEGACY_DRAIN === '1' || process.env.LEGACY_DRAIN === 'on'
    drainCount = 0
    windowStartAt = now()
    envelopeIncrementInWindow = 0
  },
}
