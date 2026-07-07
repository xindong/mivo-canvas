// src/lib/keyFormat.test.ts
import { describe, it, expect } from 'vitest'
import { isGatewayKey, isMivoKey, isMivoKeyPrefix, keyHash, keyTail, maskKey } from './keyFormat'

describe('keyFormat — gateway key (sk-)', () => {
  it('isGatewayKey: true only for sk- prefix', () => {
    expect(isGatewayKey('sk-abcdef0123')).toBe(true)
    expect(isGatewayKey('mivo_abcdef')).toBe(false)
    expect(isGatewayKey('')).toBe(false)
    expect(isGatewayKey('not-a-key')).toBe(false)
  })
})

describe('keyFormat — mivo key (mivo_)', () => {
  it('isMivoKey: requires mivo_ prefix AND length >= 12', () => {
    expect(isMivoKey('mivo_abcdefg')).toBe(true) // length 12 (mivo_ + 7)
    expect(isMivoKey('mivo_abcdef')).toBe(false) // length 11, too short
    expect(isMivoKey('mivo_ab')).toBe(false) // too short
    expect(isMivoKey('mivo_')).toBe(false) // prefix only
    expect(isMivoKey('sk-abcdef')).toBe(false) // wrong family
    expect(isMivoKey('')).toBe(false)
  })

  it('isMivoKeyPrefix: true for any mivo_ prefix regardless of length', () => {
    expect(isMivoKeyPrefix('mivo_ab')).toBe(true)
    expect(isMivoKeyPrefix('mivo_')).toBe(true)
    expect(isMivoKeyPrefix('sk-abc')).toBe(false)
  })
})

describe('keyFormat — maskKey', () => {
  it('keeps prefix + last 4, hides the middle', () => {
    expect(maskKey('sk-abcdef0123')).toBe('sk-••••••0123')
    expect(maskKey('mivo_abcdef0123')).toBe('mivo_••••••0123')
  })
  it('returns empty for empty or too-short input (never echoes a partial secret)', () => {
    expect(maskKey('')).toBe('')
    expect(maskKey('sk-')).toBe('')
    expect(maskKey('mivo_')).toBe('')
    expect(maskKey('sk-ab')).toBe('') // prefix(3) + 4 tail > length(4) → can't mask safely
  })
})

describe('keyFormat — keyTail (last 4 for client logs)', () => {
  it('returns last 4 chars for a normal key', () => {
    expect(keyTail('sk-abcdef0123')).toBe('0123')
    expect(keyTail('mivo_abcdef0123')).toBe('0123')
  })
  it('sentinels for degenerate input', () => {
    expect(keyTail(null)).toBe('<empty>')
    expect(keyTail('')).toBe('<empty>')
    expect(keyTail('ab')).toBe('<short>')
    expect(keyTail('abcd')).toBe('<short>') // length 4 → not enough to reveal tail safely
  })
})

describe('keyFormat — keyHash (sha256 first 12 for log reconciliation)', () => {
  it('returns 12 hex chars for a non-empty key', async () => {
    const hash = await keyHash('sk-abcdef0123')
    expect(hash).toHaveLength(12)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
  })
  it('is stable: same key → same hash', async () => {
    const a = await keyHash('mivo_abcdef0123')
    const b = await keyHash('mivo_abcdef0123')
    expect(a).toBe(b)
  })
  it('differs across keys', async () => {
    const a = await keyHash('sk-aaaa0000')
    const b = await keyHash('sk-bbbb1111')
    expect(a).not.toBe(b)
  })
  it('returns empty string for empty input', async () => {
    expect(await keyHash('')).toBe('')
  })
})
