/**
 * T0.4① — 表征测试（characterization tests）for canvasActionModel.ts · part 2/2
 *
 * 本文件 + canvasActionModel.characterization.test.ts 共同构成 canvasActionModel.ts 的行为
 * baseline。拆为两文件是为满足项目 structure-guard 的"非白名单 src 文件 ≤900 行"硬门槛
 * （新文件无法走白名单增量语义,见 PR 描述）；合并 baseline 315 expect / 203 tests
 * （part1 162/107 + part2 153/96）见 PR 描述。
 *
 * 迁移后测试一字不改；若测试本身暴露出疑似 bug,默认钉现状、bug 单列进 PR 描述
 * "发现的现状疑点"段,不在测试里"修对"。
 *
 * part 2 覆盖：
 *  ③ markup style + image AI-edit 子菜单 dispatch — mock runtime 断言 store 调用意图与参数
 *  · quick toolbar structure + dispatch — multi / single 各节点类型快捷工具栏结构与分发
 *  ④ 边界 — 空选择 / 多选 / 不同节点类型 / 缺 canvasPosition / locked 能力漂移
 *  · 导出 presets 快照
 *
 * 硬约束：只读 canvasActionModel.ts 的导出,绝不改其本体；runtime 全程 mock。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  contextMenuGroupsFor,
  quickToolbarGroupsFor,
  markupColorPresets,
} from './canvasActionModel'
import { createCanvasSelectionContext } from './canvasSelectionModel'
import type { CanvasActionGroup, CanvasActionItem, CanvasActionRuntime } from './canvasActionTypes'
import type { CanvasNodeType, MarkupKind, MivoCanvasNode } from '../../types/mivoCanvas'
// ─── fixtures ──────────────────────────────────────────────────────────────────

type NodeSeed = Partial<MivoCanvasNode> & { id: string; type: CanvasNodeType }

const node = (seed: NodeSeed): MivoCanvasNode => ({
  title: seed.id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'ready',
  ...seed,
} as MivoCanvasNode)

const imageNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'image', ...over })
const textNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'text', ...over })
const frameNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'frame', ...over })
const annotationNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'annotation', ...over })
const aiSlotNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'ai-slot', ...over })
const markupNode = (id: string, kind: MarkupKind, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'markup', markupKind: kind, ...over })
const pdfNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'pdf', ...over })
const markdownNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'markdown', ...over })
const videoNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'video', ...over })
const taskNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'task-placeholder', ...over })
/** 用真实 createCanvasSelectionContext 构造上下文，capabilities 由 nodeRegistry 真算 ——
 * 这样 locked 节点的能力漂移、common/any 集合都是真现状，不是我们手算的期望。 */
const ctx = (nodes: MivoCanvasNode[], primary?: MivoCanvasNode) =>
  createCanvasSelectionContext(nodes, primary)

// ─── mock runtime ────────────────────────────────────────────────────────────────

/** 构造全 mock 的 CanvasActionRuntime。每个方法都是 vi.fn()，可在测试里断言调用意图。
 *  string 返回方法给默认返回值以走通 happy path（addAnnotationNode 返回 'note-id'
 *  使 beginImageEditPrompt 走到 setActiveTool + onEditText；测试边界时按需 override）。 */
const createRuntime = (
  context: ReturnType<typeof ctx>,
  overrides: Partial<CanvasActionRuntime> & { allNodeIdsOverride?: string[] } = {},
): CanvasActionRuntime => {
  const { allNodeIdsOverride, ...rest } = overrides
  return {
    context,
    clipboardCount: 0,
    hiddenCount: 0,
    allNodeIds: allNodeIdsOverride ?? context.nodes.map((n) => n.id),
    canvasPosition: undefined,
    onOpenDetails: undefined,
    onFitAll: undefined,
    onFitSelection: undefined,
    onCreateTextAt: undefined,
    onCreateFrameAt: undefined,
    onEditText: undefined,
    onRenameNode: undefined,
    onImportAssetAt: undefined,
    onCropNode: undefined,
    onStartImageMaskEdit: undefined,
    onDownloadOriginal: undefined,
    setActiveTool: vi.fn(),
    addTextNode: vi.fn(() => 'text-id'),
    addFrameNode: vi.fn(() => 'frame-id'),
    addAiSlotNode: vi.fn(() => 'slot-id'),
    addAnnotationNode: vi.fn(() => 'note-id'),
    addMarkupNode: vi.fn(() => 'markup-id'),
    updateMarkupStyle: vi.fn(),
    updateSectionStyle: vi.fn(),
    setSectionLockMode: vi.fn(),
    removeSectionOnly: vi.fn(),
    selectNodes: vi.fn(),
    generateVariations: vi.fn(async () => []),
    generateImageEdit: vi.fn(async () => []),
    generateBesideNode: vi.fn(async () => []),
    generateIntoAiSlot: vi.fn(async () => []),
    generateFromAnnotation: vi.fn(async () => []),
    duplicateNode: vi.fn(),
    duplicateSelectedNodes: vi.fn(),
    groupSelectedNodes: vi.fn(),
    ungroupSelectedNodes: vi.fn(),
    copySelectedNodes: vi.fn(),
    pasteClipboardNodes: vi.fn(),
    moveNodeLayer: vi.fn(),
    moveSelectedLayer: vi.fn(),
    alignSelectedNodes: vi.fn(),
    distributeSelectedNodes: vi.fn(),
    arrangeSelectedNodes: vi.fn(),
    toggleSelectedNodesLocked: vi.fn(),
    hideSelectedNodes: vi.fn(),
    showAllHiddenNodes: vi.fn(),
    deleteNode: vi.fn(),
    deleteSelectedNodes: vi.fn(),
    ...rest,
  } as unknown as CanvasActionRuntime
}

// ─── 查询辅助 ──────────────────────────────────────────────────────────────────

/** group id 集合（排序后），用于存在性矩阵（只关心在不在，不关心顺序）。 */
const groupIds = (groups: CanvasActionGroup[]) => groups.map((g) => g.id).sort()

/** group id 真实返回顺序（不排序），用于结构快照钉用户实际看到的 group 顺序。 */
const orderedGroupIds = (groups: CanvasActionGroup[]) => groups.map((g) => g.id)

/** 顶层 action id + 一层 children id（够覆盖本模型的菜单结构）。 */
const deepActionIds = (groups: CanvasActionGroup[]): string[] =>
  groups.flatMap((g) => g.actions.flatMap((a) => [a.id, ...(a.children?.map((c) => c.id) ?? [])]))

/** 在 groups 里按 id 找一个 action（顶层 + 一层 children）。 */
const findAction = (groups: CanvasActionGroup[], id: string): CanvasActionItem | undefined => {
  for (const g of groups) {
    for (const a of g.actions) {
      if (a.id === id) return a
      const child = a.children?.find((c) => c.id === id)
      if (child) return child
    }
  }
  return undefined
}

const hasAction = (groups: CanvasActionGroup[], id: string) => Boolean(findAction(groups, id))

/** 触发某 action 的 onClick（断言其分发意图时用）。 */
const fire = (groups: CanvasActionGroup[], id: string) => {
  const action = findAction(groups, id)
  if (!action) throw new Error(`action not found: ${id}`)
  action.onClick()
}

// ─── tests ──────────────────────────────────────────────────────────────────────

describe('canvasActionModel — characterization · part 2 (③ markup/AI-edit 分发 · quick toolbar · ④ 边界 · presets)', () => {
  // ─── ③ markup style 分发 ──────────────────────────────────────────────────────

  describe('markup context-menu style dispatch', () => {
    it('edit-markup-text → onEditText(id)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([markupNode('m1', 'arrow')]), { onEditText })
      fire(contextMenuGroupsFor(rt), 'edit-markup-text')
      expect(onEditText).toHaveBeenCalledWith('m1')
    })

    it('markup-arrow-none → updateMarkupStyle(m1, {startArrow:false,endArrow:false})', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'arrow')]))
      fire(contextMenuGroupsFor(rt), 'markup-arrow-none')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStartArrow: false, markupEndArrow: false })
    })

    it('markup-arrow-end → updateMarkupStyle(m1, {startArrow:false,endArrow:true})', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'arrow')]))
      fire(contextMenuGroupsFor(rt), 'markup-arrow-end')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStartArrow: false, markupEndArrow: true })
    })

    it('markup-arrow-both → updateMarkupStyle(m1, {startArrow:true,endArrow:true})', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'arrow')]))
      fire(contextMenuGroupsFor(rt), 'markup-arrow-both')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStartArrow: true, markupEndArrow: true })
    })

    it('markup-fill-<soft purple> → updateMarkupStyle fillColor', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'arrow')]))
      fire(contextMenuGroupsFor(rt), 'markup-fill-rgba(105, 87, 232, 0.08)')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupFillColor: 'rgba(105, 87, 232, 0.08)' })
    })

    it('markup-stroke-<Black> → updateMarkupStyle strokeColor', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'rect')]))
      fire(contextMenuGroupsFor(rt), 'markup-stroke-#232323')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStrokeColor: '#232323' })
    })

    it('markup-stroke-dashed → updateMarkupStyle strokeStyle dashed', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'rect')]))
      fire(contextMenuGroupsFor(rt), 'markup-stroke-dashed')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStrokeStyle: 'dashed' })
    })

    it('markup-width-6 → updateMarkupStyle strokeWidth 6', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'rect')]))
      fire(contextMenuGroupsFor(rt), 'markup-width-6')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupStrokeWidth: 6 })
    })

    it('markup-radius-18(rect) → updateMarkupStyle cornerRadius 18', () => {
      const rt = createRuntime(ctx([markupNode('m1', 'rect')]))
      fire(contextMenuGroupsFor(rt), 'markup-radius-18')
      expect(vi.mocked(rt.updateMarkupStyle)).toHaveBeenCalledWith('m1', { markupCornerRadius: 18 })
    })

    it('markup arrowheads 子菜单 selected 状态：默认 arrow → end-arrow selected', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow')])))
      expect(findAction(groups, 'markup-arrow-none')?.selected).toBe(false)
      expect(findAction(groups, 'markup-arrow-end')?.selected).toBe(true)
      expect(findAction(groups, 'markup-arrow-both')?.selected).toBe(false)
    })

    it('markup line → connector 含 arrowheads；默认无箭头（markupEndArrow ?? kind===arrow 不命中 line → hasEndArrow=false）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'line')])))
      expect(hasAction(groups, 'markup-arrowheads')).toBe(true)
      // line 默认 markupEndArrow undefined，?? kind==='arrow' 为 false → 无箭头
      expect(findAction(groups, 'markup-arrow-none')?.selected).toBe(true)
      expect(findAction(groups, 'markup-arrow-end')?.selected).toBe(false)
    })

    it('markup stroke width 默认(undefined) → Medium selected（!==2 && !==6）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow')])))
      expect(findAction(groups, 'markup-width-3')?.selected).toBe(true)
      expect(findAction(groups, 'markup-width-2')?.selected).toBe(false)
      expect(findAction(groups, 'markup-width-6')?.selected).toBe(false)
    })

    it('markup stroke width=2 → Thin selected', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow', { markupStrokeWidth: 2 })])))
      expect(findAction(groups, 'markup-width-2')?.selected).toBe(true)
      expect(findAction(groups, 'markup-width-3')?.selected).toBe(false)
    })
  })

  // ─── ③ image AI edit 子菜单分发 ──────────────────────────────────────────────

  describe('image AI edit context-menu dispatch', () => {
    // 注：imageAiEditActionsFor 仅出现在 quick toolbar 的 ai-edit-menu，contextMenu 不挂。
    // 这一组专门钉这个边界 + 测 quick toolbar 子项的分发意图。

    it('contextMenu 不直接挂 imageAiEditActions（仅 quick toolbar 有）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(hasAction(groups, 'remove-background')).toBe(false)
      expect(hasAction(groups, 'expand-image')).toBe(false)
      expect(hasAction(groups, 'boost-resolution')).toBe(false)
      expect(hasAction(groups, 'edit-with-prompt')).toBe(false)
      expect(hasAction(groups, 'select-area-edit')).toBe(false)
    })

    it('quick toolbar ai-edit-menu 含 5 个子项（固定顺序）', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([imageNode('a')])))
      const menu = findAction(groups, 'ai-edit-menu')
      expect(menu?.children?.map((c) => c.id)).toEqual([
        'edit-with-prompt', 'select-area-edit', 'remove-background', 'expand-image', 'boost-resolution',
      ])
    })

    it('select-area-edit → onStartImageMaskEdit(id)（可选回调）', () => {
      const onStartImageMaskEdit = vi.fn()
      const rt = createRuntime(ctx([imageNode('a')]), { onStartImageMaskEdit })
      fire(quickToolbarGroupsFor(rt), 'select-area-edit')
      expect(onStartImageMaskEdit).toHaveBeenCalledWith('a')
    })

    it('select-area-edit 无 onStartImageMaskEdit 时不抛（可选链安全）', () => {
      const rt = createRuntime(ctx([imageNode('a')]), { onStartImageMaskEdit: undefined })
      expect(() => fire(quickToolbarGroupsFor(rt), 'select-area-edit')).not.toThrow()
    })

    it('remove-background → generateImageEdit(id, remove-background, <prompt>)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(quickToolbarGroupsFor(rt), 'remove-background')
      const call = vi.mocked(rt.generateImageEdit).mock.calls[0]
      expect(call?.[0]).toBe('a')
      expect(call?.[1]).toBe('remove-background')
      expect(call?.[2]).toContain('background')
    })

    it('expand-image → generateImageEdit(id, outpaint, …)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(quickToolbarGroupsFor(rt), 'expand-image')
      const call = vi.mocked(rt.generateImageEdit).mock.calls[0]
      expect(call?.[1]).toBe('outpaint')
    })

    it('boost-resolution → generateImageEdit(id, upscale, …)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(quickToolbarGroupsFor(rt), 'boost-resolution')
      const call = vi.mocked(rt.generateImageEdit).mock.calls[0]
      expect(call?.[1]).toBe('upscale')
    })

    it('edit-with-prompt → addAnnotationNode(id, undefined, instruction, {operation:prompt-edit, title}) 后 setActiveTool(select) + onEditText(noteId)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([imageNode('a', { title: 'Cat' })]), { onEditText })
      fire(quickToolbarGroupsFor(rt), 'edit-with-prompt')
      expect(vi.mocked(rt.addAnnotationNode)).toHaveBeenCalledWith(
        'a', undefined, 'Describe the image edit here',
        { operation: 'prompt-edit', title: 'Prompt edit for Cat' },
      )
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('select')
      expect(onEditText).toHaveBeenCalledWith('note-id')
    })

    it('edit-with-prompt 无 title → title 回退到 image（源码 || "image" 分支）', () => {
      // 真正构造无 title 的 fixture（显式置空串），让 primaryNode?.title 为 falsy，
      // 命中 beginImageEditPrompt 里 `|| 'image'` 的回退分支（canvasActionModel.ts:137）。
      // 改源码回退值时该用例必红；上方 'Cat' 用例覆盖正常标题路径作对照。
      const rt = createRuntime(ctx([imageNode('a', { title: '' })]))
      fire(quickToolbarGroupsFor(rt), 'edit-with-prompt')
      const call = vi.mocked(rt.addAnnotationNode).mock.calls[0]
      expect(call?.[3]).toEqual({ operation: 'prompt-edit', title: 'Prompt edit for image' })
    })

    it('edit-with-prompt · addAnnotationNode 返 undefined → 早退，不调 setActiveTool/onEditText', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([imageNode('a')]), {
        onEditText,
        addAnnotationNode: vi.fn(() => undefined) as unknown as CanvasActionRuntime['addAnnotationNode'],
      })
      fire(quickToolbarGroupsFor(rt), 'edit-with-prompt')
      expect(vi.mocked(rt.setActiveTool)).not.toHaveBeenCalled()
      expect(onEditText).not.toHaveBeenCalled()
    })
  })

  // ─── quick toolbar 结构 & 分发 ─────────────────────────────────────────────────

  describe('quickToolbarGroupsFor · structure', () => {
    it('blank → 空数组', () => {
      expect(quickToolbarGroupsFor(createRuntime(ctx([])))).toEqual([])
    })

    it('multi image×2 → 单一 multi 组', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      // quick toolbar 恒单组，orderedGroupIds 与 groupIds 同值；用 ordered 钉组顺序意图。
      expect(orderedGroupIds(groups)).toEqual(['multi'])
      const ids = deepActionIds(groups)
      expect(ids).toContain('duplicate')
      expect(ids).toContain('group')
      expect(ids).toContain('align-menu')
      expect(ids).toContain('arrange-menu')
      expect(ids).toContain('toggle-lock')
      expect(ids).toContain('bring-front')
    })

    it('multi 已分组 → 含 ungroup 而非 group', () => {
      const groups = quickToolbarGroupsFor(
        createRuntime(ctx([imageNode('a', { groupId: 'g' }), imageNode('b', { groupId: 'g' })])),
      )
      expect(hasAction(groups, 'ungroup')).toBe(true)
      expect(hasAction(groups, 'group')).toBe(false)
    })

    it('multi 2 个 → arrange-grid/tidy disabled', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      expect(findAction(groups, 'arrange-grid')?.disabled).toBe(true)
      expect(findAction(groups, 'arrange-tidy')?.disabled).toBe(true)
    })

    it('multi 3 个 → arrange-grid/tidy enabled', () => {
      const groups = quickToolbarGroupsFor(
        createRuntime(ctx([imageNode('a'), imageNode('b'), imageNode('c')])),
      )
      expect(findAction(groups, 'arrange-grid')?.disabled).toBe(false)
      expect(findAction(groups, 'arrange-tidy')?.disabled).toBe(false)
    })

    it('multi 2 个 → align 子菜单无 distribute', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      const menu = findAction(groups, 'align-menu')
      expect(menu?.children?.map((c) => c.id)).not.toContain('distribute-horizontal')
    })

    it('multi 3 个 → align 子菜单含 distribute 横/纵', () => {
      const groups = quickToolbarGroupsFor(
        createRuntime(ctx([imageNode('a'), imageNode('b'), imageNode('c')])),
      )
      const menu = findAction(groups, 'align-menu')
      expect(menu?.children?.map((c) => c.id)).toContain('distribute-horizontal')
      expect(menu?.children?.map((c) => c.id)).toContain('distribute-vertical')
    })

    it('multi locked 全锁 → toggle-lock label Unlock；bring-front 消失（失 layerable）', () => {
      const groups = quickToolbarGroupsFor(
        createRuntime(ctx([imageNode('a', { locked: true }), imageNode('b', { locked: true })])),
      )
      expect(findAction(groups, 'toggle-lock')?.label).toBe('Unlock')
      expect(hasAction(groups, 'bring-front')).toBe(false)
    })

    it('image quick toolbar → 单一 image 组：crop + ai-edit-menu', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(orderedGroupIds(groups)).toEqual(['image'])
      expect(hasAction(groups, 'crop')).toBe(true)
      expect(hasAction(groups, 'ai-edit-menu')).toBe(true)
    })

    it('text quick toolbar → generate-beside-text / edit-text / duplicate', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([textNode('t1')])))
      expect(groupIds(groups)).toEqual(['text-ai'])
      expect(deepActionIds(groups)).toEqual(['generate-beside-text', 'edit-text', 'duplicate'])
    })

    it('ai-slot quick toolbar → fill-slot / duplicate / bring-front', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([aiSlotNode('s1')])))
      expect(deepActionIds(groups)).toEqual(['fill-slot', 'duplicate', 'bring-front'])
    })

    it('annotation quick toolbar → generate-from-note / edit-note / duplicate', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([annotationNode('n1')])))
      expect(deepActionIds(groups)).toEqual(['generate-from-note', 'edit-note', 'duplicate'])
    })

    it('frame quick toolbar → section-fill/line/rename-frame/section-title/section-lock/fit-section?(onFitSelection)', () => {
      const groups = quickToolbarGroupsFor(
        createRuntime(ctx([frameNode('f1')]), { onFitSelection: vi.fn() }),
      )
      expect(orderedGroupIds(groups)).toEqual(['frame'])
      const ids = deepActionIds(groups)
      expect(ids).toContain('section-fill')
      expect(ids).toContain('section-line')
      expect(ids).toContain('rename-frame')
      expect(ids).toContain('section-title')
      expect(ids).toContain('section-lock')
      expect(ids).toContain('fit-section')
    })

    it('frame quick toolbar 无 onFitSelection → 无 fit-section', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([frameNode('f1')])))
      expect(hasAction(groups, 'fit-section')).toBe(false)
    })

    it('pdf quick toolbar → file 组 download-original（pdfAsset 能力命中）', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([pdfNode('p1')])))
      expect(groupIds(groups)).toEqual(['file'])
      expect(deepActionIds(groups)).toEqual(['download-original'])
    })

    it('markdown quick toolbar 为空（fileQuickToolbar 仅命中 pdfAsset，markdown 只有 markdownDoc）', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([markdownNode('md1')])))
      expect(groups).toEqual([])
    })

    it('video quick toolbar 为空（只有 videoAsset，非 pdfAsset）', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([videoNode('v1')])))
      expect(groups).toEqual([])
    })

    it('markup arrow quick toolbar → edit-markup-text + style 子菜单 + duplicate + bring-front + delete', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow')])))
      const ids = deepActionIds(groups)
      expect(ids).toContain('edit-markup-text')
      expect(ids).toContain('markup-arrowheads')
      expect(ids).toContain('markup-fill-color')
      expect(ids).toContain('markup-line-style')
      expect(ids).toContain('duplicate')
      expect(ids).toContain('bring-front')
      expect(ids).toContain('delete')
      expect(findAction(groups, 'delete')?.danger).toBe(true)
    })

    it('markup stamp quick toolbar → 无 edit/style，仅 duplicate + bring-front + delete', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([markupNode('s1', 'stamp')])))
      const ids = deepActionIds(groups)
      expect(ids).not.toContain('edit-markup-text')
      expect(ids).not.toContain('markup-line-style')
      expect(ids).toEqual(['duplicate', 'bring-front', 'delete'])
    })

    it('task-placeholder quick toolbar 为空（quickToolbarExtensionsByNodeType 未注册 task-placeholder 键，虽 task 有 imageAsset 能力）', () => {
      // 现状疑点：contextMenuExtensionsByNodeType 注册了 'task-placeholder' → generation 菜单，
      // 但 quickToolbarExtensionsByNodeType 未注册 → quick toolbar 空。与 image（两者都有）不对称。
      const groups = quickToolbarGroupsFor(createRuntime(ctx([taskNode('tp1')])))
      expect(groups).toEqual([])
    })
  })

  describe('quickToolbarGroupsFor · dispatch', () => {
    it('multi duplicate → duplicateSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'duplicate')
      expect(vi.mocked(rt.duplicateSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('multi group → groupSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'group')
      expect(vi.mocked(rt.groupSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('multi ungroup → ungroupSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a', { groupId: 'g' }), imageNode('b', { groupId: 'g' })]))
      fire(quickToolbarGroupsFor(rt), 'ungroup')
      expect(vi.mocked(rt.ungroupSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('multi toggle-lock → toggleSelectedNodesLocked()', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'toggle-lock')
      expect(vi.mocked(rt.toggleSelectedNodesLocked)).toHaveBeenCalledTimes(1)
    })

    it('multi bring-front → moveSelectedLayer(front)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'bring-front')
      expect(vi.mocked(rt.moveSelectedLayer)).toHaveBeenCalledWith('front')
    })

    it('multi align-menu 子项 align-right → alignSelectedNodes(right)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'align-right')
      expect(vi.mocked(rt.alignSelectedNodes)).toHaveBeenCalledWith('right')
    })

    it('multi align-menu 父 onClick → alignSelectedNodes(center)（默认）', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'align-menu')
      expect(vi.mocked(rt.alignSelectedNodes)).toHaveBeenCalledWith('center')
    })

    it('multi arrange-menu 子项 arrange-column → arrangeSelectedNodes(column)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'arrange-column')
      expect(vi.mocked(rt.arrangeSelectedNodes)).toHaveBeenCalledWith('column')
    })

    it('multi arrange-menu 父 onClick → arrangeSelectedNodes(tidy)（默认）', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(quickToolbarGroupsFor(rt), 'arrange-menu')
      expect(vi.mocked(rt.arrangeSelectedNodes)).toHaveBeenCalledWith('tidy')
    })

    it('multi distribute-horizontal → distributeSelectedNodes(horizontal)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b'), imageNode('c')]))
      fire(quickToolbarGroupsFor(rt), 'distribute-horizontal')
      expect(vi.mocked(rt.distributeSelectedNodes)).toHaveBeenCalledWith('horizontal')
    })

    it('image quick crop → onCropNode(id)', () => {
      const onCropNode = vi.fn()
      const rt = createRuntime(ctx([imageNode('a')]), { onCropNode })
      fire(quickToolbarGroupsFor(rt), 'crop')
      expect(onCropNode).toHaveBeenCalledWith('a')
    })

    it('ai-slot fill-slot → generateIntoAiSlot(id)', () => {
      const rt = createRuntime(ctx([aiSlotNode('s1')]))
      fire(quickToolbarGroupsFor(rt), 'fill-slot')
      expect(vi.mocked(rt.generateIntoAiSlot)).toHaveBeenCalledWith('s1')
    })

    it('ai-slot duplicate → duplicateNode(id)（single 走 duplicateNode）', () => {
      const rt = createRuntime(ctx([aiSlotNode('s1')]))
      fire(quickToolbarGroupsFor(rt), 'duplicate')
      expect(vi.mocked(rt.duplicateNode)).toHaveBeenCalledWith('s1')
    })

    it('annotation generate-from-note → generateFromAnnotation(id)', () => {
      const rt = createRuntime(ctx([annotationNode('n1')]))
      fire(quickToolbarGroupsFor(rt), 'generate-from-note')
      expect(vi.mocked(rt.generateFromAnnotation)).toHaveBeenCalledWith('n1')
    })

    it('annotation edit-note → onEditText(id)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([annotationNode('n1')]), { onEditText })
      fire(quickToolbarGroupsFor(rt), 'edit-note')
      expect(onEditText).toHaveBeenCalledWith('n1')
    })

    it('text generate-beside-text → generateBesideNode(id)', () => {
      const rt = createRuntime(ctx([textNode('t1')]))
      fire(quickToolbarGroupsFor(rt), 'generate-beside-text')
      expect(vi.mocked(rt.generateBesideNode)).toHaveBeenCalledWith('t1')
    })

    it('text edit-text → onEditText(id)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([textNode('t1')]), { onEditText })
      fire(quickToolbarGroupsFor(rt), 'edit-text')
      expect(onEditText).toHaveBeenCalledWith('t1')
    })

    it('frame rename-frame → onRenameNode(id)', () => {
      const onRenameNode = vi.fn()
      const rt = createRuntime(ctx([frameNode('f1')]), { onRenameNode })
      fire(quickToolbarGroupsFor(rt), 'rename-frame')
      expect(onRenameNode).toHaveBeenCalledWith('f1')
    })

    it('pdf download-original → onDownloadOriginal(primaryNode)', () => {
      const onDownloadOriginal = vi.fn()
      const primary = pdfNode('p1')
      const rt = createRuntime(ctx([primary]), { onDownloadOriginal })
      fire(quickToolbarGroupsFor(rt), 'download-original')
      expect(onDownloadOriginal).toHaveBeenCalledWith(primary)
    })

    it('markup stamp delete → deleteNode(id)', () => {
      const rt = createRuntime(ctx([markupNode('s1', 'stamp')]))
      fire(quickToolbarGroupsFor(rt), 'delete')
      expect(vi.mocked(rt.deleteNode)).toHaveBeenCalledWith('s1')
    })

    it('markup quick edit-markup-text → onEditText(id)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([markupNode('m1', 'arrow')]), { onEditText })
      fire(quickToolbarGroupsFor(rt), 'edit-markup-text')
      expect(onEditText).toHaveBeenCalledWith('m1')
    })
  })

  // ─── ④ 边界 & edge cases ──────────────────────────────────────────────────────

  describe('boundaries & edge cases', () => {
    it('blank quick toolbar 为空', () => {
      expect(quickToolbarGroupsFor(createRuntime(ctx([])))).toEqual([])
    })

    it('blank contextMenu 无 danger 组（blank 分支早返回）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([])))
      expect(groupIds(groups)).not.toContain('danger')
    })

    it('无 primaryNode 的 single（理论边界）→ view-details 仍出现（出现条件只看 kind），但节点类型扩展组缺失', () => {
      // 构造一个 kind=single 但 primaryNode 缺失的运行时（直接 mock context）。
      // 现状疑点：view-details 的存在性只看 context.kind==='single'，不校验 primaryNode 是否存在。
      const fakeCtx = {
        kind: 'single', nodes: [imageNode('a')], primaryNode: undefined,
        selectedCount: 1, commonCapabilities: new Set(), anyCapabilities: new Set(), objectTypes: new Set(['image']),
      } as unknown as ReturnType<typeof ctx>
      const groups = contextMenuGroupsFor(createRuntime(fakeCtx))
      expect(hasAction(groups, 'view-details')).toBe(true)
      // nodeContextMenuGroupsFor 因 !primaryNode 返 [] → generate/edit/section/markup 组全缺
      expect(groupIds(groups)).not.toContain('generate')
      expect(groupIds(groups)).not.toContain('edit')
    })

    it('缺 canvasPosition：new-text → setActiveTool(text)（不创建）', () => {
      const rt = createRuntime(ctx([]), { canvasPosition: undefined })
      fire(contextMenuGroupsFor(rt), 'new-text')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('text')
      expect(vi.mocked(rt.addTextNode)).not.toHaveBeenCalled()
    })

    it('有 canvasPosition + 无 onCreateTextAt → new-text → addTextNode(pos)', () => {
      const pos = { x: 100, y: 200 }
      const rt = createRuntime(ctx([]), { canvasPosition: pos, onCreateTextAt: undefined })
      fire(contextMenuGroupsFor(rt), 'new-text')
      expect(vi.mocked(rt.addTextNode)).toHaveBeenCalledWith(pos)
    })

    it('有 canvasPosition + onCreateTextAt → new-text → onCreateTextAt(pos)（优先回调）', () => {
      const pos = { x: 100, y: 200 }
      const onCreateTextAt = vi.fn()
      const rt = createRuntime(ctx([]), { canvasPosition: pos, onCreateTextAt })
      fire(contextMenuGroupsFor(rt), 'new-text')
      expect(onCreateTextAt).toHaveBeenCalledWith(pos)
      expect(vi.mocked(rt.addTextNode)).not.toHaveBeenCalled()
    })

    it('缺 canvasPosition：new-section → setActiveTool(frame)', () => {
      const rt = createRuntime(ctx([]), { canvasPosition: undefined })
      fire(contextMenuGroupsFor(rt), 'new-section')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('frame')
    })

    it('有 canvasPosition + onCreateFrameAt → new-section → onCreateFrameAt(pos)', () => {
      const pos = { x: 5, y: 6 }
      const onCreateFrameAt = vi.fn()
      const rt = createRuntime(ctx([]), { canvasPosition: pos, onCreateFrameAt })
      fire(contextMenuGroupsFor(rt), 'new-section')
      expect(onCreateFrameAt).toHaveBeenCalledWith(pos)
    })

    it('有 canvasPosition 无 onCreateFrameAt → new-section → addFrameNode(pos)', () => {
      const pos = { x: 5, y: 6 }
      const rt = createRuntime(ctx([]), { canvasPosition: pos })
      fire(contextMenuGroupsFor(rt), 'new-section')
      expect(vi.mocked(rt.addFrameNode)).toHaveBeenCalledWith(pos)
    })

    it('有 canvasPosition → new-ai-slot → addAiSlotNode(pos-160)', () => {
      const pos = { x: 200, y: 200 }
      const rt = createRuntime(ctx([]), { canvasPosition: pos })
      fire(contextMenuGroupsFor(rt), 'new-ai-slot')
      expect(vi.mocked(rt.addAiSlotNode)).toHaveBeenCalledWith({ x: 40, y: 40 })
    })

    it('缺 canvasPosition → new-ai-slot → addAiSlotNode({-160,-160})（默认 {0,0}）', () => {
      const rt = createRuntime(ctx([]), { canvasPosition: undefined })
      fire(contextMenuGroupsFor(rt), 'new-ai-slot')
      expect(vi.mocked(rt.addAiSlotNode)).toHaveBeenCalledWith({ x: -160, y: -160 })
    })

    it('new-arrow-markup → addMarkupNode(arrow, pos-80/48, {160,96}, {points:[…]})', () => {
      const pos = { x: 200, y: 200 }
      const rt = createRuntime(ctx([]), { canvasPosition: pos })
      fire(contextMenuGroupsFor(rt), 'new-arrow-markup')
      expect(vi.mocked(rt.addMarkupNode)).toHaveBeenCalledWith(
        'arrow',
        { x: 120, y: 152 },
        { width: 160, height: 96 },
        { points: [{ x: 8, y: 88 }, { x: 152, y: 8 }] },
      )
    })

    it('new-rect-markup → addMarkupNode(rect, …, points undefined)', () => {
      const pos = { x: 200, y: 200 }
      const rt = createRuntime(ctx([]), { canvasPosition: pos })
      fire(contextMenuGroupsFor(rt), 'new-rect-markup')
      const call = vi.mocked(rt.addMarkupNode).mock.calls[0]
      expect(call?.[0]).toBe('rect')
      expect(call?.[3]?.points).toBeUndefined()
    })

    it('new-note-markup → addMarkupNode(note, …, points undefined)', () => {
      const pos = { x: 200, y: 200 }
      const rt = createRuntime(ctx([]), { canvasPosition: pos })
      fire(contextMenuGroupsFor(rt), 'new-note-markup')
      const call = vi.mocked(rt.addMarkupNode).mock.calls[0]
      expect(call?.[0]).toBe('note')
      expect(call?.[3]?.points).toBeUndefined()
    })

    it('import-asset 有 canvasPosition + onImportAssetAt → onImportAssetAt(pos)', () => {
      const pos = { x: 7, y: 8 }
      const onImportAssetAt = vi.fn()
      const rt = createRuntime(ctx([]), { canvasPosition: pos, onImportAssetAt })
      fire(contextMenuGroupsFor(rt), 'import-asset')
      expect(onImportAssetAt).toHaveBeenCalledWith(pos)
    })

    it('import-asset 缺 canvasPosition → setActiveTool(import)', () => {
      const rt = createRuntime(ctx([]), { canvasPosition: undefined })
      fire(contextMenuGroupsFor(rt), 'import-asset')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('import')
    })

    it('import-asset 有 canvasPosition 但无 onImportAssetAt → setActiveTool(import)', () => {
      const rt = createRuntime(ctx([]), { canvasPosition: { x: 1, y: 1 }, onImportAssetAt: undefined })
      fire(contextMenuGroupsFor(rt), 'import-asset')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('import')
    })

    it('multi 异质 [image, markdown] → objectLabel objects（markdown 多选走 else 分支）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), markdownNode('b')])))
      expect(findAction(groups, 'copy')?.label).toBe('Copy 2 objects')
    })

    it('multi 同质 markdown×2 → objectLabel Markdown documents', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markdownNode('a'), markdownNode('b')])))
      expect(findAction(groups, 'copy')?.label).toBe('Copy 2 Markdown documents')
    })

    it('multi 同质 text×2 → objectLabel text items', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([textNode('a'), textNode('b')])))
      expect(findAction(groups, 'copy')?.label).toBe('Copy 2 text items')
    })

    it('multi 同质 pdf×2 → objectLabel PDFs', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([pdfNode('a'), pdfNode('b')])))
      expect(findAction(groups, 'copy')?.label).toBe('Copy 2 PDFs')
    })

    it('multi 同质 video×2 → objectLabel videos', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([videoNode('a'), videoNode('b')])))
      expect(findAction(groups, 'copy')?.label).toBe('Copy 2 videos')
    })

    it('single video → quick toolbar 为空（video 无 pdfAsset，不命中 fileQuickToolbar）', () => {
      expect(quickToolbarGroupsFor(createRuntime(ctx([videoNode('v1')])))).toEqual([])
    })

    it('single markdown → quick toolbar 为空（markdown 不命中 fileQuickToolbar 的 pdfAsset）', () => {
      expect(quickToolbarGroupsFor(createRuntime(ctx([markdownNode('m1')])))).toEqual([])
    })

    it('single pdf → quick toolbar 有 download-original', () => {
      const groups = quickToolbarGroupsFor(createRuntime(ctx([pdfNode('p1')])))
      expect(hasAction(groups, 'download-original')).toBe(true)
    })

    it('single markup stamp → contextMenu 无 markup-text/markup-style 组', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('s1', 'stamp')])))
      expect(groupIds(groups)).not.toContain('markup-text')
      expect(groupIds(groups)).not.toContain('markup-style')
    })

    it('single markup brush → 非 connector 非 rect：无 arrowheads/corner-radius', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('b1', 'brush')])))
      expect(hasAction(groups, 'markup-arrowheads')).toBe(false)
      expect(hasAction(groups, 'markup-corner-radius')).toBe(false)
      expect(hasAction(groups, 'markup-line-style')).toBe(true)
      expect(hasAction(groups, 'markup-fill-color')).toBe(true)
    })

    it('multi 全锁 image×2 → arrange 消失（common 失 layerable）', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a', { locked: true }), imageNode('b', { locked: true })])),
      )
      expect(groupIds(groups)).not.toContain('arrange')
    })

    it('multi 全锁 → toggle-lock label Unlock images（同质 image，objectLabel=images）', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a', { locked: true }), imageNode('b', { locked: true })])),
      )
      expect(findAction(groups, 'toggle-lock')?.label).toBe('Unlock images')
    })

    it('multi 半锁 → toggle-lock label Lock images（有未锁节点）', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a', { locked: true }), imageNode('b')])),
      )
      expect(findAction(groups, 'toggle-lock')?.label).toBe('Lock images')
    })
  })

  // ─── 导出 presets ─────────────────────────────────────────────────────────────

  describe('exported presets', () => {
    it('markupColorPresets 含 6 色，首项 Black #232323', () => {
      expect(markupColorPresets).toHaveLength(6)
      expect(markupColorPresets[0]).toEqual({ label: 'Black', value: '#232323' })
    })

    it('markupColorPresets 含 Purple/Blue/Red/Green/Orange', () => {
      const labels = markupColorPresets.map((p) => p.label)
      expect(labels).toEqual(['Black', 'Purple', 'Blue', 'Red', 'Green', 'Orange'])
    })
  })
})

// BASELINE COUNT (part 2): part 2 = 153 expect / 96 tests。part 1+2 合计 315 expect / 203 tests
// （part1 162 expect / 107 tests,含 10 个 it.each 参数化行）。迁移前后须一致；
// 若数量变化说明行为已改变,需在 PR 中显式说明。
// 分块：③ markup/AI-edit 分发 · quick toolbar 结构与分发（含 orderedGroupIds）·
// ④ 边界 · 导出 presets。
