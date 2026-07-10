// src/kernel/mapping.test.ts
// T1.2 S1:legacy ↔ record 双向映射 64 字段往返无损单测。
// 权威:docs/decisions/record-schema.md(K40/D24、单一家园、status 派生)。
//
// "64 字段往返无损" = K40(canonical,存)稳定 + D24(派生不存)由 canonical 正确重算:
// ① record round-trip(toRecord→fromRecord→toRecord === toRecord)证 K40 稳定;
// ② D24 显式断言(fromRecord 重算的 D24 值 == 由 canonical 派生的期望值)证 D24 无损;
// ③ anchor 收编 + edge round-trip + 单一家园(relations 无 aiWorkflow)。

import { describe, expect, it } from 'vitest'
import type { CanvasEdge, MivoCanvasNode } from '../types/mivoCanvas'
import {
  anchorsFromRecords,
  anchorsToRecords,
  edgeFromRecord,
  edgeToRecord,
  fromRecord,
  toRecord,
} from './mapping'

// ─── 测试节点 ────────────────────────────────────────────────────────────
const imageNode: MivoCanvasNode = {
  id: 'n-img', type: 'image', title: 'img1',
  transform: { x: 10, y: 20, width: 100, height: 50, rotation: 0 },
  x: 10, y: 20, width: 100, height: 50,
  fills: [{ id: 'f1', kind: 'image', assetUrl: 'http://a/1.png', opacity: 1, visible: true, scaleMode: 'fill' }],
  strokes: [],
  asset: { url: 'http://a/1.png', mimeType: 'image/png', originalName: '1.png', sizeBytes: 200 },
  assetUrl: 'http://a/1.png', assetMimeType: 'image/png', assetOriginalName: '1.png', assetSizeBytes: 200,
  relations: { parentIds: ['n-parent'], sectionId: 'sec1', targetNodeId: 'n-tgt' },
  parentIds: ['n-parent'], sectionId: 'sec1', targetNodeId: 'n-tgt',
  status: 'ready',
}

const frameNode: MivoCanvasNode = {
  id: 'n-frame', type: 'frame', title: 'sec1',
  transform: { x: 0, y: 0, width: 200, height: 200, rotation: 0 },
  x: 0, y: 0, width: 200, height: 200,
  fills: [{ id: 'sf', kind: 'solid', color: '#ffffff', opacity: 1, visible: true }],
  strokes: [{ id: 'ss', color: '#000000', width: 2, style: 'solid', opacity: 1, visible: true }],
  relations: {},
  status: 'ready',
}

const markupNode: MivoCanvasNode = {
  id: 'n-markup', type: 'markup', title: 'mk1',
  transform: { x: 5, y: 5, width: 40, height: 40, rotation: 0 },
  x: 5, y: 5, width: 40, height: 40,
  markupKind: 'brush', markupBrushKind: 'marker',
  markupPoints: [{ x: 1, y: 2 }, { x: 3, y: 4, pressure: 0.5 }],
  fills: [{ id: 'mf', kind: 'solid', color: '#ff0000', opacity: 0.5, visible: true }],
  strokes: [{ id: 'ms', color: '#0000ff', width: 3, style: 'dashed', opacity: 0.8, visible: true }],
  relations: {},
  status: 'ready',
}

const anchorNode: MivoCanvasNode = {
  ...imageNode, id: 'n-anchor',
  experimentalAnchors: [
    { id: 'a1', type: 'point', targetNodeId: 'n-img', x: 100, y: 50, instruction: 'redraw here', createdAt: 1000 },
    { id: 'a2', type: 'box', targetNodeId: 'n-img', x: 10, y: 10, width: 20, height: 30, instruction: 'box area', createdAt: 2000, resultNodeIds: ['n-r1'] },
  ],
}

const edge: CanvasEdge = { id: 'e1', from: 'n-img', to: 'n-frame', type: 'generate', prompt: 'gen', createdAt: 12345 }

describe('T1.2 S1 kernel mapping — 64 字段往返无损', () => {
  // ① record round-trip:toRecord→fromRecord→toRecord === toRecord(K40 稳定)
  describe('① record round-trip (K40 stable)', () => {
    for (const [name, node] of [
      ['image', imageNode], ['frame', frameNode], ['markup', markupNode], ['anchor', anchorNode],
    ] as const) {
      it(`${name}: toRecord→fromRecord→toRecord === toRecord`, () => {
        const r1 = toRecord(node)
        expect(toRecord(fromRecord(r1))).toEqual(r1)
      })
    }
  })

  // ② D24 派生重算(fromRecord 从 canonical 重算 D24,值 == 期望)
  describe('② D24 derivation (fromRecord re-derives from canonical)', () => {
    it('image: x/y/w/h←transform, asset*←asset, relations flats←relations, status=ready(有 asset)', () => {
      const r = fromRecord(toRecord(imageNode))
      // 几何 D24 ← transform
      expect(r.x).toBe(10); expect(r.y).toBe(20); expect(r.width).toBe(100); expect(r.height).toBe(50)
      // 资产 D24 ← asset
      expect(r.assetUrl).toBe('http://a/1.png')
      expect(r.assetMimeType).toBe('image/png')
      expect(r.assetOriginalName).toBe('1.png')
      expect(r.assetSizeBytes).toBe(200)
      // 关系 D24 ← relations(canonical)
      expect(r.parentIds).toEqual(['n-parent'])
      expect(r.sectionId).toBe('sec1')
      expect(r.targetNodeId).toBe('n-tgt')
      // status 派生:有 asset → ready
      expect(r.status).toBe('ready')
    })

    it('frame: section*/frameColor ← fills/strokes, status=failed(无 asset)', () => {
      const r = fromRecord(toRecord(frameNode))
      expect(r.sectionFillColor).toBe('#ffffff') // ← fills[0].color (frame + solid)
      expect(r.sectionBorderColor).toBe('#000000') // ← strokes[0].color (frame + stroke)
      expect(r.sectionBorderWidth).toBe(2)
      expect(r.sectionBorderStyle).toBe('solid')
      expect(r.frameColor).toBe('#000000') // ← stroke color (frame)
      expect(r.status).toBe('failed') // 无 asset → failed (per §2.1)
    })

    it('markup: markup* ← fills/strokes, status=failed(无 asset)', () => {
      const r = fromRecord(toRecord(markupNode))
      expect(r.markupFillColor).toBe('#ff0000') // ← fills[0].color (markup + solid)
      expect(r.markupOpacity).toBe(0.5) // ← fills[0].opacity (markup + solid)
      expect(r.markupStrokeColor).toBe('#0000ff') // ← strokes[0].color (markup + stroke)
      expect(r.markupStrokeWidth).toBe(3)
      expect(r.markupStrokeStyle).toBe('dashed')
      expect(r.markupPoints).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4, pressure: 0.5 }])
      expect(r.status).toBe('failed') // 无 asset → failed
    })

    it('image node K40 fields preserved through round-trip (toMatchObject: all set fields stable)', () => {
      const r = fromRecord(toRecord(imageNode))
      // imageNode 的 set fields(K40 子集 + 一致 D24)在 round-trip 后保持:
      expect(r).toMatchObject(imageNode)
    })
  })

  // ③ anchor 收编 round-trip + edge round-trip + 单一家园
  it('③ anchor: anchorsToRecords → anchorsFromRecords round-trip lossless (DP-2 收编)', () => {
    const records = anchorsToRecords(anchorNode.experimentalAnchors, 0)
    expect(anchorsFromRecords(records)).toEqual(anchorNode.experimentalAnchors)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ id: 'a1', type: 'point', targetNodeId: 'n-img', revision: 0 })
    expect(records[1]).toMatchObject({ id: 'a2', type: 'box', width: 20, height: 30, resultNodeIds: ['n-r1'] })
  })

  it('③ edge: edgeToRecord → edgeFromRecord round-trip lossless', () => {
    const record = edgeToRecord(edge, 7)
    expect(record.revision).toBe(7)
    expect(edgeFromRecord(record)).toEqual(edge)
  })

  it('③ single-home(裁决 6): fromRecord relations has NO aiWorkflow (canonical stays top-level)', () => {
    const nodeWithAiWorkflow: MivoCanvasNode = {
      ...imageNode, id: 'n-aiw',
      aiWorkflow: { kind: 'slot', status: 'empty', sourceNodeIds: ['n-img'] },
      // legacy 双写:relations.aiWorkflow 也设(应被 toRecord 忽略,fromRecord 不回填 relations.aiWorkflow)
      relations: { ...imageNode.relations, aiWorkflow: { kind: 'slot', status: 'empty' } },
    }
    const r = fromRecord(toRecord(nodeWithAiWorkflow))
    // aiWorkflow canonical 留顶层
    expect(r.aiWorkflow).toMatchObject({ kind: 'slot', status: 'empty', sourceNodeIds: ['n-img'] })
    // relations 不含 aiWorkflow(单一家园,不再双写)
    expect(r.relations?.aiWorkflow).toBeUndefined()
  })
})
