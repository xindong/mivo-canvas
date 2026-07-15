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

  // ── A2 SC:快捷键/全局事件 mutation 全量接入 wrapMutation(9 位点,lead 批复)──
  it('Cmd+Z → wrapMutation(store.undo),非裸 store.undo()', () => {
    expect(source).toContain('wrapMutation(store.undo)()')
    expect(source).not.toMatch(/store\.undo\(\)/)
  })

  it('Cmd+Shift+Z → wrapMutation(store.redo),非裸 store.redo()', () => {
    expect(source).toContain('wrapMutation(store.redo)()')
    expect(source).not.toMatch(/store\.redo\(\)/)
  })

  it('Cmd+X → wrapMutation(store.cutSelectedNodes),非裸 store.cutSelectedNodes()', () => {
    expect(source).toContain('wrapMutation(store.cutSelectedNodes)()')
    expect(source).not.toMatch(/store\.cutSelectedNodes\(\)/)
  })

  it('Cmd+G → wrapMutation(store.groupSelectedNodes),非裸 store.groupSelectedNodes()', () => {
    expect(source).toContain('wrapMutation(store.groupSelectedNodes)()')
    expect(source).not.toMatch(/store\.groupSelectedNodes\(\)/)
  })

  it('Cmd+Shift+G → wrapMutation(store.ungroupSelectedNodes),非裸 store.ungroupSelectedNodes()', () => {
    expect(source).toContain('wrapMutation(store.ungroupSelectedNodes)()')
    expect(source).not.toMatch(/store\.ungroupSelectedNodes\(\)/)
  })

  it('[ / ] → wrapMutation(store.moveSelectedLayer)(move),非裸 store.moveSelectedLayer(move)', () => {
    // 取参包:wrap 版是 store.moveSelectedLayer)(move)(右括号插入);裸版 store.moveSelectedLayer(move)。
    // regex 匹配裸调(store.X 紧跟左括号);wrap 版 store.X 紧跟右括号,不匹配。
    expect(source).toContain('wrapMutation(store.moveSelectedLayer)')
    expect(source).not.toMatch(/store\.moveSelectedLayer\(/)
  })

  it('Arrow keys → 经 createArrowNudgeThrottle 节流;松键/blur/卸载 settle 时经 wrapMutation(store.moveSelectedNodesBy) 一次同步', () => {
    // #arrowflood:原逐 keydown wrapMutation 在 OS key-repeat(~30Hz)下致 server 模式 submitChange 洪峰
    //   (全画布 snapshot×2 + diff × repeat)。改节流:keydown 进 throttle(burst 裸 move、零 submit),
    //   松键/blur/flush 时 settle 一次。settle 路径仍经 wrapMutation(store.moveSelectedNodesBy) →
    //   attach/detach 接线与单次 submitChange 不变(原契约的核心不变量保留)。
    expect(source).toContain('createArrowNudgeThrottle')
    expect(source).toContain('wrapMutation(store.moveSelectedNodesBy)')
    // burst 期间允许裸 store.moveSelectedNodesBy(即时视觉、不 submit) —— 节流设计的有意行为,
    //   原 not.toMatch(/store\.moveSelectedNodesBy\(/) 的逐 keydown 禁令已下线(行为由 throttle 单测覆盖)。
  })

  it('#arrowflood P1:pointerdown(capture 阶段)先 flush pending burst,防选区/场景切换后 A 累计位移永不提交', () => {
    // Greptile P1(结算目标随实时选区漂移):burst 期间 A 的裸移动零 submit;若 pointerdown 不先 flush,
    //   选区/画布切换后 settle 作用于实时选区(B/新画布)→ A 永不提交,刷新后 A 回退。fix:在 window
    //   pointerdown capture 阶段(先于画布/选区/侧栏 click→selectNode/openCanvas 的 bubble handler)调
    //   arrowThrottle.flush()。钉死 addEventListener+capture+handler 体含 flush+removeEventListener 四要素,
    //   防有人删 pointerdown flush 接线(回归 A 回退)。语义(换选区 A 提交 B 零影响)由 arrowNudgeThrottle.test
    //   的 P1 集成测覆盖,本文件只钉源码接线事实。
    expect(source).toContain("addEventListener('pointerdown', handlePointerDown, { capture: true })")
    expect(source).toMatch(/handlePointerDown = \(\) => \{[\s\S]*?arrowThrottle\.flush\(\)/)
    expect(source).toContain('removeEventListener')
  })

  it('paste(clipboardAssets)→ wrapMutation(() => store.pasteClipboardAssets(viewportCenter()))', () => {
    // lambda 包装(保 viewportCenter 落点),regex not-to-match 不适用(lambda body 内含 store.X());只 toContain。
    expect(source).toContain('wrapMutation(() => store.pasteClipboardAssets(viewportCenter()))()')
  })

  it('非 document mutation 的快捷键不在此契约范围(纯 UI 态;useBrushStamp pointer 旁路单列 sibling)', () => {
    // 边界声明(A2 SC lead 裁定):selectNodes/selectNode/setActiveTool/setBrushStyle/copySelectedNodes
    //   (clipboard 只读)/zoomBy/zoomTo/fitAll/fitSelection/reset* 不改 document/nodes/edges,不进
    //   submitChange 同步域,不需 wrapMutation。useBrushStamp.ts pointerup 的 store.addMarkupNode 旁路
    //   是 pointer 交互(非键盘/全局事件),单列 sibling 任务,不在本契约范围。
    expect(true).toBe(true)
  })
})
