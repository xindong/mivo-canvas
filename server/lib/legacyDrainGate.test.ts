// server/lib/legacyDrainGate.test.ts
// A2-S2 §14.3 LEGACY_DRAIN gate 单元测试:gate env 默认关 + retirement 进程内观测(canRetire 双指标 + quiet-window
// 60_000ms + 窗口内 envelope 到达重计时)。蓝本:src/kernel/__spike__/n20-truth-source.spike.test.ts CutoverHarness
// L2273-2403 ④ retirement fake-clock(语义蓝本,生产化到 legacyDrainGate 模块)。
//
// 范围:legacyDrainGate 模块单例状态(isOpen/touchWindow/tickObservationWindow/canRetire/status/drainCount)。
// route 层(envelope→drain 四态+scope+authz)在 canvas.route.test.ts;backend 四态在 backend.a2s2.test.ts。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { legacyDrainGate, LEGACY_DRAIN_QUIET_WINDOW_MS } from './legacyDrainGate'

// 进程内单例:每 test __reset + 注入 fake clock 隔离(生产 Date.now 不调)。
let fakeNow = 0
const fakeClock = (): number => fakeNow
const advance = (ms: number): void => { fakeNow += ms }

// __reset 重读 process.env.LEGACY_DRAIN;测试默认 gate 关 → 删 env 再 reset 确定 isOpen=false。
const savedEnv = process.env.LEGACY_DRAIN
beforeEach(() => {
  fakeNow = 0
  delete process.env.LEGACY_DRAIN
  legacyDrainGate.__reset()
  legacyDrainGate.setClock(fakeClock)
})
afterEach(() => {
  if (savedEnv !== undefined) process.env.LEGACY_DRAIN = savedEnv
  else delete process.env.LEGACY_DRAIN
  legacyDrainGate.__reset()
})

describe('A2-S2 §14.3 LEGACY_DRAIN gate(env 默认关 + retirement 进程内观测)', () => {
  describe('gate env 默认关 + setOpen toggle(§14.3 受控迁移协议例外,非双协议窗口)', () => {
    it('env 未设 → isOpen()===false(gate 默认关;关 → envelope 400 payload-rejected)', () => {
      expect(legacyDrainGate.isOpen()).toBe(false)
    })
    it('setOpen(true) → isOpen()===true;setOpen(false) → false(ops/test 控制)', () => {
      legacyDrainGate.setOpen(true)
      expect(legacyDrainGate.isOpen()).toBe(true)
      legacyDrainGate.setOpen(false)
      expect(legacyDrainGate.isOpen()).toBe(false)
    })
    it('env LEGACY_DRAIN=1/__reset → isOpen()===true(on 开闸)', () => {
      process.env.LEGACY_DRAIN = '1'
      legacyDrainGate.__reset()
      legacyDrainGate.setClock(fakeClock)
      expect(legacyDrainGate.isOpen()).toBe(true)
    })
    it('env LEGACY_DRAIN=on → isOpen()===true(同 "1")', () => {
      process.env.LEGACY_DRAIN = 'on'
      legacyDrainGate.__reset()
      legacyDrainGate.setClock(fakeClock)
      expect(legacyDrainGate.isOpen()).toBe(true)
    })
  })

  describe('retirement quiet-window 60_000ms(冻结配置名 + 绝对时长 + 窗口内 envelope 到达重计时)', () => {
    it('LEGACY_DRAIN_QUIET_WINDOW_MS=60_000(冻结配置名 + 绝对时长;§14.7)', () => {
      expect(LEGACY_DRAIN_QUIET_WINDOW_MS).toBe(60_000)
    })

    it('touchWindow → envelopeIncrementInWindow +1 + windowStartAt 重计(任一 envelope 到达即重新计时)', () => {
      legacyDrainGate.setOpen(true)
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(0)
      legacyDrainGate.touchWindow()
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(1)
      legacyDrainGate.touchWindow()
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(2)
    })

    it('quiet-window 未完整(elapsed<quietMs)→ tickObservationWindow 返 false + 不归零 delta', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow() // delta=1, windowStartAt=0
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS - 1) // 推到边界前 1ms
      expect(legacyDrainGate.tickObservationWindow()).toBe(false) // 未完整 → 不归零
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(1) // delta 仍 >0
    })

    it('完整连续 quiet-window(elapsed>=quietMs,期间无 envelope 到达)→ tickObservationWindow 归零 delta 返 true', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow() // delta=1, windowStartAt=0
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS) // 推过完整 quiet 窗口边界
      expect(legacyDrainGate.tickObservationWindow()).toBe(true) // 完整窗口 → 归零 delta
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(0) // delta=0
    })

    it('canRetire:pending=0 + delta=0 + 完整窗口 → true;pending>0 → false(双指标缺一不可)', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow() // delta=1
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS)
      expect(legacyDrainGate.tickObservationWindow()).toBe(true) // delta→0
      // pending=0 + delta=0 + 完整窗口 → 可 retire
      expect(legacyDrainGate.canRetire(0)).toBe(true)
      // ★ pending>0 → 不 retire(即使 delta=0 + 完整窗口)— v9 补真断言
      expect(legacyDrainGate.canRetire(1)).toBe(false)
      expect(legacyDrainGate.canRetire(5)).toBe(false)
    })

    it('delta>0(刚有 envelope 活动)→ canRetire false(即使 pending=0 + 窗口已过 quietMs)', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow() // delta=1
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS) // elapsed>=quietMs,但 delta=1 未归零(未 tick)
      expect(legacyDrainGate.canRetire(0)).toBe(false) // delta>0 → 不 retire(tick 前不归零)
    })

    it('mid-window envelope 到达 → 重新计时(须再等完整 quiet 窗口才可 retire;防"刚 retire 又来 envelope"误判)', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow() // delta=1, windowStartAt=0
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS)
      expect(legacyDrainGate.tickObservationWindow()).toBe(true) // delta→0, canRetire(0)=true
      expect(legacyDrainGate.canRetire(0)).toBe(true)
      // mid-window envelope 到达 → touchWindow 重新计时(windowStartAt=now,delta+=1)
      legacyDrainGate.touchWindow()
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBeGreaterThan(0) // delta>0
      expect(legacyDrainGate.canRetire(0)).toBe(false) // 窗口被重计时 → 不 retire
      // 须再等完整 quiet 窗口
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS - 1)
      expect(legacyDrainGate.canRetire(0)).toBe(false) // 未完整
      advance(1)
      expect(legacyDrainGate.tickObservationWindow()).toBe(true) // 再等完整窗口 → 归零
      expect(legacyDrainGate.canRetire(0)).toBe(true) // 重新满完整 quiet-window → 可 retire
    })

    it('重启重置(进程内;__reset 清 drainCount+delta+window)— 保守方向,只推迟 retirement 不提前关闸', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow()
      legacyDrainGate.incrementDrainCount()
      legacyDrainGate.incrementDrainCount()
      expect(legacyDrainGate.drainCountValue()).toBe(2)
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(1)
      // 模拟重启:__reset 清进程内状态(drainCount 归零;retirement 计时从头;gate 重读 env)
      legacyDrainGate.__reset()
      legacyDrainGate.setClock(fakeClock)
      expect(legacyDrainGate.drainCountValue()).toBe(0)
      expect(legacyDrainGate.envelopeIncrementInWindowValue()).toBe(0)
      expect(legacyDrainGate.isOpen()).toBe(false) // 重读 env(未设→关)
    })
  })

  describe('drainCount 累计总量(observability,非 retirement 条件)+ status 快照', () => {
    it('incrementDrainCount 累计 + drainCountValue 读;drainCount 不影响 canRetire', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow()
      advance(LEGACY_DRAIN_QUIET_WINDOW_MS)
      expect(legacyDrainGate.tickObservationWindow()).toBe(true)
      legacyDrainGate.incrementDrainCount()
      legacyDrainGate.incrementDrainCount()
      legacyDrainGate.incrementDrainCount()
      expect(legacyDrainGate.drainCountValue()).toBe(3)
      // drainCount=3 但 delta=0 + pending=0 + 完整窗口 → 仍可 retire(drainCount 非条件)
      expect(legacyDrainGate.canRetire(0)).toBe(true)
    })

    it('status(pendingGauge) 快照:drainCount + pending gauge + window 指标 + canRetire', () => {
      legacyDrainGate.setOpen(true)
      legacyDrainGate.touchWindow()
      legacyDrainGate.incrementDrainCount()
      advance(10_000)
      const s = legacyDrainGate.status(7)
      expect(s.drainCount).toBe(1)
      expect(s.pendingGauge).toBe(7)
      expect(s.envelopeIncrementInWindow).toBe(1)
      expect(s.quietWindowMs).toBe(LEGACY_DRAIN_QUIET_WINDOW_MS)
      expect(s.elapsedMs).toBe(10_000)
      expect(s.canRetire).toBe(false) // delta=1 + elapsed<quietMs
    })
  })
})
