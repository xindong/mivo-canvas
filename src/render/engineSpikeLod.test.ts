import { describe, expect, it, vi } from 'vitest'

vi.mock('./engineLodMode', () => ({
  engineLodMode: 'on',
  engineLodThresholdPx: 32,
  isEngineLodRequested: true,
}))

import { shouldUseEngineLod, summarizeEngineLod } from './engineSpikeLod'
import type { MivoCanvasNode } from '../types/mivoCanvas'

const node = (partial: Partial<MivoCanvasNode>): MivoCanvasNode =>
  ({
    id: partial.id ?? 'n',
    status: 'ready',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ...partial,
  }) as unknown as MivoCanvasNode

describe('engineSpikeLod — 0g 全景 LOD 候选集', () => {
  it('image/text plus shape/line below threshold use LOD', () => {
    const viewport = { x: 0, y: 0, scale: 0.1 }
    expect(shouldUseEngineLod(node({ id: 'i', type: 'image' }), viewport)).toBe(true)
    expect(shouldUseEngineLod(node({ id: 't', type: 'text' }), viewport)).toBe(true)
    expect(shouldUseEngineLod(node({ id: 'f', type: 'frame' }), viewport)).toBe(true)
    expect(shouldUseEngineLod(node({ id: 'r', type: 'markup', markupKind: 'rect' }), viewport)).toBe(true)
    expect(shouldUseEngineLod(node({ id: 'a', type: 'markup', markupKind: 'arrow' }), viewport)).toBe(true)
    expect(shouldUseEngineLod(node({ id: 's', type: 'markup', markupKind: 'stamp' }), viewport)).toBe(false)
  })

  it('summary reports image/text/shape/line buckets and high-fidelity remainder', () => {
    const viewport = { x: 0, y: 0, scale: 0.1 }
    const stats = summarizeEngineLod(
      [
        node({ id: 'i', type: 'image' }),
        node({ id: 't', type: 'text' }),
        node({ id: 'f', type: 'frame' }),
        node({ id: 'a', type: 'markup', markupKind: 'arrow' }),
        node({ id: 'big', type: 'markup', markupKind: 'line', width: 500, height: 500 }),
      ],
      viewport,
    )

    expect(stats).toMatchObject({
      lodNodeCount: 4,
      lodImageCount: 1,
      lodTextCount: 1,
      lodShapeCount: 1,
      lodLineCount: 1,
      highFidelityNodeCount: 1,
    })
  })
})
