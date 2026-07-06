import { describe, expect, it, vi } from 'vitest'
import { paintSignatureFor } from './leaferPaintSignature'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'

// PR-R2 per-node paint signature 契约：每个关键字段变更都必须翻转签名，
// 否则该重画的节点不重画（视觉漂移）。字段集 = projectNode + sinkVisualDefaults
// + 四个 paint 模块 *PaintPropsFor 读取字段的并集。

const baseNode = (): MivoCanvasNode =>
  ({
    id: 'n1',
    type: 'markup',
    status: 'ready',
    markupKind: 'rect',
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    markupFillColor: '#fff',
    markupStrokeColor: '#000',
    markupStrokeWidth: 2,
    markupStrokeStyle: 'solid',
    markupOpacity: 1,
    markupCornerRadius: 4,
  }) as unknown as MivoCanvasNode

const ctx = (overrides: Partial<RendererSyncContext> = {}): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale: 1 },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
  ...overrides,
})

const sigFor = (node: MivoCanvasNode, c = ctx()): string => paintSignatureFor(node, c)

describe('paintSignatureFor — 字段覆盖契约（漏字段 = 视觉漂移）', () => {
  it('相同节点 + 相同 ctx → 签名稳定', () => {
    expect(sigFor(baseNode())).toBe(sigFor(baseNode()))
  })

  const fieldCases: Array<{ name: string; mutate: (n: MivoCanvasNode) => void }> = [
    { name: 'type', mutate: (n) => ((n as { type: string }).type = 'frame') },
    { name: 'x (drag)', mutate: (n) => (n.x = 999) },
    { name: 'y (drag)', mutate: (n) => (n.y = 999) },
    { name: 'width', mutate: (n) => (n.width = 200) },
    { name: 'height', mutate: (n) => (n.height = 200) },
    { name: 'rotation', mutate: (n) => (n.transform = { rotation: 45 } as never) },
    { name: 'fills (显式)', mutate: (n) => (n.fills = [{ id: 'f', kind: 'solid', color: '#abc', opacity: 1, visible: true }] as never) },
    { name: 'strokes (显式)', mutate: (n) => (n.strokes = [{ id: 's', color: '#def', width: 3, style: 'solid', opacity: 1, visible: true }] as never) },
    { name: 'assetUrl', mutate: (n) => (n.assetUrl = 'mivo-asset://x') },
    { name: 'imageCrop', mutate: (n) => (n.imageCrop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } as never) },
    { name: 'text', mutate: (n) => (n.text = 'label') },
    { name: 'fontSize', mutate: (n) => (n.fontSize = 24) },
    { name: 'textColor', mutate: (n) => (n.textColor = '#333') },
    { name: 'textAlign', mutate: (n) => (n.textAlign = 'center' as never) },
    { name: 'fontWeight', mutate: (n) => (n.fontWeight = 700) },
    { name: 'markupKind', mutate: (n) => (n.markupKind = 'ellipse' as never) },
    { name: 'markupBrushKind', mutate: (n) => (n.markupBrushKind = 'highlighter' as never) },
    { name: 'markupStampKind', mutate: (n) => (n.markupStampKind = 'star' as never) },
    { name: 'markupFillColor', mutate: (n) => (n.markupFillColor = '#111') },
    { name: 'markupStrokeColor', mutate: (n) => (n.markupStrokeColor = '#222') },
    { name: 'markupStrokeWidth', mutate: (n) => (n.markupStrokeWidth = 5) },
    { name: 'markupStrokeStyle', mutate: (n) => (n.markupStrokeStyle = 'dashed' as never) },
    { name: 'markupOpacity', mutate: (n) => (n.markupOpacity = 0.5) },
    { name: 'markupPoints', mutate: (n) => (n.markupPoints = [{ x: 1, y: 2 }] as never) },
    { name: 'markupStartArrow', mutate: (n) => (n.markupStartArrow = true) },
    { name: 'markupEndArrow', mutate: (n) => (n.markupEndArrow = false) },
    { name: 'markupCornerRadius', mutate: (n) => (n.markupCornerRadius = 8) },
    { name: 'frameColor', mutate: (n) => (n.frameColor = '#f0f0f0') },
    { name: 'sectionFillColor', mutate: (n) => (n.sectionFillColor = '#secf') },
    { name: 'sectionBorderColor', mutate: (n) => (n.sectionBorderColor = '#secb') },
    { name: 'sectionBorderWidth', mutate: (n) => (n.sectionBorderWidth = 3) },
    { name: 'sectionBorderStyle', mutate: (n) => (n.sectionBorderStyle = 'dashed' as never) },
  ]
  for (const tc of fieldCases) {
    it(`${tc.name} 变更 → 签名翻转`, () => {
      const before = baseNode()
      const baseSig = sigFor(before)
      const after = baseNode()
      tc.mutate(after)
      expect(sigFor(after)).not.toBe(baseSig)
    })
  }

  it('LOD 翻转（viewport.scale 跨阈值）→ 签名翻转', async () => {
    // engineLodMode 默认 off（vitest 无 window.location），需 ?lod=on 重载模块
    // 才能让 shouldUseEngineLod 在 scale 跨阈值时翻转。
    vi.resetModules()
    vi.stubGlobal('window', { location: { search: '?lod=on' } } as unknown as Window & typeof globalThis)
    try {
      const { paintSignatureFor: sig } = await import('./leaferPaintSignature')
      const node = baseNode()
      const hd = sig(node, ctx({ viewport: { x: 0, y: 0, scale: 1 } }))
      const lod = sig(node, ctx({ viewport: { x: 0, y: 0, scale: 0.0001 } }))
      expect(lod).not.toBe(hd)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('zIndex 变化（ctx.layerOf）→ 签名翻转（文档序变化需重 set）', () => {
    const node = baseNode()
    const s1 = paintSignatureFor(node, ctx({ layerOf: () => 5 }))
    const s2 = paintSignatureFor(node, ctx({ layerOf: () => 6 }))
    expect(s2).not.toBe(s1)
  })

  it('editingNodeId 变化（line label 缺口）→ 签名翻转', () => {
    const node = baseNode()
    const s1 = paintSignatureFor(node, ctx({ editingNodeId: undefined }))
    const s2 = paintSignatureFor(node, ctx({ editingNodeId: 'n1' }))
    expect(s2).not.toBe(s1)
  })

  it('selectedNodeIds 变化 → 签名不变（paint 模块不读 selection，selection 是 DOM overlay 关注点）', () => {
    const node = baseNode()
    const s1 = paintSignatureFor(node, ctx({ selectedNodeIds: new Set() }))
    const s2 = paintSignatureFor(node, ctx({ selectedNodeIds: new Set(['n1']) }))
    expect(s2).toBe(s1)
  })

  it('precomputedLod 参数复用调用方已算的 lod（Greptile P2：避免每节点每帧算两次 shouldUseEngineLod）', () => {
    const node = baseNode()
    // engineLodMode 默认 off → 内部 shouldUseEngineLod 返回 false
    const sigDefault = paintSignatureFor(node, ctx())
    const sigFalse = paintSignatureFor(node, ctx(), false)
    const sigTrue = paintSignatureFor(node, ctx(), true)
    // 显式 false 与内部算（都 false）等价；显式 true 翻转 lod 字段 → 签名变。
    expect(sigFalse).toBe(sigDefault)
    expect(sigTrue).not.toBe(sigDefault)
  })
})
