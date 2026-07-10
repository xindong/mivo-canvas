import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ANONYMOUS_USER_ID,
  __resetPersistUserId,
  getPersistUserId,
  namespacedKey,
  setPersistUserId,
} from './persistUserId'

// FX-6 unit tests — the per-user namespace primitive.
// Pure module (no IDB / no DOM): fast, no mocks. Covers the key composition that
// every cache layer routes through, plus the reset hook used by the heavier
// adapter tests.

beforeEach(() => __resetPersistUserId())
afterEach(() => __resetPersistUserId())

describe('FX-6 persistUserId — namespace key composition', () => {
  it('defaults to the anonymous namespace until auth sets a user', () => {
    expect(getPersistUserId()).toBe(ANONYMOUS_USER_ID)
    expect(getPersistUserId()).toBe('anonymous')
  })

  it('anonymous namespace maps to the RAW legacy key (no suffix)', () => {
    // This is the compatibility seam: every pre-auth / test session keeps using the
    // un-suffixed key it always used, so characterization + contract tests that
    // seed `mivo-canvas-demo` directly still pass byte-for-byte.
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo')
    expect(namespacedKey('mivo-chat-demo')).toBe('mivo-chat-demo')
  })

  it('authenticated namespace appends `:<userId>`', () => {
    setPersistUserId('zhuzan@xd.com')
    expect(getPersistUserId()).toBe('zhuzan@xd.com')
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo:zhuzan@xd.com')
    expect(namespacedKey('mivo-chat-demo')).toBe('mivo-chat-demo:zhuzan@xd.com')
  })

  it('setPersistUserId is idempotent — re-setting the same id is a no-op', () => {
    setPersistUserId('userA')
    const before = getPersistUserId()
    setPersistUserId('userA')
    expect(getPersistUserId()).toBe(before)
  })

  it('empty / null / whitespace resets to anonymous (never an empty suffix)', () => {
    setPersistUserId('userA')
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo:userA')
    setPersistUserId('')
    expect(getPersistUserId()).toBe(ANONYMOUS_USER_ID)
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo')
    setPersistUserId('   ')
    expect(getPersistUserId()).toBe(ANONYMOUS_USER_ID)
    setPersistUserId(null)
    expect(getPersistUserId()).toBe(ANONYMOUS_USER_ID)
    setPersistUserId(undefined)
    expect(getPersistUserId()).toBe(ANONYMOUS_USER_ID)
  })

  it('switching users flips the physical key (namespace switch detector signal)', () => {
    setPersistUserId('userA')
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo:userA')
    setPersistUserId('userB')
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo:userB')
    setPersistUserId(ANONYMOUS_USER_ID)
    expect(namespacedKey('mivo-canvas-demo')).toBe('mivo-canvas-demo')
  })
})
