// src/canvas/nodeTypes/canvasNodeRegistry.contract.test.ts
//
// 节点类型总线契约测试 (T2.1 / arch plan §3 + §10 M2 + §11 机制#3)。
//
// 为什么是契约测试(非 runtime render test):节点类型总线是 §3 四类插件总线里第一条
// "已形式化"的总线(canvasNodeRegistry 已有 10 个节点类型实现,抽象被多实现验证过)。
// 本测试锁住"注册表完整性 + 每类型定义精确语义 + helper 出口语义"——任何新增/删除/
// 重命名/改语义的节点类型都必须同时更新 CanvasNodeType union、canvasNodeRegistry 与本
// 测试的 EXPECTED 矩阵,三方一致才过。
//
// ─── 第二真相源(独立于 registry 源码,防 #194 同型"58 绿但契约断裂") ───────────────
// 旧版只锁形状(renderKind 在枚举内 / defaultSize 正有限 / capabilities 非空 Set),把
// registry 自身当期望值(同源自洽)。审阅者变异实证:把 image.importBehavior 改成
// asset-video、defaultSize 改 1x1、capabilities 换成 pdf 的,旧契约 133/133 照样绿——
// 看门价值为零。本版改为"第二真相源"字面量矩阵:
//   - renderKind/importBehavior/defaultSize 精确 === 测试内字面量(不是 toContain 枚举)
//   - capabilities(node) 精确 Set 相等,逐类型覆盖 locked/unlocked 两态;
//     image 额外覆盖 aiWorkflow.kind === 'result' 态。断言集合精确内容,不是非空。
//   - BASE/ORG 基础集合 + 每类型 unlockedCaps/lockedCaps 全部手抄字面量,**故意不 import**
//     生产常量(baseObjectCapabilities/organizationCapabilities/objectCapabilitiesFor)。
//     任何基础集合内容漂移、组装逻辑改动、类型语义改动 → 期望与实际不符 → 红。
//   - helper 出口的期望值改为字面量矩阵(不再用 registry 当期望),消除同源自洽。
//
// 契约面(锁定对象,与生产代码一一对应,零行为变化):
//   - canvasNodeRegistry: satisfies Record<CanvasNodeType, CanvasNodeDefinition>
//     (satisfies = 编译期完整性 guard —— union 加类型不加 registry 入口 = 编译红)
//   - CanvasNodeDefinition: { type, label, renderKind, defaultSize, importBehavior,
//     capabilities(node) → Set<CanvasObjectCapability> }
//   - 6 helper 出口: nodeTypeDefinitionFor / nodeDefinitionFor / capabilitiesForNode /
//     renderKindForNode / defaultSizeForNodeType / importBehaviorForNodeType
//   - 2 谓词出口: isCanvasTextNode / isCanvasSectionNode
//
// §3 目标 NodeType{ render, hitTest, serialize } 尚未落地——当前 renderKind 是字符串 tag
// (非 render 函数),hitTest 在 src/render/、serialize 在 persist 链路,均未收进注册表。
// 本 PR 不补(零行为变化 = 解耦阶段非重写);该 seam 留待 M2 后续步骤,届时补方法 +
// 本测试同步扩。本测试先锁已落地的契约面。
//
// 维护契约(给后续贡献者):
//   新增节点类型 → ① 加进 CanvasNodeType union ② 加进 canvasNodeRegistry(satisfies 会
//   强制)③ 加进下方 EXPECTED_NODE_TYPES + EXPECTED_DEFINITIONS(含 unlocked/locked caps
//   字面量)。漏 ③ 本测试 fail。删除类型同理三方同步。
//   改某类型 renderKind/importBehavior/defaultSize/capabilities 语义 → 同步改
//   EXPECTED_DEFINITIONS 对应字面量,否则本测试 fail(这正是"第二真相源"看门)。
//   新增 renderKind/importBehavior 枚举值 → 同步下方两个 EXPECTED_*_KINDS 列表。
//   改 base/organization 基础集合内容 → 同步手抄下方 BASE_OBJECT_CAPABILITIES /
//   ORGANIZATION_CAPABILITIES 字面量(故意不 import,防自动跟随掩盖漂移)。

import { describe, expect, it } from 'vitest'
import type { CanvasNodeType, MivoCanvasNode } from '../../types/mivoCanvas'
import {
  canvasNodeRegistry,
  nodeTypeDefinitionFor,
  nodeDefinitionFor,
  capabilitiesForNode,
  renderKindForNode,
  defaultSizeForNodeType,
  importBehaviorForNodeType,
  isCanvasTextNode,
  isCanvasSectionNode,
} from './canvasNodeRegistry'
import registrySource from './canvasNodeRegistry.ts?raw'

// ─── 第二真相源:基础集合字面量(手抄自 nodeCapabilities.ts,故意不 import) ──────
// 关键:这两个数组是测试文件内的字面量,独立于生产代码的 baseObjectCapabilities /
// organizationCapabilities。若有人改了生产基础集合(删/增项),本字面量不会自动跟随
// → 组装出的 expected Set 与实际不符 → 红。这正是"第二真相源"语义锁:期望值不依赖
// registry 源码,基础集合的语义漂移被抓住。
const BASE_OBJECT_CAPABILITIES = [
  'selectable',
  'movable',
  'resizable',
  'layerable',
  'groupable',
  'lockable',
  'hideable',
  'exportable',
] as const

const ORGANIZATION_CAPABILITIES = ['selectable', 'lockable', 'hideable'] as const

// 唯一真相源 = CanvasNodeType union (src/types/mivoCanvas.ts)。
// registry 必须与之双向一一对应(union↔registry↔本列表 三方一致)。
const EXPECTED_NODE_TYPES: CanvasNodeType[] = [
  'image',
  'task-placeholder',
  'text',
  'frame',
  'ai-slot',
  'annotation',
  'markup',
  'markdown',
  'pdf',
  'video',
]

// renderKind 合法值集(锁定 CanvasNodeRenderKind 枚举恰好,新增需同步)。
const EXPECTED_RENDER_KINDS = [
  'image', 'task', 'text', 'section', 'ai-slot',
  'annotation', 'markup', 'markdown', 'pdf', 'video',
] as const

// importBehavior 合法值集(锁定 CanvasNodeImportBehavior 枚举恰好,新增需同步)。
const EXPECTED_IMPORT_BEHAVIORS = [
  'asset-image', 'asset-markdown', 'asset-pdf', 'asset-video',
  'generated-image', 'text', 'section', 'markup', 'none',
] as const

// ─── 第二真相源:每类型定义精确语义字面量矩阵 ─────────────────────────────────
// unlockedCaps / lockedCaps 是每类型"在基础集合之外附加的能力"的字面量声明。
// 组装规则(与生产 objectCapabilitiesFor 对齐,但期望值不引用生产实现):
//   expectedUnlocked = new Set([...BASE_OBJECT_CAPABILITIES, ...unlockedCaps])
//   expectedLocked   = new Set([...ORGANIZATION_CAPABILITIES, ...lockedCaps])
// 注意 frame/markup 的 lockedCaps 不含 'exportable'(生产里 frame 的 lockedCapabilities
// 默认 = unlocked;markup 同)——这里显式字面量声明,不能靠"统一加 exportable"规则推导,
// 否则会掩盖 frame/markup 的特殊语义。
const EXPECTED_DEFINITIONS = {
  image: {
    label: 'Image',
    renderKind: 'image',
    importBehavior: 'asset-image',
    defaultSize: { width: 320, height: 240 },
    unlockedCaps: ['asset', 'imageAsset', 'downloadOriginal', 'aiReference', 'aiEditable'],
    lockedCaps: ['asset', 'imageAsset', 'downloadOriginal', 'aiReference', 'aiEditable', 'exportable'],
    // aiWorkflow.kind === 'result' 时,unlocked/locked 各追加 'aiResult'(image 专属语义)
    aiResultExtra: ['aiResult'],
  },
  'task-placeholder': {
    label: 'Task',
    renderKind: 'task',
    importBehavior: 'generated-image',
    defaultSize: { width: 320, height: 240 },
    unlockedCaps: ['asset', 'imageAsset', 'aiReference', 'task'],
    lockedCaps: ['asset', 'imageAsset', 'aiReference', 'task', 'exportable'],
  },
  text: {
    label: 'Text',
    renderKind: 'text',
    importBehavior: 'text',
    defaultSize: { width: 96, height: 42 },
    unlockedCaps: ['text', 'promptSource'],
    lockedCaps: ['text', 'promptSource', 'exportable'],
  },
  frame: {
    label: 'Section',
    renderKind: 'section',
    importBehavior: 'section',
    defaultSize: { width: 560, height: 320 },
    unlockedCaps: ['frame'],
    lockedCaps: ['frame'], // frame locked 不加 exportable(lockedCapabilities 默认 = unlocked)
  },
  'ai-slot': {
    label: 'AI Slot',
    renderKind: 'ai-slot',
    importBehavior: 'none',
    defaultSize: { width: 320, height: 320 },
    unlockedCaps: ['aiSlot', 'promptSource'],
    lockedCaps: ['aiSlot', 'promptSource', 'exportable'],
  },
  annotation: {
    label: 'Annotation',
    renderKind: 'annotation',
    importBehavior: 'none',
    defaultSize: { width: 276, height: 118 },
    unlockedCaps: ['text', 'annotation', 'promptSource', 'annotatable'],
    lockedCaps: ['text', 'annotation', 'promptSource', 'annotatable', 'exportable'],
  },
  markup: {
    label: 'Markup',
    renderKind: 'markup',
    importBehavior: 'markup',
    defaultSize: { width: 220, height: 120 },
    unlockedCaps: ['markup', 'annotation', 'annotatable', 'promptSource'],
    lockedCaps: ['markup', 'annotation', 'annotatable', 'promptSource'], // 不加 exportable
  },
  markdown: {
    label: 'Markdown',
    renderKind: 'markdown',
    importBehavior: 'asset-markdown',
    defaultSize: { width: 560, height: 320 },
    unlockedCaps: ['asset', 'markdownDoc', 'downloadOriginal', 'promptSource'],
    lockedCaps: ['asset', 'markdownDoc', 'downloadOriginal', 'promptSource', 'exportable'],
  },
  pdf: {
    label: 'PDF',
    renderKind: 'pdf',
    importBehavior: 'asset-pdf',
    defaultSize: { width: 340, height: 440 },
    unlockedCaps: ['asset', 'pdfAsset', 'downloadOriginal', 'promptSource'],
    lockedCaps: ['asset', 'pdfAsset', 'downloadOriginal', 'promptSource', 'exportable'],
  },
  video: {
    label: 'Video',
    renderKind: 'video',
    importBehavior: 'asset-video',
    defaultSize: { width: 420, height: 236 },
    unlockedCaps: ['asset', 'videoAsset', 'downloadOriginal', 'promptSource'],
    lockedCaps: ['asset', 'videoAsset', 'downloadOriginal', 'promptSource', 'exportable'],
  },
} as const satisfies Record<CanvasNodeType, {
  label: string
  renderKind: string
  importBehavior: string
  defaultSize: { width: number; height: number }
  unlockedCaps: readonly string[]
  lockedCaps: readonly string[]
  aiResultExtra?: readonly string[]
}>

// 期望 Set 组装(测试内字面量 → Set,与生产实现无引用关系)。
const expectedUnlockedCaps = (type: CanvasNodeType): Set<string> =>
  new Set([...BASE_OBJECT_CAPABILITIES, ...EXPECTED_DEFINITIONS[type].unlockedCaps])
const expectedLockedCaps = (type: CanvasNodeType): Set<string> =>
  new Set([...ORGANIZATION_CAPABILITIES, ...EXPECTED_DEFINITIONS[type].lockedCaps])
// image 的 aiWorkflow.kind === 'result' 态追加能力(仅 image 有此语义)。用字面量 key
// `EXPECTED_DEFINITIONS.image` 访问让 TS 收窄到 image 成员类型(含 aiResultExtra),
// 避免对联合 `EXPECTED_DEFINITIONS[type]` 访问可选属性触发的 TS2339。
const expectedImageUnlockedResultCaps = (): Set<string> =>
  new Set([
    ...BASE_OBJECT_CAPABILITIES,
    ...EXPECTED_DEFINITIONS.image.unlockedCaps,
    ...EXPECTED_DEFINITIONS.image.aiResultExtra,
  ])
const expectedImageLockedResultCaps = (): Set<string> =>
  new Set([
    ...ORGANIZATION_CAPABILITIES,
    ...EXPECTED_DEFINITIONS.image.lockedCaps,
    ...EXPECTED_DEFINITIONS.image.aiResultExtra,
  ])

// 构造最小 node 用于 capabilities(node) 契约。capabilities 实现只读 node.locked 与
// node.aiWorkflow?.kind 两个字段(见 objectCapabilitiesFor / imageCapabilitiesFor /
// fileCapabilitiesFor),不触达 MivoCanvasNode 其余字段,故最小对象足矣——不耦合全字段,
// 避免 MivoCanvasNode 结构演进时本测试被无关改动打断。
const minimalNode = (type: CanvasNodeType, overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode =>
  ({
    type,
    locked: false,
    ...overrides,
  }) as unknown as MivoCanvasNode

describe('节点类型总线契约 — 注册表完整性(双向锁:union↔registry↔本列表)', () => {
  it('canvasNodeRegistry 的 key 集合 == EXPECTED_NODE_TYPES(union 真相源)', () => {
    // 双向:registry 多 key(union 加了类型但...实际 satisfies 已防)或少 key(EXPECTED
    // 列了但 registry 没有)都 fail。satisfies 在编译期防"union 有 / registry 无";
    // 本断言在运行期防"registry 有 / 本测试 EXPECTED 没更新"。
    const registryKeys = Object.keys(canvasNodeRegistry).sort()
    const expected = [...EXPECTED_NODE_TYPES].sort()
    expect(registryKeys, 'registry key 集合与 EXPECTED_NODE_TYPES 不一致 —— 三方脱节').toEqual(expected)
  })

  it('EXPECTED_NODE_TYPES 无重复且非空', () => {
    expect(EXPECTED_NODE_TYPES.length).toBeGreaterThan(0)
    expect(new Set(EXPECTED_NODE_TYPES).size).toBe(EXPECTED_NODE_TYPES.length)
  })

  it('registry 实际 renderKind 取值集合恰好 == EXPECTED_RENDER_KINDS(锁枚举无偷加/偷删)', () => {
    const actual = new Set(EXPECTED_NODE_TYPES.map((t) => canvasNodeRegistry[t].renderKind))
    expect(actual, 'renderKind 枚举取值与 EXPECTED_RENDER_KINDS 不一致').toEqual(new Set(EXPECTED_RENDER_KINDS))
  })

  it('registry 实际 importBehavior 取值集合恰好 == EXPECTED_IMPORT_BEHAVIORS(锁枚举无偷加/偷删)', () => {
    const actual = new Set(EXPECTED_NODE_TYPES.map((t) => canvasNodeRegistry[t].importBehavior))
    expect(actual, 'importBehavior 枚举取值与 EXPECTED_IMPORT_BEHAVIORS 不一致').toEqual(new Set(EXPECTED_IMPORT_BEHAVIORS))
  })
})

describe.each(EXPECTED_NODE_TYPES)('节点类型总线契约 — %s 定义精确语义(第二真相源字面量)', (type) => {
  const def = canvasNodeRegistry[type]
  const expected = EXPECTED_DEFINITIONS[type]

  it('definition.type === 注册表 key(自洽)', () => {
    expect(def.type).toBe(type)
  })

  it('label 精确等于字面量(防偷改显示名)', () => {
    expect(def.label, `${type}.label 应为 "${expected.label}"`).toBe(expected.label)
  })

  it('renderKind 精确等于字面量(不是"在枚举内",防类型间错配)', () => {
    // 旧版只 toContain 枚举:把 image.renderKind 改成 'pdf' 仍绿。本版精确 === 字面量。
    expect(def.renderKind, `${type}.renderKind 应为 "${expected.renderKind}"`).toBe(expected.renderKind)
  })

  it('importBehavior 精确等于字面量(不是"在枚举内",防类型间错配)', () => {
    // 变异实证:旧版把 image.importBehavior 改成 asset-video 不红。本版精确 === 字面量 → 红。
    expect(def.importBehavior, `${type}.importBehavior 应为 "${expected.importBehavior}"`).toBe(expected.importBehavior)
  })

  it('defaultSize 精确等于字面量宽高(不是"正有限",防偷改尺寸)', () => {
    // 变异实证:旧版把 image.defaultSize 改 1x1 不红。本版 toEqual 字面量 → 红。
    expect(def.defaultSize, `${type}.defaultSize 应为 ${JSON.stringify(expected.defaultSize)}`).toEqual(expected.defaultSize)
  })

  it('capabilities(unlocked node) 精确 Set 相等第二真相源(不是"非空 Set")', () => {
    // 锁 locked=false 态的精确集合内容。变异实证:旧版把 image.capabilities 换成 pdf 的
    // 仍绿(只查非空 Set)。本版 toEqual Set 字面量 → 内容不符即红。
    const caps = def.capabilities(minimalNode(type, { locked: false }))
    expect(caps, `${type} unlocked capabilities 内容与字面量不符`).toEqual(expectedUnlockedCaps(type))
  })

  it('capabilities(locked node) 精确 Set 相等第二真相源(覆盖 locked 态)', () => {
    // 锁 locked=true 态的精确集合内容。objectCapabilitiesFor 在 locked 时切到
    // organizationCapabilities + lockedCapabilities,与 unlocked 不同集合,必须单独锁。
    const caps = def.capabilities(minimalNode(type, { locked: true }))
    expect(caps, `${type} locked capabilities 内容与字面量不符`).toEqual(expectedLockedCaps(type))
  })
})

describe('节点类型总线契约 — image 类型 aiWorkflow.kind=result 态(第二真相源)', () => {
  // image 是唯一读 node.aiWorkflow?.kind 的类型(imageCapabilitiesFor),result 态追加
  // 'aiResult'。必须单独覆盖此态,否则有人删掉 result 分支不红。
  it('image capabilities(unlocked + aiWorkflow.result) 精确 Set 相等(含 aiResult)', () => {
    const caps = canvasNodeRegistry.image.capabilities(
      minimalNode('image', { locked: false, aiWorkflow: { kind: 'result' } }),
    )
    expect(caps, 'image unlocked+result capabilities 应含 aiResult 且其余内容与 unlocked 同').toEqual(expectedImageUnlockedResultCaps())
  })

  it('image capabilities(locked + aiWorkflow.result) 精确 Set 相等(含 aiResult)', () => {
    const caps = canvasNodeRegistry.image.capabilities(
      minimalNode('image', { locked: true, aiWorkflow: { kind: 'result' } }),
    )
    expect(caps, 'image locked+result capabilities 应含 aiResult 且其余内容与 locked 同').toEqual(expectedImageLockedResultCaps())
  })
})

describe('节点类型总线契约 — helper 出口语义(期望源=第二真相源字面量,非 registry)', () => {
  // 旧版用 canvasNodeRegistry[type] 当期望值(同源自洽):registry 改错 helper 跟着错仍绿。
  // 本版期望源全部换成 EXPECTED_DEFINITIONS 字面量,helper 返回值必须对得上字面量才算过。
  it.each(EXPECTED_NODE_TYPES)(
    'nodeTypeDefinitionFor(%s) === canvasNodeRegistry[%s](同一引用,薄封装透传)',
    (type) => {
      // 引用相等锁"helper 是 registry 的透传薄封装,未深拷贝/返回副本"(正交于语义,防意外复制)。
      expect(nodeTypeDefinitionFor(type)).toBe(canvasNodeRegistry[type])
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'nodeDefinitionFor(node) === canvasNodeRegistry[%s](同一引用,薄封装透传)',
    (type) => {
      expect(nodeDefinitionFor(minimalNode(type))).toBe(canvasNodeRegistry[type])
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'capabilitiesForNode(unlocked %s node) 精确 Set 相等字面量(非 registry 自证)',
    (type) => {
      expect(capabilitiesForNode(minimalNode(type, { locked: false }))).toEqual(expectedUnlockedCaps(type))
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'capabilitiesForNode(locked %s node) 精确 Set 相等字面量(覆盖 locked 态)',
    (type) => {
      expect(capabilitiesForNode(minimalNode(type, { locked: true }))).toEqual(expectedLockedCaps(type))
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'renderKindForNode(%s node) 精确等于字面量(非 registry 自证)',
    (type) => {
      expect(renderKindForNode(minimalNode(type))).toBe(EXPECTED_DEFINITIONS[type].renderKind)
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'defaultSizeForNodeType(%s) 精确等于字面量宽高(非 registry 自证)',
    (type) => {
      expect(defaultSizeForNodeType(type)).toEqual(EXPECTED_DEFINITIONS[type].defaultSize)
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'importBehaviorForNodeType(%s) 精确等于字面量(非 registry 自证)',
    (type) => {
      expect(importBehaviorForNodeType(type)).toBe(EXPECTED_DEFINITIONS[type].importBehavior)
    },
  )

  it('isCanvasTextNode: text/annotation → true,其余 → false(锁当前语义)', () => {
    for (const t of EXPECTED_NODE_TYPES) {
      const expected = t === 'text' || t === 'annotation'
      expect(
        isCanvasTextNode(minimalNode(t)),
        `isCanvasTextNode(${t}) 应为 ${expected}`,
      ).toBe(expected)
    }
  })

  it('isCanvasSectionNode: frame → true,其余 → false(锁当前语义)', () => {
    for (const t of EXPECTED_NODE_TYPES) {
      const expected = t === 'frame'
      expect(
        isCanvasSectionNode(minimalNode(t)),
        `isCanvasSectionNode(${t}) 应为 ${expected}`,
      ).toBe(expected)
    }
  })
})

describe('节点类型总线契约 — 源码级锁(防回潮:满足 = 解耦 guard 还在)', () => {
  it('canvasNodeRegistry 用 satisfies Record<CanvasNodeType, CanvasNodeDefinition>(编译期完整性 guard)', () => {
    // satisfies 是"解耦"的编译期兜底:union 加类型不加 registry 入口 → 编译红。若有人
    // 误改成 `: Record<...>`(type assertion,丢失编译期检查)或去掉 satisfies,本测试 fail。
    expect(registrySource).toMatch(/satisfies\s+Record<CanvasNodeType,\s*CanvasNodeDefinition>/)
  })

  it.each([
    'nodeTypeDefinitionFor',
    'nodeDefinitionFor',
    'capabilitiesForNode',
    'renderKindForNode',
    'defaultSizeForNodeType',
    'importBehaviorForNodeType',
    'isCanvasTextNode',
    'isCanvasSectionNode',
  ])('helper/谓词 %s 仍被 export(契约出口稳定,防误删)', (fn) => {
    expect(registrySource).toMatch(new RegExp(`export\\s+(?:const|function)\\s+${fn}\\b`))
  })
})
