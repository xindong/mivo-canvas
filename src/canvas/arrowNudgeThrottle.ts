// src/canvas/arrowNudgeThrottle.ts
// 方向键连按(server 模式变更洪峰)节流 — #arrowflood 生产 server 模式体验修复。
//
// 背景:OS key-repeat 让按住方向键每 ~33ms 触发一次 keydown。原 useGlobalCanvasEvents 每次
// keydown 都走 wrapMutation(store.moveSelectedNodesBy)(dx,dy) → server 模式下每次都全画布
// snapshot×2 + 全 records diff + enqueueCanvasSyncChanges(~30Hz change 队列,高 RTT 积压,
// 主线程 O(节点数×repeat) diff)。#256 生产切 server 持久化后,这从 backlog 升级为现实体验问题。
//
// 方案 a(lead 推荐起点「按键期间视觉即时,松键才同步」):burst 期间每次 keydown 只做裸本地
// delta move(即时视觉,零 submitChange);burst 结束(最后一个方向键 keyup / 窗口 blur / 组件
// 卸载 flush)时结算一次 —— 调用方 settle 实现:先 reset 回 before-burst 位置,再经 wrapMutation
// 一次性重放累计 delta → 单次 submitChange、最终位置正确。local 模式下 settle 的 wrapMutation
// 命中 local gate 直接 mutate 不 submit,零 submit 回归。
//
// 抽成纯模块(不依赖 React / store / port)以便单测:项目无 React hook render harness
// (无 jsdom/happy-dom、无 @testing-library/react,见 scene-reset.contract.test.ts:11-13),
// 无法 fire 真实 keydown 端到端;节流逻辑必须可脱离 hook 直接喂数据断言行为。
//
// 边界:本模块只做节流状态机;不动 canvasSyncRuntime 的 wrapMutation 本体 / Block 2 资产区域
// (computeAssetSideEffects/submitChanges) / 不碰 server。submit 路径仍复用既有 wrapMutation。

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

export type ArrowNudgeDeps = {
  /**
   * 裸本地 delta move(不 submit)。burst 期间每次 keydown 调一次,做即时视觉。
   * 实现应直接调 store.moveSelectedNodesBy(dx,dy)(不经 wrapMutation)。
   */
  moveBy: (dx: number, dy: number) => void
  /**
   * 结算一次同步。实现:先 store.moveSelectedNodesBy(-accDx,-accDy) reset 回 before-burst,
   * 再 wrapMutation(store.moveSelectedNodesBy)(accDx,accDy) 一次性重放 → 单次 submit。
   * 调用方负责保证 (0,0) 时 no-op(本模块已在上游 guard,但实现可双保险)。
   */
  settle: (accDx: number, accDy: number) => void
  /**
   * 每键步长(shift=10,否则 1)。暴露为参数纯为可测(生产用默认)。
   */
  unitDelta?: (shiftKey: boolean) => number
}

export type ArrowNudgeThrottle = {
  /** keydown(含 OS repeat)。应用一次裸 delta move + 累加,不结算。 */
  onKeyDown: (key: ArrowKey, shiftKey: boolean) => void
  /** keyup。移除按住键;若全部释放则结算一次。 */
  onKeyUp: (key: ArrowKey) => void
  /** 窗口 blur。立即结算 pending burst(防焦点丢失丢最终位置)。 */
  onBlur: () => void
  /** flush:effect cleanup / 组件卸载时结算 pending,保证不丢。 */
  flush: () => void
}

// 每个方向键的单位方向向量(乘 unitDelta 得单步 delta)。
const DELTA_FOR: Record<ArrowKey, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

export const createArrowNudgeThrottle = (deps: ArrowNudgeDeps): ArrowNudgeThrottle => {
  const unitDelta = deps.unitDelta ?? ((shift) => (shift ? 10 : 1))
  // 当前按住未释放的方向键集合 —— 多键同按(Left+Up)时,只在最后一个释放时结算。
  const pressed = new Set<ArrowKey>()
  let accDx = 0
  let accDy = 0

  // 结算:把累计 delta 交给 deps.settle 一次性同步,然后清零。idempotent guard 防
  // double-settle(keyup 后又 flush / 空 burst):acc 为 0 直接 no-op,不产生多余 submit/history。
  const runSettle = () => {
    if (accDx === 0 && accDy === 0) return
    const dx = accDx
    const dy = accDy
    accDx = 0
    accDy = 0
    deps.settle(dx, dy)
  }

  return {
    onKeyDown: (key, shiftKey) => {
      pressed.add(key)
      const u = unitDelta(shiftKey)
      const [bx, by] = DELTA_FOR[key]
      const dx = bx * u
      const dy = by * u
      accDx += dx
      accDy += dy
      // 即时视觉:裸 move,不 submit。burst 不结算。
      deps.moveBy(dx, dy)
    },
    onKeyUp: (key) => {
      pressed.delete(key)
      if (pressed.size === 0) runSettle()
    },
    onBlur: () => {
      pressed.clear()
      runSettle()
    },
    flush: () => {
      pressed.clear()
      runSettle()
    },
  }
}
