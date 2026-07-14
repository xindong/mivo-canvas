// src/canvas/useBrushStamp.contract.test.ts
// A2 ptr 源码契约:pointerup 放置 stamp 必须经 wrapMutation(非裸 store.addMarkupNode)。
// 否则绕过 wrapMutation → 不发 submitChange → server persist 模式 stamp 放置不落 server。
// 沿用 #244/#246 源码文本契约模式(项目无 React hook render harness,无法 fire 真实 pointerup event
// 跑端到端;wrapMutation 行为由 canvasSyncRuntime.test.ts 的行为单元覆盖,本文件钉死"pointerup source
// 调 wrapMutation"接线事实,防止改回裸 store.addMarkupNode())。
import { describe, expect, it } from 'vitest'
import source from './useBrushStamp.ts?raw'

describe('A2 ptr: useBrushStamp pointerup addMarkupNode 经 wrapMutation(源码契约)', () => {
  it('pointerup stamp 放置 → wrapMutation(store.addMarkupNode),非裸 store.addMarkupNode()', () => {
    // 取参包:wrap 版是 store.addMarkupNode)('stamp', ...)(右括号插入);裸版 store.addMarkupNode('stamp', ...)。
    // regex 匹配裸调(store.X 紧跟左括号);wrap 版 store.X 紧跟右括号,不匹配。
    expect(source).toContain('wrapMutation(store.addMarkupNode)')
    expect(source).not.toMatch(/store\.addMarkupNode\(/)
  })
})
