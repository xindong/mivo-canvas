import { describe, expect, it } from 'vitest'
import {
  defaultStampKind,
  stampCursorCssFor,
  stampDefinitions,
  stampEmojiFor,
  stampGrowthSizes,
  stampLabelFor,
} from './stampDefs'

describe('stampDefs', () => {
  it('provides a FigJam-style stamp set with unique kinds and emojis', () => {
    expect(stampDefinitions.length).toBeGreaterThanOrEqual(6)
    expect(new Set(stampDefinitions.map((definition) => definition.kind)).size).toBe(stampDefinitions.length)
    expect(new Set(stampDefinitions.map((definition) => definition.emoji)).size).toBe(stampDefinitions.length)
    expect(stampDefinitions.some((definition) => definition.kind === defaultStampKind)).toBe(true)
  })

  it('resolves emoji and label with a safe fallback', () => {
    expect(stampEmojiFor('heart')).toBe('❤️')
    expect(stampLabelFor('heart')).toBe('Heart')
    expect(stampEmojiFor(undefined)).toBe('👍')
  })

  it('grows through four strictly increasing FigJam-style stages', () => {
    expect(stampGrowthSizes).toHaveLength(4)
    for (let index = 1; index < stampGrowthSizes.length; index += 1) {
      expect(stampGrowthSizes[index]).toBeGreaterThan(stampGrowthSizes[index - 1])
    }
  })

  it('builds a distinct emoji cursor per stamp kind', () => {
    const cursors = new Set(stampDefinitions.map((definition) => stampCursorCssFor(definition.kind)))

    expect(cursors.size).toBe(stampDefinitions.length)
    expect([...cursors].every((cursor) => cursor.includes('data:image/svg+xml'))).toBe(true)
  })
})
