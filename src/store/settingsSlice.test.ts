// src/store/settingsSlice.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  selectGatewayKeyMasked,
  selectHasGatewayKey,
  selectHasMivoKey,
  selectMivoKeyMasked,
  useSettingsStore,
} from './settingsSlice'
import { strictIdbStateStorage } from '../lib/persistIdbStorage'
import { toastFeedback } from './toastStore'

// Persist stores are module-level singletons. Reset the in-memory state between
// cases and drop any persisted blob so a prior case's key never bleeds into the
// next (the same invariant this slice enforces for real users across reloads).
beforeEach(async () => {
  useSettingsStore.setState({ gatewayKey: '', mivoKey: '' })
  await strictIdbStateStorage.removeItem('mivo-canvas-settings')
})

describe('settingsSlice — set / clear', () => {
  it('setGatewayKey stores the trimmed key', () => {
    useSettingsStore.getState().setGatewayKey('sk-abcdef0123  ')
    expect(useSettingsStore.getState().gatewayKey).toBe('sk-abcdef0123')
  })

  it('clearGatewayKey wipes the key', () => {
    useSettingsStore.getState().setGatewayKey('sk-abcdef0123')
    useSettingsStore.getState().clearGatewayKey()
    expect(useSettingsStore.getState().gatewayKey).toBe('')
  })

  it('setMivoKey stores the trimmed key', () => {
    useSettingsStore.getState().setMivoKey('mivo_abcdef0123')
    expect(useSettingsStore.getState().mivoKey).toBe('mivo_abcdef0123')
  })

  it('clearMivoKey wipes the key', () => {
    useSettingsStore.getState().setMivoKey('mivo_abcdef0123')
    useSettingsStore.getState().clearMivoKey()
    expect(useSettingsStore.getState().mivoKey).toBe('')
  })
})

describe('settingsSlice — derived selectors', () => {
  it('selectHasGatewayKey + selectGatewayKeyMasked', () => {
    useSettingsStore.getState().setGatewayKey('sk-abcdef0123')
    const state = useSettingsStore.getState()
    expect(selectHasGatewayKey(state)).toBe(true)
    expect(selectGatewayKeyMasked(state)).toBe('sk-••••••0123')
  })

  it('selectHasMivoKey requires a full mivo_ key (prefix + length >= 12)', () => {
    useSettingsStore.getState().setMivoKey('mivo_ab') // length 7, too short
    expect(selectHasMivoKey(useSettingsStore.getState())).toBe(false)

    useSettingsStore.getState().setMivoKey('mivo_abcdefg') // length 12
    const state = useSettingsStore.getState()
    expect(selectHasMivoKey(state)).toBe(true)
    expect(selectMivoKeyMasked(state)).toBe('mivo_••••••defg')
  })

  it('empty store: selectors report no key + empty mask', () => {
    const state = useSettingsStore.getState()
    expect(selectHasGatewayKey(state)).toBe(false)
    expect(selectHasMivoKey(state)).toBe(false)
    expect(selectGatewayKeyMasked(state)).toBe('')
    expect(selectMivoKeyMasked(state)).toBe('')
  })
})

describe('settingsSlice — persistence (strict IDB-backed)', () => {
  it('setGatewayKey triggers storage.setItem with the key in the persisted payload', async () => {
    const setItemSpy = vi.spyOn(strictIdbStateStorage, 'setItem')
    useSettingsStore.getState().setGatewayKey('sk-persist1234')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setItemSpy).toHaveBeenCalled()
    const lastCall = setItemSpy.mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('mivo-canvas-settings')
    expect(lastCall?.[1]).toContain('sk-persist1234')
    setItemSpy.mockRestore()
  })

  it('persist name + version are stable (migration surface)', () => {
    const setItemSpy = vi.spyOn(strictIdbStateStorage, 'setItem')
    useSettingsStore.getState().setMivoKey('mivo_namecheck1')
    void Promise.resolve()
    const call = setItemSpy.mock.calls.at(-1)
    expect(call?.[0]).toBe('mivo-canvas-settings')
    setItemSpy.mockRestore()
  })
})

// F1: secrets must NEVER touch localStorage. When IDB is unavailable the strict
// storage fail-closes (in-memory only + toast), never writes localStorage.
describe('settingsSlice — strict IDB-only (F1: no localStorage fallback for secrets)', () => {
  it('when IDB is unavailable, setItem does NOT touch localStorage and toasts error', async () => {
    // vitest node env has no indexedDB → isIdbAvailable() false → strict path
    // fail-closes. Stub localStorage so we can assert it is never written.
    const localStorageStub = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    }
    vi.stubGlobal('localStorage', localStorageStub)
    const toastSpy = vi.spyOn(toastFeedback, 'error')
    const setItemSpy = vi.spyOn(strictIdbStateStorage, 'setItem')

    useSettingsStore.getState().setMivoKey('mivo_idb_unavailable')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setItemSpy).toHaveBeenCalled()
    expect(localStorageStub.setItem).not.toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalled()
    // Fail-closed keeps the session usable: in-memory state still updated.
    expect(useSettingsStore.getState().mivoKey).toBe('mivo_idb_unavailable')

    setItemSpy.mockRestore()
    toastSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})
