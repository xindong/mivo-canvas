import { describe, expect, it } from 'vitest'
import {
  defaultStampKind,
  stampCursorCssFor,
  stampDefinitions,
  stampGrowthSizes,
  stampLabelFor,
  stampSrcFor,
} from './stampDefs'

describe('stampDefs', () => {
  it('provides an SVG sticker set with unique kinds and sources', () => {
    expect(stampDefinitions.length).toBe(10)
    expect(new Set(stampDefinitions.map((definition) => definition.kind)).size).toBe(stampDefinitions.length)
    expect(new Set(stampDefinitions.map((definition) => definition.src)).size).toBe(stampDefinitions.length)
    expect(stampDefinitions.every((definition) => definition.src.endsWith('.svg'))).toBe(true)
    expect(stampDefinitions.some((definition) => definition.kind === defaultStampKind)).toBe(true)
  })

  it('resolves src and label with a safe fallback', () => {
    expect(stampSrcFor('heart')).toBe('/stickers/heart.svg')
    expect(stampLabelFor('heart')).toBe('Heart')
    expect(stampSrcFor(undefined)).toBe(stampDefinitions[0].src)
    expect(stampLabelFor(undefined)).toBe('+1')
  })

  it('grows through four strictly increasing FigJam-style stages', () => {
    expect(stampGrowthSizes).toHaveLength(4)
    for (let index = 1; index < stampGrowthSizes.length; index += 1) {
      expect(stampGrowthSizes[index]).toBeGreaterThan(stampGrowthSizes[index - 1])
    }
  })

  it('builds a distinct placement cursor per stamp kind', () => {
    const cursors = new Set(stampDefinitions.map((definition) => stampCursorCssFor(definition.kind)))

    expect(cursors.size).toBe(stampDefinitions.length)
    expect([...cursors].every((cursor) => cursor.endsWith(', copy'))).toBe(true)
  })
})
