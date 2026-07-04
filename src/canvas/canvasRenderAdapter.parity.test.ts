import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { nodeRenderBoxFor } from './canvasRenderAdapter'
import { projectNode, type RenderNode } from '../render/projection'

// PR-C R02b（v4 执行期裁决 · 精简版）— projection ↔ adapter geometry parity + 注册性断言。
//
// 原计划 §3.2 想用 P1-P8 矩阵锁定 "adapter fallback 公式 == projectNode 输出"。但 PR #72
// （a076953）的 sinkVisualDefaults（projection.ts:233-277,:311）已把产品缺省色物化进
// projectNode 输出的 fills/strokes —— adapter 的 `fill?.color || sectionFillColor || '#ffffff'`
// fallback 公式已冗余，消费端直接 `r.fills.find(visibleSolid).color` 即得终值。该等价已由
// src/render/projection.test.ts 的 "frame/markup visual defaults match canvasRenderAdapter"
// 两个 describe 块（:240-398）逐字段锁定，R02（commit #3 adapter 改单次 normalize）的安全网
// 也由那组测试承担，此处不重复 P1-P6/P4b/P4c/P5b/P6b。
//
// 本文件只补两处真实缺口 + 一条注册性断言：
//   P7 — image 节点 nodeRenderBoxFor 的 transform 字符串 == 由 projectNode.geometry 拼出的同式
//        （含 legacy 无 transform 节点两侧都从 x/y/w/h 派生）
//   P8 — rotation 后缀两侧一致（0 省略 / 非零 ` rotate(Rdeg)`）
//   注册 — projectNode 对 frame/markup 输出 fills/strokes 恒 Array.isArray（锁死缺省 [] 语义
//        不被后续改动悄悄变成 undefined；不断言内容/长度，那由 projection.test.ts 锁）

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'img-1',
  type: 'image',
  title: 'Image',
  status: 'ready',
  x: 32,
  y: 48,
  width: 320,
  height: 180,
  transform: { x: 32, y: 48, width: 320, height: 180, rotation: 12.5 },
  ...overrides,
})

// 复刻 canvasRenderAdapter.nodeRenderBoxFor 的 transform 拼装公式，作为从 projectNode.geometry
// 推导等价字符串的契约公式。两侧逐字符相等 = 几何投影一致。
const transformStringFromGeometry = (geometry: RenderNode['geometry']): string => {
  const translate = `translate(${geometry.x}px, ${geometry.y}px)`
  const rotate = geometry.rotation ? ` rotate(${geometry.rotation}deg)` : ''
  return `${translate}${rotate}`
}

describe('canvasRenderAdapter ↔ projection geometry parity (P7/P8)', () => {
  it('P7: nodeRenderBoxFor transform == same formula on projectNode.geometry (V2 image, rotation 0)', () => {
    const node = imageNode({
      transform: { x: 32, y: 48, width: 320, height: 180, rotation: 0 },
    })
    const box = nodeRenderBoxFor(node)
    const r = projectNode(node)

    expect(box.transform).toBe(transformStringFromGeometry(r.geometry))
    expect(box.width).toBe(r.geometry.width)
    expect(box.height).toBe(r.geometry.height)
  })

  it('P8: rotation suffix omitted when 0 and present when non-zero, on both sides', () => {
    const withRotation = imageNode({
      transform: { x: 10, y: 20, width: 100, height: 80, rotation: 12.5 },
    })
    const withoutRotation = imageNode({
      transform: { x: 10, y: 20, width: 100, height: 80, rotation: 0 },
    })

    const boxRot = nodeRenderBoxFor(withRotation)
    const rRot = projectNode(withRotation)
    expect(boxRot.transform).toBe('translate(10px, 20px) rotate(12.5deg)')
    expect(boxRot.transform).toBe(transformStringFromGeometry(rRot.geometry))

    const boxFlat = nodeRenderBoxFor(withoutRotation)
    const rFlat = projectNode(withoutRotation)
    expect(boxFlat.transform).toBe('translate(10px, 20px)')
    expect(boxFlat.transform).toBe(transformStringFromGeometry(rFlat.geometry))
  })

  it('P7 legacy: node without transform — both sides derive geometry from top-level x/y/w/h', () => {
    const legacy: MivoCanvasNode = {
      id: 'img-2',
      type: 'image',
      title: 'Legacy',
      status: 'ready',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      assetUrl: 'https://example.com/cat.png',
    }
    const box = nodeRenderBoxFor(legacy)
    const r = projectNode(legacy)

    expect(box.transform).toBe(transformStringFromGeometry(r.geometry))
    expect(box.width).toBe(r.geometry.width)
    expect(box.height).toBe(r.geometry.height)
  })
})

describe('projection fills/strokes registration (always arrays for frame/markup)', () => {
  // 注册性断言：projectNode 对 frame/markup 输出的 fills/strokes 恒为数组。锁死 projection
  // 的缺省 [] 语义（projection.ts:305-306）+ sinkVisualDefaults 追加语义不被后续改动悄悄
  // 变成 undefined。不断言内容/长度——内容等价已由 projection.test.ts:240-398 锁定。
  const frameNoFills: MivoCanvasNode = {
    id: 'frame-1',
    type: 'frame',
    title: 'F',
    status: 'ready',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  }
  const markupNoFills: MivoCanvasNode = {
    id: 'markup-1',
    type: 'markup',
    title: 'M',
    status: 'ready',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    markupKind: 'rect',
  }

  it('frame fills/strokes are always arrays (never undefined)', () => {
    const r = projectNode(frameNoFills)
    expect(Array.isArray(r.fills)).toBe(true)
    expect(Array.isArray(r.strokes)).toBe(true)
  })

  it('markup fills/strokes are always arrays (never undefined)', () => {
    const r = projectNode(markupNoFills)
    expect(Array.isArray(r.fills)).toBe(true)
    expect(Array.isArray(r.strokes)).toBe(true)
  })
})
