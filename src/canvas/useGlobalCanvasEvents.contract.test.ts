// src/canvas/useGlobalCanvasEvents.contract.test.ts
// F1 源码契约:快捷键 duplicate/delete/paste 必须经 wrapMutation(非裸 store action)。
// 否则绕过 wrapMutation → 不发 submitChange → attach/detach 接线对最高频入口(Cmd+D / Delete / 系统粘贴)
// 不生效。项目无 React hook render harness(no @testing-library/react, no jsdom/happy-dom,见
// scene-reset.contract.test.ts:11-13),无法 fire 真实 keydown/paste event 跑端到端;沿用该测试的
// 源码文本契约模式防回归:wrapMutation 行为本身由 canvasSyncRuntime.test.ts 的 F1 单元测试覆盖,
// 本文件钉死"快捷键 source 调 wrapMutation"这一接线事实(防止有人改回裸 store.X())。
import { describe, expect, it } from 'vitest'
import source from './useGlobalCanvasEvents.ts?raw'

describe('F1: useGlobalCanvasEvents 快捷键路径经 wrapMutation(源码契约)', () => {
  it('Cmd/Ctrl+D → wrapMutation(store.duplicateSelectedNodes),非裸 store.duplicateSelectedNodes()', () => {
    expect(source).toContain('wrapMutation(store.duplicateSelectedNodes)()')
    // 裸 store.duplicateSelectedNodes()(不经 wrap)被禁止:regex 匹配裸调(store.X 紧跟 ());
    // wrap 版是 store.X)())(右括号插入),不匹配。
    expect(source).not.toMatch(/store\.duplicateSelectedNodes\(\)/)
  })

  it('Backspace/Delete → wrapMutation(store.deleteSelectedNodes),非裸 store.deleteSelectedNodes()', () => {
    expect(source).toContain('wrapMutation(store.deleteSelectedNodes)()')
    expect(source).not.toMatch(/store\.deleteSelectedNodes\(\)/)
  })

  it('paste(clipboardNodes)→ wrapMutation(() => store.pasteClipboardNodes())', () => {
    // paste 经 lambda 包装(需 viewportCenter 落点保留原语义),故 regex not-to-match 不适用
    // (lambda body 内含 store.pasteClipboardNodes());只用 toContain 钉死 wrap 接线。
    expect(source).toContain("wrapMutation(() => store.pasteClipboardNodes())()")
  })

  it('undo/cut/group/ungroup/moveLayer 等其余快捷键不在本契约范围(存量缺口,另列任务)', () => {
    // 边界声明(lead 裁定):本 PR 只改 duplicate/delete/paste 三条 asset 相关路径。
    // 其余快捷键的同类旁路(store.cutSelectedNodes / groupSelectedNodes / moveSelectedLayer 等)
    // 是存量缺口,不归本 PR,不在此断言。
    expect(true).toBe(true)
  })
})
