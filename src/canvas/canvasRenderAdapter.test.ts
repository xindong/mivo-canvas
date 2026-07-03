import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  frameRenderStyleFor,
  markupRenderStyleFor,
  nodeRenderBoxFor,
  textRenderStyleFor,
} from './canvasRenderAdapter'

const baseNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'node-1',
  type: 'image',
  title: 'Node',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  ...overrides,
})

describe('canvasRenderAdapter', () => {
  it('maps semantic transform to a CSS render box with rotation', () => {
    const box = nodeRenderBoxFor(
      baseNode({
        transform: {
          x: 32,
          y: 48,
          width: 320,
          height: 180,
          rotation: 12.5,
        },
      }),
    )

    expect(box).toEqual({
      width: 320,
      height: 180,
      transform: 'translate(32px, 48px) rotate(12.5deg)',
      transformOrigin: '50% 50%',
    })
  })

  it('omits rotate when semantic rotation is zero', () => {
    const box = nodeRenderBoxFor(
      baseNode({
        transform: {
          x: 32,
          y: 48,
          width: 320,
          height: 180,
          rotation: 0,
        },
      }),
    )

    expect(box.transform).toBe('translate(32px, 48px)')
  })

  it('extracts frame render style from v2 fills and strokes before legacy fields', () => {
    const style = frameRenderStyleFor(
      baseNode({
        type: 'frame',
        sectionFillColor: '#legacy-fill',
        sectionBorderColor: '#legacy-stroke',
        fills: [{ id: 'fill-1', kind: 'solid', color: '#f8f5ff', opacity: 0.8, visible: true }],
        strokes: [{ id: 'stroke-1', color: '#4b33c4', width: 3, style: 'dashed', opacity: 1, visible: true }],
      }),
    )

    expect(style).toEqual({
      '--section-fill-color': '#f8f5ff',
      '--section-border-color': '#4b33c4',
      '--section-border-width': '3px',
      '--section-border-style': 'dashed',
    })
  })

  it('extracts markup paint style from v2 fills and strokes with legacy fallback', () => {
    const semanticStyle = markupRenderStyleFor(
      baseNode({
        type: 'markup',
        fills: [{ id: 'fill-1', kind: 'solid', color: '#fff2a8', opacity: 1, visible: true }],
        strokes: [{ id: 'stroke-1', color: '#806000', width: 5, style: 'solid', opacity: 0.7, visible: true }],
      }),
    )
    const legacyStyle = markupRenderStyleFor(
      baseNode({
        type: 'markup',
        markupFillColor: '#fff1a8',
        markupStrokeColor: '#6957e8',
        markupStrokeWidth: 4,
        markupStrokeStyle: 'dashed',
        markupOpacity: 0.5,
      }),
    )

    expect(semanticStyle).toEqual({
      fill: '#fff2a8',
      stroke: '#806000',
      strokeWidth: 5,
      strokeStyle: 'solid',
      strokeOpacity: 0.7,
    })
    expect(legacyStyle).toEqual({
      fill: '#fff1a8',
      stroke: '#6957e8',
      strokeWidth: 4,
      strokeStyle: 'dashed',
      strokeOpacity: 0.5,
    })
  })

  it('extracts text render style from legacy text fields', () => {
    const style = textRenderStyleFor(
      baseNode({
        type: 'text',
        fontSize: 18,
        textColor: '#123456',
        fontWeight: 700,
        textAlign: 'center',
      }),
    )

    expect(style).toEqual({
      fontSize: 18,
      color: '#123456',
      fontWeight: 700,
      textAlign: 'center',
    })
  })
})
