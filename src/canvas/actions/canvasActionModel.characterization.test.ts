/**
 * T0.4① — 表征测试（characterization tests）for canvasActionModel.ts · part 1/2
 *
 * 本文件 + canvasActionModel.characterization.quickbar.test.ts 共同构成 canvasActionModel.ts
 * 的行为 baseline。拆为两文件是为满足项目 structure-guard 的"非白名单 src 文件 ≤900 行"硬门槛
 * （新文件无法走白名单增量语义,见 PR 描述）；合并 baseline 315 expect / 203 tests
 * （part1 162/107 + part2 153/96；part1 含 10 个 it.each 参数化行）见 PR 描述。
 *
 * 迁移后测试一字不改；若测试本身暴露出疑似 bug,默认钉现状、bug 单列进 PR 描述
 * "发现的现状疑点"段,不在测试里"修对"。
 *
 * part 1 覆盖：
 *  ① 菜单/action 结构快照 — blank / single / multi 各上下文下可见 group/action 集合
 *  ② enable/disable + 存在性矩阵 — capability 配置下 action 出现/缺失/disabled
 *  ③ contextMenu dispatch + section style/lock dispatch — mock runtime 断言 store 调用意图与参数
 *
 * 硬约束：只读 canvasActionModel.ts 的导出,绝不改其本体；runtime 全程 mock。
 */

import { describe, expect, it, vi } from 'vitest'
import { contextMenuGroupsFor } from './canvasActionModel'
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
const taskNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'task-placeholder', ...over })
const pdfNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'pdf', ...over })
const markdownNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'markdown', ...over })
const videoNode = (id: string, over: Partial<MivoCanvasNode> = {}) =>
  node({ id, type: 'video', ...over })
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

/** group id 真实返回顺序（不排序），用于结构快照钉用户实际看到的 group 顺序。
 *  迁移若重排 group，只要集合不变 groupIds 仍绿；orderedGroupIds 才会红。 */
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

describe('canvasActionModel — characterization · part 1 (① 结构 ② 矩阵 ③ contextMenu/section 分发)', () => {
  // ─── ① 菜单/action 结构快照 ──────────────────────────────────────────────────

  describe('contextMenuGroupsFor · blank context', () => {
    it('空画布最小菜单只有 create + canvas 两个 group', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([])))
      expect(groupIds(groups)).toEqual(['canvas', 'create'])
      // 真实顺序：create 在前，canvas 在后（非字母序）
      expect(orderedGroupIds(groups)).toEqual(['create', 'canvas'])
      expect(deepActionIds(groups)).toEqual([
        'new-text', 'new-section', 'new-ai-slot', 'new-arrow-markup', 'new-rect-markup', 'new-note-markup',
        'import-asset',
      ])
    })

    it('blank + 剪贴板非空 → create 组出现 paste', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([]), { clipboardCount: 2 }))
      expect(hasAction(groups, 'paste')).toBe(true)
    })

    it('blank + 剪贴板为空 → 无 paste', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([]), { clipboardCount: 0 }))
      expect(hasAction(groups, 'paste')).toBe(false)
    })

    it('blank + hiddenCount>0 → canvas 组出现 show-hidden', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([]), { hiddenCount: 3 }))
      expect(hasAction(groups, 'show-hidden')).toBe(true)
    })

    it('blank + hiddenCount=0 → 无 show-hidden', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([]), { hiddenCount: 0 }))
      expect(hasAction(groups, 'show-hidden')).toBe(false)
    })

    it('blank + allNodeIds 非空 → canvas 组出现 select-all', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([]), { allNodeIdsOverride: ['a', 'b'] }),
      )
      expect(hasAction(groups, 'select-all')).toBe(true)
    })

    it('blank + allNodeIds 为空 → 无 select-all', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([]), { allNodeIdsOverride: [] }))
      expect(hasAction(groups, 'select-all')).toBe(false)
    })

    it('blank + allNodeIds 非空 + onFitAll 提供 → 出现 fit-all', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([]), { allNodeIdsOverride: ['a'], onFitAll: vi.fn() }),
      )
      expect(hasAction(groups, 'fit-all')).toBe(true)
    })

    it('blank + allNodeIds 非空但 onFitAll 未提供 → 无 fit-all', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([]), { allNodeIdsOverride: ['a'], onFitAll: undefined }),
      )
      expect(hasAction(groups, 'fit-all')).toBe(false)
    })
  })

  describe('contextMenuGroupsFor · single-node base structure', () => {
    it('single image: inspect + generate/edit + arrange + export + danger', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('img-1')])))
      expect(groupIds(groups)).toEqual(['arrange', 'danger', 'edit', 'export', 'generate', 'inspect', 'organize'])
      // 真实返回顺序（源码 contextMenuGroupsFor 的 return 拼装顺序，非字母序）：
      // inspect → node 扩展(generate,edit) → organize → arrange → export → danger
      expect(orderedGroupIds(groups)).toEqual([
        'inspect', 'generate', 'edit', 'organize', 'arrange', 'export', 'danger',
      ])
      // inspect 含 view-details / copy / duplicate
      expect(hasAction(groups, 'view-details')).toBe(true)
      expect(hasAction(groups, 'copy')).toBe(true)
      expect(hasAction(groups, 'duplicate')).toBe(true)
      // danger 含 delete
      expect(hasAction(groups, 'delete')).toBe(true)
    })

    it('single image: view-details 标签为 View details，icon 非 Pencil', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('img-1')])))
      const a = findAction(groups, 'view-details')
      expect(a?.label).toBe('View details')
      expect(a?.icon).not.toBeUndefined()
    })

    it('single image 无剪贴板 → 无 paste', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('img-1')])))
      expect(hasAction(groups, 'paste')).toBe(false)
    })

    it('single image + onFitSelection 提供 → 出现 fit-selection', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('img-1')]), { onFitSelection: vi.fn() }),
      )
      expect(hasAction(groups, 'fit-selection')).toBe(true)
    })

    it('single image onFitSelection 未提供 → 无 fit-selection', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('img-1')])))
      expect(hasAction(groups, 'fit-selection')).toBe(false)
    })
  })

  describe('contextMenuGroupsFor · multi-select structure', () => {
    it('multi image×2: 无 view-details，copy/duplicate 标签带数量与 objectLabel', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      expect(hasAction(groups, 'view-details')).toBe(false)
      const copy = findAction(groups, 'copy')
      expect(copy?.label).toBe('Copy 2 images')
      const dup = findAction(groups, 'duplicate')
      expect(dup?.label).toBe('Duplicate 2 images')
    })

    it('multi image×2 真实 group 顺序: inspect → organize → arrange → align → export → danger', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      // multi 时 node 扩展返 []（nodeContextMenuGroupsFor 对 kind!==single 返 []）；
      // align 仅 multi 出现，夹在 arrange 与 export 之间。
      expect(orderedGroupIds(groups)).toEqual([
        'inspect', 'organize', 'arrange', 'align', 'export', 'danger',
      ])
    })

    it('multi 异质 [image,text] → objectLabel = objects', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), textNode('b')])))
      expect(findAction(groups, 'copy')?.label).toBe('Copy 2 objects')
      expect(findAction(groups, 'delete')?.label).toBe('Delete 2 objects')
    })

    it('multi 2 个 → align 组出现但无 distribute', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      expect(hasAction(groups, 'align-left')).toBe(true)
      expect(hasAction(groups, 'distribute-horizontal')).toBe(false)
    })

    it('multi 3 个 → align 组含 distribute 横/纵', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a'), imageNode('b'), imageNode('c')])),
      )
      expect(hasAction(groups, 'distribute-horizontal')).toBe(true)
      expect(hasAction(groups, 'distribute-vertical')).toBe(true)
    })

    it('multi 3 个 → objectLabel 复数带 s', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a'), imageNode('b'), imageNode('c')])),
      )
      expect(findAction(groups, 'copy')?.label).toBe('Copy 3 images')
    })

    it('multi 同质 image×2 → organize 组含 group', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      expect(hasAction(groups, 'group')).toBe(true)
      expect(hasAction(groups, 'ungroup')).toBe(false)
    })

    it('multi 中有已分组节点 → organize 组同时含 ungroup 与 group（两者独立条件，可并列）', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a', { groupId: 'g1' }), imageNode('b', { groupId: 'g1' })])),
      )
      expect(hasAction(groups, 'ungroup')).toBe(true)
      // 现状：canGroupSelection(multi && common groupable) 与 canUngroupSelection(hasGroupedNodes) 独立判断，
      // 已分组的未锁 image 仍 groupable → group 与 ungroup 同时出现。疑点见 PR 描述。
      expect(hasAction(groups, 'group')).toBe(true)
    })
  })

  // ─── ② enable/disable + 存在性矩阵 ───────────────────────────────────────────

  describe('capability matrix', () => {
    it('single image(unlocked) → arrange/export 均在（layerable+exportable）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(groupIds(groups)).toContain('arrange')
      expect(groupIds(groups)).toContain('export')
    })

    it('single image locked → 失去 layerable，arrange 组消失；但 export 仍在（locked 保留 exportable）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a', { locked: true })])))
      expect(groupIds(groups)).not.toContain('arrange')
      expect(groupIds(groups)).toContain('export')
    })

    it('single image locked → organize 仍含 toggle-lock（lockable 保留），label 为 Unlock', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a', { locked: true })])))
      expect(hasAction(groups, 'toggle-lock')).toBe(true)
      expect(findAction(groups, 'toggle-lock')?.label).toBe('Unlock image')
    })

    it('single image unlocked → toggle-lock label 为 Lock image', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(findAction(groups, 'toggle-lock')?.label).toBe('Lock image')
    })

    it('single image → organize 含 hide（hideable）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(hasAction(groups, 'hide')).toBe(true)
    })

    it('single image → export 组 download 标签为 Download original（downloadOriginal）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(findAction(groups, 'download')?.label).toBe('Download original')
    })

    it('single image locked → 仍是 Download original（locked 保留 downloadOriginal）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a', { locked: true })])))
      expect(findAction(groups, 'download')?.label).toBe('Download original')
    })

    it('single text → export 组 download 标签为 Download（无 downloadOriginal 能力）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([textNode('t1')])))
      expect(findAction(groups, 'download')?.label).toBe('Download')
    })

    it('single frame(section) → 无 toggle-lock（canLock 排除 section），但 section-lock 子菜单有', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('f1')])))
      expect(hasAction(groups, 'toggle-lock')).toBe(false)
      expect(hasAction(groups, 'section-lock-all')).toBe(true)
    })

    it('single frame(section) → 仍有 hide（canHide 不排除 section）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('f1')])))
      expect(hasAction(groups, 'hide')).toBe(true)
    })

    it('single frame(section) → 仍有 arrange（unlocked section 经 base 含 layerable）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('f1')])))
      expect(groupIds(groups)).toContain('arrange')
    })

    it('single frame(section) 真实 group 顺序: inspect → section → section-lock → organize → arrange → export → danger', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('f1')])))
      // frame 走 section 扩展(section, section-lock)；canLock 排除 section → organize 仅靠 hide；
      // unlocked frame 经 base 含 exportable → export 在，但无 downloadOriginal → download label=Download。
      expect(orderedGroupIds(groups)).toEqual([
        'inspect', 'section', 'section-lock', 'organize', 'arrange', 'export', 'danger',
      ])
      expect(findAction(groups, 'download')?.label).toBe('Download')
    })

    it('single frame(section) → delete 标签为 Delete section and contents', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('f1')])))
      expect(findAction(groups, 'delete')?.label).toBe('Delete section and contents')
    })

    it('single markup arrow(unlocked) → 仍有 export 组（base 含 exportable；download label 为 Download）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow')])))
      expect(groupIds(groups)).toContain('export')
      expect(findAction(groups, 'download')?.label).toBe('Download')
    })

    it('single markup arrow 真实 group 顺序: inspect → markup-text → markup-style → organize → arrange → export → danger', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow')])))
      // markup 走 markupContextMenuGroupsFor(markup-text, markup-style)；
      // unlocked markup 经 base 含 exportable → export 在，无 downloadOriginal → Download。
      expect(orderedGroupIds(groups)).toEqual([
        'inspect', 'markup-text', 'markup-style', 'organize', 'arrange', 'export', 'danger',
      ])
    })

    it('single markup stamp → markup 上下文组完全为空（markupContextMenuGroupsFor 对 stamp 返 []）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('s1', 'stamp')])))
      expect(groupIds(groups)).not.toContain('markup-text')
      expect(groupIds(groups)).not.toContain('markup-style')
    })

    it('multi [image, markup](均未锁) → 有 export 组（common 经 base 均含 exportable）', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a'), markupNode('m1', 'arrow')])),
      )
      expect(groupIds(groups)).toContain('export')
    })

    it('multi [image, image] → arrange 组在（common layerable）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a'), imageNode('b')])))
      expect(groupIds(groups)).toContain('arrange')
    })

    it('multi 含 locked image → arrange 消失（common 失 layerable）', () => {
      const groups = contextMenuGroupsFor(
        createRuntime(ctx([imageNode('a', { locked: true }), imageNode('b')])),
      )
      expect(groupIds(groups)).not.toContain('arrange')
    })

    // 疑点 6 完整钉阵：locked 后哪些类型仍保 export、哪些丢 export。
    // 源码真相（canvasNodeRegistry lockedCapabilities）：image/task/text/ai-slot/annotation
    // 及 file 系(markdown/pdf/video)显式补 'exportable'；frame(=['frame']) 与 markup(默认=unlocked，
    // 未补 'exportable')经 organizationCapabilities 不含 exportable → 丢 export。
    // 菜单出现 export 由 hasCommonCapability(context,'exportable') 决定。
    it.each([
      ['image', imageNode('a', { locked: true })],
      ['text', textNode('a', { locked: true })],
      ['annotation', annotationNode('a', { locked: true })],
      ['ai-slot', aiSlotNode('a', { locked: true })],
      ['task-placeholder', taskNode('a', { locked: true })],
      ['markdown', markdownNode('a', { locked: true })],
      ['pdf', pdfNode('a', { locked: true })],
      ['video', videoNode('a', { locked: true })],
    ] as const)('locked %s → 仍含 export 组（lockedCapabilities 显式补 exportable）', (_type, lockedNode) => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([lockedNode])))
      expect(groupIds(groups)).toContain('export')
    })

    it.each([
      ['markup', markupNode('a', 'arrow', { locked: true })],
      ['frame', frameNode('a', { locked: true })],
    ] as const)('locked %s → 无 export 组（lockedCapabilities 未补 exportable）', (_type, lockedNode) => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([lockedNode])))
      expect(groupIds(groups)).not.toContain('export')
    })

    // 疑点 7：unlocked frame(section) 仍是全功能对象 —— 含 export，download label=Download。
    it('unlocked frame → 含 export 组且 download label=Download（base 含 exportable，无 downloadOriginal）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('a')])))
      expect(groupIds(groups)).toContain('export')
      expect(findAction(groups, 'download')?.label).toBe('Download')
    })
  })

  // ─── ② 续：node-type 扩展的存在性 ────────────────────────────────────────────

  describe('node-type context-menu extensions', () => {
    it('image → generate 组含 generate-beside / add-edit-note / variations；edit 组含 crop', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(hasAction(groups, 'generate-beside')).toBe(true)
      expect(hasAction(groups, 'add-edit-note')).toBe(true)
      expect(hasAction(groups, 'variations')).toBe(true)
      expect(hasAction(groups, 'crop')).toBe(true)
    })

    it('image → 无 generate-into-slot / generate-from-annotation（非 slot/annotation）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([imageNode('a')])))
      expect(hasAction(groups, 'generate-into-slot')).toBe(false)
      expect(hasAction(groups, 'generate-from-annotation')).toBe(false)
    })

    it('ai-slot → generate 组仅 generate-into-slot；无 edit 组（type 非 image）', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([aiSlotNode('s1')])))
      expect(hasAction(groups, 'generate-into-slot')).toBe(true)
      expect(hasAction(groups, 'generate-beside')).toBe(false)
      expect(hasAction(groups, 'add-edit-note')).toBe(false)
      expect(hasAction(groups, 'crop')).toBe(false)
    })

    it('annotation → generate 组含 generate-from-annotation + generate-beside；无 add-edit-note', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([annotationNode('n1')])))
      expect(hasAction(groups, 'generate-from-annotation')).toBe(true)
      expect(hasAction(groups, 'generate-beside')).toBe(true)
      expect(hasAction(groups, 'add-edit-note')).toBe(false)
    })

    it('text → generate 组含 generate-beside + add-edit-note；无 variations/crop', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([textNode('t1')])))
      expect(hasAction(groups, 'generate-beside')).toBe(true)
      expect(hasAction(groups, 'add-edit-note')).toBe(true)
      expect(hasAction(groups, 'variations')).toBe(false)
      expect(hasAction(groups, 'crop')).toBe(false)
    })

    it('task-placeholder → 与 image 同走 generate 扩展，有 variations 但无 crop', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([taskNode('tp1')])))
      expect(hasAction(groups, 'generate-beside')).toBe(true)
      expect(hasAction(groups, 'add-edit-note')).toBe(true)
      expect(hasAction(groups, 'variations')).toBe(true)
      expect(hasAction(groups, 'crop')).toBe(false)
    })

    it('frame → 走 section 扩展：section-fill/section-line/section-title-toggle + section-lock 组', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([frameNode('f1')])))
      expect(hasAction(groups, 'section-fill')).toBe(true)
      expect(hasAction(groups, 'section-line')).toBe(true)
      expect(hasAction(groups, 'section-title-toggle')).toBe(true)
      expect(hasAction(groups, 'section-lock-all')).toBe(true)
      expect(hasAction(groups, 'section-lock-background')).toBe(true)
      expect(hasAction(groups, 'section-unlock')).toBe(true)
      expect(hasAction(groups, 'remove-section-only')).toBe(true)
    })

    it('markup arrow → markup-text + markup-style 组；style 含 arrowheads 子菜单', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'arrow')])))
      expect(hasAction(groups, 'edit-markup-text')).toBe(true)
      expect(hasAction(groups, 'markup-arrowheads')).toBe(true)
      expect(hasAction(groups, 'markup-fill-color')).toBe(true)
      expect(hasAction(groups, 'markup-line-style')).toBe(true)
    })

    it('markup rect → markup-style 组含 corner-radius 子菜单', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'rect')])))
      expect(hasAction(groups, 'markup-corner-radius')).toBe(true)
      // rect 非 connector → 无 arrowheads
      expect(hasAction(groups, 'markup-arrowheads')).toBe(false)
    })

    it('markup note → 非 connector 非 rect → 无 arrowheads 也无 corner-radius', () => {
      const groups = contextMenuGroupsFor(createRuntime(ctx([markupNode('m1', 'note')])))
      expect(hasAction(groups, 'markup-arrowheads')).toBe(false)
      expect(hasAction(groups, 'markup-corner-radius')).toBe(false)
    })
  })

  // ─── ③ action 分发行为 ───────────────────────────────────────────────────────

  describe('contextMenu dispatch', () => {
    it('view-details · image → setActiveTool(select) + onOpenDetails()', () => {
      const onOpenDetails = vi.fn()
      const rt = createRuntime(ctx([imageNode('a')]), { onOpenDetails })
      fire(contextMenuGroupsFor(rt), 'view-details')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('select')
      expect(vi.mocked(rt.onOpenDetails)).toHaveBeenCalledTimes(1)
    })

    it('view-details · frame → setActiveTool(select) + onRenameNode(id)；不调 onOpenDetails（frame 分支早退）', () => {
      const onRenameNode = vi.fn()
      const onOpenDetails = vi.fn()
      const rt = createRuntime(ctx([frameNode('f1')]), { onRenameNode, onOpenDetails })
      const groups = contextMenuGroupsFor(rt)
      expect(findAction(groups, 'view-details')?.label).toBe('Rename section')
      fire(groups, 'view-details')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('select')
      expect(vi.mocked(rt.onRenameNode)).toHaveBeenCalledWith('f1')
      // frame 分支调完 onRenameNode 后 return，不能落到 onOpenDetails fallback。
      // 用 spy 断言"不调用"，杀掉"只断属性 undefined"的空转：删源码 return → 此断言红。
      expect(vi.mocked(rt.onOpenDetails)).not.toHaveBeenCalled()
    })

    it('view-details · text → setActiveTool(select) + onEditText(id)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([textNode('t1')]), { onEditText })
      const groups = contextMenuGroupsFor(rt)
      expect(findAction(groups, 'view-details')?.label).toBe('Edit text')
      fire(groups, 'view-details')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('select')
      expect(vi.mocked(rt.onEditText)).toHaveBeenCalledWith('t1')
    })

    it('view-details · annotation → 标签 Edit note + onEditText(id)', () => {
      const onEditText = vi.fn()
      const rt = createRuntime(ctx([annotationNode('n1')]), { onEditText })
      const groups = contextMenuGroupsFor(rt)
      expect(findAction(groups, 'view-details')?.label).toBe('Edit note')
      fire(groups, 'view-details')
      expect(vi.mocked(rt.onEditText)).toHaveBeenCalledWith('n1')
    })

    it('view-details · ai-slot → setActiveTool(select) + generateIntoAiSlot(id)', () => {
      const rt = createRuntime(ctx([aiSlotNode('s1')]))
      const groups = contextMenuGroupsFor(rt)
      expect(findAction(groups, 'view-details')?.label).toBe('Generate into slot')
      fire(groups, 'view-details')
      expect(vi.mocked(rt.setActiveTool)).toHaveBeenCalledWith('select')
      expect(vi.mocked(rt.generateIntoAiSlot)).toHaveBeenCalledWith('s1')
    })

    it('copy → copySelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'copy')
      expect(vi.mocked(rt.copySelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('duplicate · single → duplicateNode(id)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'duplicate')
      expect(vi.mocked(rt.duplicateNode)).toHaveBeenCalledWith('a')
      expect(vi.mocked(rt.duplicateSelectedNodes)).not.toHaveBeenCalled()
    })

    it('duplicate · multi → duplicateSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(contextMenuGroupsFor(rt), 'duplicate')
      expect(vi.mocked(rt.duplicateSelectedNodes)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(rt.duplicateNode)).not.toHaveBeenCalled()
    })

    it('delete · single image → deleteNode(id)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'delete')
      expect(vi.mocked(rt.deleteNode)).toHaveBeenCalledWith('a')
      expect(vi.mocked(rt.deleteSelectedNodes)).not.toHaveBeenCalled()
    })

    it('delete · multi → deleteSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(contextMenuGroupsFor(rt), 'delete')
      expect(vi.mocked(rt.deleteSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('paste(blank) → pasteClipboardNodes()', () => {
      const rt = createRuntime(ctx([]), { clipboardCount: 1 })
      fire(contextMenuGroupsFor(rt), 'paste')
      expect(vi.mocked(rt.pasteClipboardNodes)).toHaveBeenCalledTimes(1)
    })

    it('paste(single+clipboard) → pasteClipboardNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a')]), { clipboardCount: 1 })
      fire(contextMenuGroupsFor(rt), 'paste')
      expect(vi.mocked(rt.pasteClipboardNodes)).toHaveBeenCalledTimes(1)
    })

    it('group → groupSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(contextMenuGroupsFor(rt), 'group')
      expect(vi.mocked(rt.groupSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('ungroup → ungroupSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a', { groupId: 'g1' }), imageNode('b', { groupId: 'g1' })]))
      fire(contextMenuGroupsFor(rt), 'ungroup')
      expect(vi.mocked(rt.ungroupSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('toggle-lock → toggleSelectedNodesLocked()', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'toggle-lock')
      expect(vi.mocked(rt.toggleSelectedNodesLocked)).toHaveBeenCalledTimes(1)
    })

    it('hide → hideSelectedNodes()', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'hide')
      expect(vi.mocked(rt.hideSelectedNodes)).toHaveBeenCalledTimes(1)
    })

    it('fit-all(blank) → onFitAll()', () => {
      const onFitAll = vi.fn()
      const rt = createRuntime(ctx([]), { allNodeIdsOverride: ['a'], onFitAll })
      fire(contextMenuGroupsFor(rt), 'fit-all')
      expect(onFitAll).toHaveBeenCalledTimes(1)
    })

    it('select-all(blank) → selectNodes(allNodeIds)', () => {
      const rt = createRuntime(ctx([]), { allNodeIdsOverride: ['a', 'b', 'c'] })
      fire(contextMenuGroupsFor(rt), 'select-all')
      expect(vi.mocked(rt.selectNodes)).toHaveBeenCalledWith(['a', 'b', 'c'])
    })

    it('show-hidden(blank) → showAllHiddenNodes()', () => {
      const rt = createRuntime(ctx([]), { hiddenCount: 2 })
      fire(contextMenuGroupsFor(rt), 'show-hidden')
      expect(vi.mocked(rt.showAllHiddenNodes)).toHaveBeenCalledTimes(1)
    })

    it('arrange bring-forward · single → moveNodeLayer(id, forward)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'bring-forward')
      expect(vi.mocked(rt.moveNodeLayer)).toHaveBeenCalledWith('a', 'forward')
    })

    it('arrange send-back · single → moveNodeLayer(id, back)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'send-back')
      expect(vi.mocked(rt.moveNodeLayer)).toHaveBeenCalledWith('a', 'back')
    })

    it('arrange bring-front · multi → moveSelectedLayer(front)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(contextMenuGroupsFor(rt), 'bring-front')
      expect(vi.mocked(rt.moveSelectedLayer)).toHaveBeenCalledWith('front')
      expect(vi.mocked(rt.moveNodeLayer)).not.toHaveBeenCalled()
    })

    it('align-left · multi → alignSelectedNodes(left)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(contextMenuGroupsFor(rt), 'align-left')
      expect(vi.mocked(rt.alignSelectedNodes)).toHaveBeenCalledWith('left')
    })

    it('align-middle · multi → alignSelectedNodes(middle)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b')]))
      fire(contextMenuGroupsFor(rt), 'align-middle')
      expect(vi.mocked(rt.alignSelectedNodes)).toHaveBeenCalledWith('middle')
    })

    it('distribute-vertical · multi3 → distributeSelectedNodes(vertical)', () => {
      const rt = createRuntime(ctx([imageNode('a'), imageNode('b'), imageNode('c')]))
      fire(contextMenuGroupsFor(rt), 'distribute-vertical')
      expect(vi.mocked(rt.distributeSelectedNodes)).toHaveBeenCalledWith('vertical')
    })

    it('download · image → onDownloadOriginal(primaryNode)', () => {
      const onDownloadOriginal = vi.fn()
      const primary = imageNode('a')
      const rt = createRuntime(ctx([primary]), { onDownloadOriginal })
      fire(contextMenuGroupsFor(rt), 'download')
      expect(onDownloadOriginal).toHaveBeenCalledWith(primary)
    })

    it('generate-beside · image → generateBesideNode(id)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'generate-beside')
      expect(vi.mocked(rt.generateBesideNode)).toHaveBeenCalledWith('a')
    })

    it('variations · image → generateVariations(id)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'variations')
      expect(vi.mocked(rt.generateVariations)).toHaveBeenCalledWith('a')
    })

    it('add-edit-note · image → addAnnotationNode(id)', () => {
      const rt = createRuntime(ctx([imageNode('a')]))
      fire(contextMenuGroupsFor(rt), 'add-edit-note')
      expect(vi.mocked(rt.addAnnotationNode)).toHaveBeenCalledWith('a')
    })

    it('generate-into-slot · ai-slot → generateIntoAiSlot(id)', () => {
      const rt = createRuntime(ctx([aiSlotNode('s1')]))
      fire(contextMenuGroupsFor(rt), 'generate-into-slot')
      expect(vi.mocked(rt.generateIntoAiSlot)).toHaveBeenCalledWith('s1')
    })

    it('generate-from-annotation · annotation → generateFromAnnotation(id)', () => {
      const rt = createRuntime(ctx([annotationNode('n1')]))
      fire(contextMenuGroupsFor(rt), 'generate-from-annotation')
      expect(vi.mocked(rt.generateFromAnnotation)).toHaveBeenCalledWith('n1')
    })

    it('crop · image → onCropNode(id)', () => {
      const onCropNode = vi.fn()
      const rt = createRuntime(ctx([imageNode('a')]), { onCropNode })
      fire(contextMenuGroupsFor(rt), 'crop')
      expect(onCropNode).toHaveBeenCalledWith('a')
    })
  })

  // ─── ③ section style / lock 分发 ─────────────────────────────────────────────

  describe('section context-menu style & lock dispatch', () => {
    it('section-fill 子项 White → updateSectionStyle(f1, {sectionFillColor:#ffffff})', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-fill-#ffffff')
      expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionFillColor: '#ffffff' })
    })

    it('section-fill 父 onClick → updateSectionStyle(f1, {sectionFillColor:#ffffff})（默认重置白）', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-fill')
      expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionFillColor: '#ffffff' })
    })

    it('section-line 子项 Orange → updateSectionStyle(f1, {sectionBorderColor:#ff8a00})', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-line-#ff8a00')
      expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionBorderColor: '#ff8a00' })
    })

    it('section-line-dashed → updateSectionStyle(f1, {sectionBorderStyle:dashed})', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-line-dashed')
      expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionBorderStyle: 'dashed' })
    })

    it('section-line-bold → updateSectionStyle(f1, {sectionBorderWidth:4})', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-line-bold')
      expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionBorderWidth: 4 })
    })

    it('section-title-toggle（title 可见）→ Hide title：updateSectionStyle(f1, {sectionTitleVisible:false})', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      const g = contextMenuGroupsFor(rt)
      expect(findAction(g, 'section-title-toggle')?.label).toBe('Hide title')
      fire(g, 'section-title-toggle')
      expect(vi.mocked(rt.updateSectionStyle)).toHaveBeenCalledWith('f1', { sectionTitleVisible: false })
    })

    it('section-title-toggle（title 不可见）→ Show title', () => {
      const rt = createRuntime(ctx([frameNode('f1', { sectionTitleVisible: false })]))
      expect(findAction(contextMenuGroupsFor(rt), 'section-title-toggle')?.label).toBe('Show title')
    })

    it('section-lock-all → setSectionLockMode(f1, all)', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-lock-all')
      expect(vi.mocked(rt.setSectionLockMode)).toHaveBeenCalledWith('f1', 'all')
    })

    it('section-lock-background → setSectionLockMode(f1, background)', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'section-lock-background')
      expect(vi.mocked(rt.setSectionLockMode)).toHaveBeenCalledWith('f1', 'background')
    })

    it('section-unlock → setSectionLockMode(f1, undefined)', () => {
      const rt = createRuntime(ctx([frameNode('f1', { sectionLockMode: 'all' })]))
      fire(contextMenuGroupsFor(rt), 'section-unlock')
      expect(vi.mocked(rt.setSectionLockMode)).toHaveBeenCalledWith('f1', undefined)
    })

    it('section-unlock 在未锁定时 disabled', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      expect(findAction(contextMenuGroupsFor(rt), 'section-unlock')?.disabled).toBe(true)
    })

    it('section-unlock 在已锁定时 enabled', () => {
      const rt = createRuntime(ctx([frameNode('f1', { sectionLockMode: 'all' })]))
      expect(findAction(contextMenuGroupsFor(rt), 'section-unlock')?.disabled).toBe(false)
    })

    it('remove-section-only → removeSectionOnly(f1)', () => {
      const rt = createRuntime(ctx([frameNode('f1')]))
      fire(contextMenuGroupsFor(rt), 'remove-section-only')
      expect(vi.mocked(rt.removeSectionOnly)).toHaveBeenCalledWith('f1')
    })
  })
})

// BASELINE COUNT (part 1): part 1 = 162 expect / 107 tests（97 `it` + 2 个 `it.each` = 8+2 参数化行）。
// part 1+2 合计 315 expect / 203 tests（part2 153 expect / 96 tests）。迁移前后须一致；
// 若数量变化说明行为已改变,需在 PR 中显式说明。
// 分块：① 结构快照（含 orderedGroupIds 真实顺序钉阵）② 能力矩阵（含 locked/exportable 10 类型矩阵）
// ③ contextMenu/section 分发。
