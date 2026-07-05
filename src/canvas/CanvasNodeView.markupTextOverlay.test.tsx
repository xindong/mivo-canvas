import { describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// FU-11: leafer 模式下被 Leafer 真画的 markup 节点，CanvasNodeView 只渲染
// "纯文字壳"（.markup-text-overlay + MarkupTextLayer），本体（SVG/note 背景）
// 与 handle 全部跳过。rendererMode 是 URL flag 的模块常量，这里 mock 成 leafer。
vi.mock('../render/rendererMode', () => ({ rendererMode: 'leafer' }))

// canvasStore 传递引入 demoScenes → demoImages 需要 document（node 测试环境
// 没有）——与 leaferLinePaint.test.ts 同款 mock。
vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

import { CanvasNodeView } from './CanvasNodeView'
import type { CanvasNodeViewProps } from './CanvasNodeView'
import type { MivoCanvasNode } from '../types/mivoCanvas'

const markupNode = (opts: Partial<MivoCanvasNode>): MivoCanvasNode =>
  ({
    id: 'm1',
    type: 'markup',
    status: 'ready',
    markupKind: 'note',
    x: 10,
    y: 20,
    width: 160,
    height: 120,
    ...opts,
  }) as unknown as MivoCanvasNode

const renderNodeView = (node: MivoCanvasNode, overrides: Partial<CanvasNodeViewProps> = {}) =>
  renderToStaticMarkup(
    h(CanvasNodeView, {
      node,
      selected: false,
      selectionPreview: false,
      sectionDropTarget: false,
      connectorDropTarget: false,
      primarySelected: false,
      editing: false,
      effectiveLocked: false,
      handleSize: 10,
      handleBorderWidth: 2,
      selectionStrokeWidth: 2,
      onResizeHandlePointerDown: () => {},
      onMarkupPointPointerDown: () => {},
      onTextResizeHandlePointerDown: () => {},
      onUpdateText: () => {},
      onFinishTextEdit: () => {},
      onResizeNodeToContent: () => {},
      ...overrides,
    }),
  )

describe('CanvasNodeView markup 纯文字壳（leafer 模式，FU-11）', () => {
  it('note：壳只含 MarkupTextLayer——正文可见，note 背景/SVG 本体不渲染', () => {
    const html = renderNodeView(markupNode({ text: '便签正文' }))
    expect(html).toContain('markup-text-overlay')
    expect(html).toContain('dom-markup-label')
    expect(html).toContain('便签正文')
    expect(html).not.toContain('dom-markup-note')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('node-handle')
  })

  it('rect：标注文字走 shape-label；本体 SVG 由 Leafer 真画不出现在 DOM', () => {
    const html = renderNodeView(markupNode({ markupKind: 'rect', text: '标注' }))
    expect(html).toContain('shape-label kind-rect')
    expect(html).toContain('标注')
    expect(html).not.toContain('<svg')
  })

  it('arrow：线上 label 定位在中点（line-label），线体由 Leafer 画', () => {
    const html = renderNodeView(
      markupNode({
        markupKind: 'arrow',
        markupPoints: [
          { x: 0, y: 100 },
          { x: 200, y: 0 },
        ],
        text: 'Flow',
      }),
    )
    expect(html).toContain('line-label')
    expect(html).toContain('Flow')
    expect(html).toContain('left:100px')
    expect(html).toContain('top:50px')
    expect(html).not.toContain('<svg')
  })

  it('编辑态：空文字也渲染编辑器（双击新增文字入口），壳带 editing', () => {
    const html = renderNodeView(markupNode({ markupKind: 'rect' }), { editing: true })
    expect(html).toContain('markup-text-overlay editing')
    expect(html).toContain('dom-markup-text-editor')
  })

  it('选中态视觉不进壳：selected/primarySelected 不产生 selected class 与 handle（与无文字 markup 的 leafer 现状一口径）', () => {
    const html = renderNodeView(markupNode({ text: 'x' }), { selected: true, primarySelected: true })
    expect(html).not.toContain('selected')
    expect(html).not.toContain('markup-point-handle')
  })

  it('frame：纯标题壳只含 dom-frame-title——盒体（底色/虚线框）由 Leafer 真画不出现在 DOM（FU-12）', () => {
    const html = renderNodeView(
      markupNode({ type: 'frame', markupKind: undefined, title: 'Section 1', width: 560, height: 320 }),
    )
    expect(html).toContain('frame-title-overlay')
    expect(html).toContain('dom-frame-title')
    expect(html).toContain('Section 1')
    expect(html).not.toContain('dom-frame-node')
    expect(html).not.toContain('node-handle')
  })

  it('非 Leafer 真画类型（text 节点）不受影响：leafer 模式下仍全量 DOM 渲染', () => {
    const html = renderNodeView(
      markupNode({ type: 'text', markupKind: undefined, text: 'plain' }),
    )
    expect(html).toContain('dom-text-node')
    expect(html).not.toContain('markup-text-overlay')
  })
})
