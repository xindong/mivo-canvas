// src/canvas/maskEditDraftStore.test.ts
// 锚点草稿仓单测:存/取/清 + 空锚点等价清除。
import { describe, it, expect, beforeEach } from 'vitest'
import { clearMaskEditDraft, getMaskEditDraft, saveMaskEditDraft, type MaskEditDraft } from './maskEditDraftStore'

const draft = (regionCount: number): MaskEditDraft => ({
  regions: Array.from({ length: regionCount }, (_, i) => ({
    type: 'ellipse' as const,
    x: i * 10,
    y: 0,
    width: 50,
    height: 40,
  })),
  pointAnchors: [],
  recognitions: {
    '0:0:50:40': { candidates: [{ label: '蓝色烟雾', scope: 'part' }], selectedIndex: 0, customLabel: '', recognizing: false },
  },
  editorHtml: '<span data-anchor-key="0:0:50:40">蓝色烟雾</span> 去除',
})

describe('maskEditDraftStore', () => {
  beforeEach(() => {
    clearMaskEditDraft('n1')
    clearMaskEditDraft('n2')
  })

  it('按 nodeId 保存并读取,互不串图', () => {
    saveMaskEditDraft('n1', draft(2))
    saveMaskEditDraft('n2', draft(1))
    expect(getMaskEditDraft('n1')?.regions).toHaveLength(2)
    expect(getMaskEditDraft('n2')?.regions).toHaveLength(1)
    expect(getMaskEditDraft('n1')?.editorHtml).toContain('去除')
  })

  it('空锚点保存等价清除(手动删光即遗忘)', () => {
    saveMaskEditDraft('n1', draft(2))
    saveMaskEditDraft('n1', { ...draft(0), recognitions: {}, editorHtml: '残留文字' })
    expect(getMaskEditDraft('n1')).toBeUndefined()
  })

  it('clear 清除(提交成功/图被删)', () => {
    saveMaskEditDraft('n1', draft(1))
    clearMaskEditDraft('n1')
    expect(getMaskEditDraft('n1')).toBeUndefined()
  })
})
