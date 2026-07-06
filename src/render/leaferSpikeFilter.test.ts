import { describe, expect, it } from 'vitest'
import {
  filterDomNodesForRendererSpike,
  hasMarkupTextLayer,
  needsFrameTitleShell,
  needsImageSelectionShell,
  needsMarkupTextShell,
  needsStampSelectionShell,
} from './leaferSpikeFilter'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// FU-11: markup 文字层 DOM 壳的 filter 契约。
// - 有文字（或编辑中）的 note/rect/ellipse/line/arrow 在 leafer 模式放行 DOM 壳；
// - 无文字不产生空壳（虚拟化省下的 DOM 不加回来）；
// - brush/stamp/frame 无 MarkupTextLayer，永不放行；
// - bench-only engine LOD（?lod=on）全景态下文字壳按屏幕投影阈值隐藏（0g 口径）。

const node = (opts: Partial<MivoCanvasNode>): MivoCanvasNode =>
  ({
    id: 'n1',
    type: 'markup',
    status: 'ready',
    markupKind: 'rect',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ...opts,
  }) as unknown as MivoCanvasNode

describe('hasMarkupTextLayer — 拥有 MarkupTextLayer 的 Leafer 真画集', () => {
  it('note/rect/ellipse/brush/line/arrow 在集内（MarkupNodeView 对 stamp 以外都渲染文字层，brush 也可双击编辑）', () => {
    for (const markupKind of ['note', 'rect', 'ellipse', 'brush', 'line', 'arrow'] as const) {
      expect(hasMarkupTextLayer(node({ markupKind }))).toBe(true)
    }
  })

  it('stamp 无文字层；frame 标题、image、text 类型不在集内', () => {
    expect(hasMarkupTextLayer(node({ markupKind: 'stamp' }))).toBe(false)
    expect(hasMarkupTextLayer(node({ type: 'frame', markupKind: undefined, title: 'Frame' }))).toBe(false)
    expect(hasMarkupTextLayer(node({ type: 'image', markupKind: undefined }))).toBe(false)
    expect(hasMarkupTextLayer(node({ type: 'text', markupKind: undefined, text: 'hi' }))).toBe(false)
  })
})

describe('needsMarkupTextShell — 文字壳判定', () => {
  it('有非空文字 → 需要壳；空/全空白文字 → 不需要', () => {
    expect(needsMarkupTextShell(node({ text: '需求锚点' }))).toBe(true)
    expect(needsMarkupTextShell(node({}))).toBe(false)
    expect(needsMarkupTextShell(node({ text: '' }))).toBe(false)
    expect(needsMarkupTextShell(node({ text: '   ' }))).toBe(false)
  })

  it('空文字但正在编辑（editingNodeId 命中）→ 需要壳（双击新增文字的入口）', () => {
    expect(needsMarkupTextShell(node({}), { editingNodeId: 'n1' })).toBe(true)
    expect(needsMarkupTextShell(node({}), { editingNodeId: 'other' })).toBe(false)
  })

  it('stamp 即使有文字字段也不产生壳（无 MarkupTextLayer）；brush 有文字则产生（dom 模式 brush 同样渲染文字层）', () => {
    expect(needsMarkupTextShell(node({ markupKind: 'stamp', text: 'x' }))).toBe(false)
    expect(needsMarkupTextShell(node({ markupKind: 'brush', text: 'x' }))).toBe(true)
  })

  it('engine LOD 全景态：屏幕投影 < 阈值 → 文字随降级隐藏（0g 口径）', () => {
    const withText = node({ text: 'label', width: 200, height: 100 })
    // 200 * 0.1 = 20px < 32px 阈值 → 隐藏
    expect(
      needsMarkupTextShell(withText, { lodRequested: true, viewportScale: 0.1, lodThresholdPx: 32 }),
    ).toBe(false)
    // 200 * 0.5 = 100px ≥ 32px → 保留
    expect(
      needsMarkupTextShell(withText, { lodRequested: true, viewportScale: 0.5, lodThresholdPx: 32 }),
    ).toBe(true)
    // lod off（生产 leafer 默认）→ 不受 scale 影响
    expect(needsMarkupTextShell(withText, { lodRequested: false, viewportScale: 0.1 })).toBe(true)
  })
})

describe('needsFrameTitleShell — frame 标题壳判定（FU-12）', () => {
  const frame = (opts: Partial<MivoCanvasNode> = {}) =>
    node({ type: 'frame', markupKind: undefined, title: 'Section 1', width: 560, height: 320, ...opts })

  it('标题可见且非空 → 需要壳；空/全空白标题 → 不需要', () => {
    expect(needsFrameTitleShell(frame())).toBe(true)
    expect(needsFrameTitleShell(frame({ title: '' }))).toBe(false)
    expect(needsFrameTitleShell(frame({ title: '   ' }))).toBe(false)
    expect(needsFrameTitleShell(frame({ title: undefined }))).toBe(false)
  })

  it('sectionTitleVisible=false（标题隐藏）→ 不产生壳', () => {
    expect(needsFrameTitleShell(frame({ sectionTitleVisible: false }))).toBe(false)
  })

  it('非 frame 类型一律 false（markup 走 needsMarkupTextShell）', () => {
    expect(needsFrameTitleShell(node({ markupKind: 'rect', text: 'x', title: 't' }))).toBe(false)
    expect(needsFrameTitleShell(node({ type: 'image', markupKind: undefined, title: 't' }))).toBe(false)
  })

  it('engine LOD 全景态：屏幕投影 < 阈值 → 标题随降级隐藏（与 markup 文字壳同口径）', () => {
    expect(needsFrameTitleShell(frame(), { lodRequested: true, viewportScale: 0.05, lodThresholdPx: 32 })).toBe(false)
    expect(needsFrameTitleShell(frame(), { lodRequested: true, viewportScale: 0.5, lodThresholdPx: 32 })).toBe(true)
    expect(needsFrameTitleShell(frame(), { lodRequested: false, viewportScale: 0.05 })).toBe(true)
  })
})

describe('filterDomNodesForRendererSpike — FU-11 文字壳放行', () => {
  const image = node({ id: 'img', type: 'image', markupKind: undefined })
  const rectWithText = node({ id: 'rt', text: '标注' })
  const rectNoText = node({ id: 'rn' })
  const noteWithText = node({ id: 'nt', markupKind: 'note', text: '便签正文' })
  const arrowWithText = node({ id: 'at', markupKind: 'arrow', text: 'Flow' })
  const stampNode = node({ id: 'bt', markupKind: 'stamp', text: 'x' })
  const plainText = node({ id: 'tx', type: 'text', markupKind: undefined, text: 'hello' })
  const frameTitled = node({ id: 'ft', type: 'frame', markupKind: undefined, title: 'Section 1' })
  const frameHiddenTitle = node({ id: 'fh', type: 'frame', markupKind: undefined, title: 'Hidden', sectionTitleVisible: false })
  const all = [image, rectWithText, rectNoText, noteWithText, arrowWithText, stampNode, plainText, frameTitled, frameHiddenTitle]

  it('dom 模式：原样返回（默认行为零变化）', () => {
    expect(filterDomNodesForRendererSpike(all, 'dom')).toEqual(all)
  })

  it('leafer 模式：有文字的 markup 放行文字壳、标题可见的 frame 放行标题壳，其余 Leafer 真画节点照旧过滤', () => {
    expect(filterDomNodesForRendererSpike(all, 'leafer').map((n) => n.id)).toEqual([
      'rt',
      'nt',
      'at',
      'tx',
      'ft',
    ])
  })

  it('leafer 模式 + 编辑空文字 markup：编辑节点放行（frame 隐藏标题仍不放行）', () => {
    expect(
      filterDomNodesForRendererSpike(all, 'leafer', { editingNodeId: 'rn' }).map((n) => n.id),
    ).toEqual(['rt', 'rn', 'nt', 'at', 'tx', 'ft'])
  })

  it('leafer 模式 + 选中 image：选中 image 放行纯选中壳，未选中 image 仍过滤', () => {
    // 选中 img → 放行（img 在 all 首位，filter 保序）；其余 Leafer 真画节点照旧过滤
    const selectedIds = new Set(['img'])
    expect(
      filterDomNodesForRendererSpike(all, 'leafer', { selectedNodeIds: selectedIds }).map((n) => n.id),
    ).toEqual(['img', 'rt', 'nt', 'at', 'tx', 'ft'])
    // 选中非 image 节点（如 rect）不会把 image 拉回 DOM 列表
    expect(
      filterDomNodesForRendererSpike(all, 'leafer', { selectedNodeIds: new Set(['rt']) }).map((n) => n.id),
    ).toEqual(['rt', 'nt', 'at', 'tx', 'ft'])
    // dom 模式：selectedNodeIds 不影响（原样返回）
    expect(filterDomNodesForRendererSpike(all, 'dom', { selectedNodeIds: selectedIds })).toEqual(all)
  })

  it('leafer 模式 + 选中 stamp：选中 stamp 放行纯选中壳，未选中 stamp 仍过滤', () => {
    const selectedIds = new Set(['bt'])
    expect(
      filterDomNodesForRendererSpike(all, 'leafer', { selectedNodeIds: selectedIds }).map((n) => n.id),
    ).toEqual(['rt', 'nt', 'at', 'bt', 'tx', 'ft'])
    expect(
      filterDomNodesForRendererSpike(all, 'leafer', { selectedNodeIds: new Set(['other']) }).map((n) => n.id),
    ).toEqual(['rt', 'nt', 'at', 'tx', 'ft'])
  })
})

describe('needsImageSelectionShell — image 选中壳判定', () => {
  const image = node({ id: 'img', type: 'image', markupKind: undefined })
  const rect = node({ id: 'rt', text: '标注' })

  it('选中 image → 需要壳；未选中 image → 不需要', () => {
    expect(needsImageSelectionShell(image, { selectedNodeIds: new Set(['img']) })).toBe(true)
    expect(needsImageSelectionShell(image, { selectedNodeIds: new Set(['other']) })).toBe(false)
    expect(needsImageSelectionShell(image, {})).toBe(false)
  })

  it('非 image 节点即使选中也不产生选中壳（markup 走文字壳/frame 走标题壳）', () => {
    expect(needsImageSelectionShell(rect, { selectedNodeIds: new Set(['rt']) })).toBe(false)
  })
})

describe('needsStampSelectionShell — stamp 选中壳判定', () => {
  const stamp = node({ id: 'stamp', markupKind: 'stamp' })
  const rect = node({ id: 'rt', text: '标注' })
  const image = node({ id: 'img', type: 'image', markupKind: undefined })

  it('选中 stamp → 需要壳；未选中 stamp → 不需要', () => {
    expect(needsStampSelectionShell(stamp, { selectedNodeIds: new Set(['stamp']) })).toBe(true)
    expect(needsStampSelectionShell(stamp, { selectedNodeIds: new Set(['other']) })).toBe(false)
    expect(needsStampSelectionShell(stamp, {})).toBe(false)
  })

  it('非 stamp 节点即使选中也不产生 stamp 选中壳', () => {
    expect(needsStampSelectionShell(rect, { selectedNodeIds: new Set(['rt']) })).toBe(false)
    expect(needsStampSelectionShell(image, { selectedNodeIds: new Set(['img']) })).toBe(false)
  })
})
