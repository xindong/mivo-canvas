import { describe, expect, it } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  smartSelectionGapFor,
  smartSelectionHandlesFor,
  smartSelectionLayoutFor,
  smartSelectionSpacingUpdates,
} from './smartSelection'

const node = (id: string, x: number, y: number, width: number, height: number): MivoCanvasNode => ({
  id,
  type: 'image',
  title: id,
  x,
  y,
  width,
  height,
  status: 'ready',
})

describe('smartSelection', () => {
  it('adjusts a row as one uniform smart-selection gap', () => {
    const nodes = [
      node('a', 0, 0, 100, 80),
      node('b', 140, 10, 100, 60),
      node('c', 300, 0, 100, 80),
    ]
    const layout = smartSelectionLayoutFor(nodes, { isEffectivelyLocked: () => false })
    expect(layout?.kind).toBe('row')
    expect(layout ? smartSelectionGapFor(layout, 'horizontal', 0) : undefined).toBe(40)

    const updates = smartSelectionSpacingUpdates(
      {
        pointerId: 1,
        axis: 'horizontal',
        index: 0,
        layoutKind: 'row',
        startClientX: 0,
        startClientY: 0,
        startGap: 40,
        startLayout: layout!,
      },
      20,
      0,
      1,
    ).updates

    expect(updates.map((update) => Math.round(update.x))).toEqual([0, 160, 320])
    expect(updates.map((update) => Math.round(update.y))).toEqual([0, 10, 0])
  })

  it('adjusts grid column gaps while preserving each column contents', () => {
    const nodes = [
      node('a', 0, 0, 100, 80),
      node('b', 140, 0, 80, 80),
      node('c', 10, 120, 100, 80),
      node('d', 150, 120, 80, 80),
    ]
    const layout = smartSelectionLayoutFor(nodes, { isEffectivelyLocked: () => false })
    expect(layout?.kind).toBe('grid')
    expect(layout ? smartSelectionGapFor(layout, 'horizontal', 0) : undefined).toBe(30)

    const handles = smartSelectionHandlesFor(nodes, { isEffectivelyLocked: () => false, viewportScale: 1 })
    expect(handles.some((handle) => handle.axis === 'horizontal' && handle.layoutKind === 'grid')).toBe(true)
    expect(handles.some((handle) => handle.axis === 'vertical' && handle.layoutKind === 'grid')).toBe(true)

    const updates = smartSelectionSpacingUpdates(
      {
        pointerId: 1,
        axis: 'horizontal',
        index: 0,
        layoutKind: 'grid',
        startClientX: 0,
        startClientY: 0,
        startGap: 30,
        startLayout: layout!,
      },
      20,
      0,
      1,
    ).updates

    expect(Object.fromEntries(updates.map((update) => [update.id, Math.round(update.x)]))).toEqual({
      a: 0,
      b: 160,
      c: 10,
      d: 170,
    })
  })
})
