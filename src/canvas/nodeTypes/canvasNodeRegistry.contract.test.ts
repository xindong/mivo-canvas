// src/canvas/nodeTypes/canvasNodeRegistry.contract.test.ts
//
// 节点类型总线契约测试 (T2.1 / arch plan §3 + §10 M2 + §11 机制#3)。
//
// 为什么是契约测试(非 runtime render test):节点类型总线是 §3 四类插件总线里第一条
// "已形式化"的总线(canvasNodeRegistry 已有 10 个节点类型实现,抽象被多实现验证过)。
// 本测试锁住"注册表完整性 + 每类型定义形状 + helper 出口一致性"——任何新增/删除/重命名
// 节点类型都必须同时更新 CanvasNodeType union、canvasNodeRegistry 与本测试的
// EXPECTED_NODE_TYPES,三方一致才过。这是 §11 机制#3"过契约测试即可合入"的兜底:贡献者
// 加一个节点类型,过本测试就证明 registry 完整、定义形状合规、出口 helper 在,无需读
// 内核实现。
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
//   强制) ③ 加进下方 EXPECTED_NODE_TYPES。漏 ③ 本测试 fail。删除类型同理三方同步。
//   新增 renderKind/importBehavior 枚举值 → 同步下方两个 EXPECTED_*_KINDS 列表。

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

// renderKind 合法值集(锁定 CanvasNodeRenderKind 枚举,新增需同步)。
const EXPECTED_RENDER_KINDS = [
  'image', 'task', 'text', 'section', 'ai-slot',
  'annotation', 'markup', 'markdown', 'pdf', 'video',
] as const

// importBehavior 合法值集(锁定 CanvasNodeImportBehavior 枚举,新增需同步)。
const EXPECTED_IMPORT_BEHAVIORS = [
  'asset-image', 'asset-markdown', 'asset-pdf', 'asset-video',
  'generated-image', 'text', 'section', 'markup', 'none',
] as const

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
})

describe.each(EXPECTED_NODE_TYPES)('节点类型总线契约 — %s 定义形状合规', (type) => {
  const def = canvasNodeRegistry[type]

  it('definition.type === 注册表 key(自洽)', () => {
    expect(def.type).toBe(type)
  })

  it('label 是非空字符串', () => {
    expect(typeof def.label).toBe('string')
    expect(def.label.length).toBeGreaterThan(0)
  })

  it('renderKind 属于 CanvasNodeRenderKind 枚举(EXPECTED_RENDER_KINDS)', () => {
    expect(EXPECTED_RENDER_KINDS, `renderKind "${def.renderKind}" 不在合法枚举内`).toContain(def.renderKind)
  })

  it('importBehavior 属于 CanvasNodeImportBehavior 枚举(EXPECTED_IMPORT_BEHAVIORS)', () => {
    expect(EXPECTED_IMPORT_BEHAVIORS, `importBehavior "${def.importBehavior}" 不在合法枚举内`).toContain(def.importBehavior)
  })

  it('defaultSize 是正有限宽高', () => {
    expect(Number.isFinite(def.defaultSize.width)).toBe(true)
    expect(Number.isFinite(def.defaultSize.height)).toBe(true)
    expect(def.defaultSize.width).toBeGreaterThan(0)
    expect(def.defaultSize.height).toBeGreaterThan(0)
  })

  it('capabilities(node) 返回非空 Set(契约:出口类型稳定为 Set)', () => {
    const caps = def.capabilities(minimalNode(type))
    expect(caps).toBeInstanceOf(Set)
    expect(caps.size).toBeGreaterThan(0)
  })
})

describe('节点类型总线契约 — helper 出口一致性(注册表↔6 helper↔2 谓词)', () => {
  it.each(EXPECTED_NODE_TYPES)(
    'nodeTypeDefinitionFor(%s) === canvasNodeRegistry[%s](同一引用)',
    (type) => {
      expect(nodeTypeDefinitionFor(type)).toBe(canvasNodeRegistry[type])
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'nodeDefinitionFor(node) === canvasNodeRegistry[node.type](同一引用)',
    (type) => {
      expect(nodeDefinitionFor(minimalNode(type))).toBe(canvasNodeRegistry[type])
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'capabilitiesForNode(node) 内容 === nodeDefinitionFor(node).capabilities(node)(每次新 Set,toEqual 比内容)',
    (type) => {
      const node = minimalNode(type)
      expect(capabilitiesForNode(node)).toEqual(nodeDefinitionFor(node).capabilities(node))
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'renderKindForNode(node) === registry[%s].renderKind',
    (type) => {
      expect(renderKindForNode(minimalNode(type))).toBe(canvasNodeRegistry[type].renderKind)
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'defaultSizeForNodeType(%s) === registry[%s].defaultSize(同一引用)',
    (type) => {
      expect(defaultSizeForNodeType(type)).toBe(canvasNodeRegistry[type].defaultSize)
    },
  )

  it.each(EXPECTED_NODE_TYPES)(
    'importBehaviorForNodeType(%s) === registry[%s].importBehavior',
    (type) => {
      expect(importBehaviorForNodeType(type)).toBe(canvasNodeRegistry[type].importBehavior)
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
