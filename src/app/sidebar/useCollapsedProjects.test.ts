import { describe, expect, it, beforeEach, vi } from 'vitest'

// useCollapsedProjects wraps a pure localStorage-backed load/save pair. The hook
// itself needs a DOM env (useState/useEffect), which vitest's node env can't
// render; the testable invariants (key name, only-collapsed-ids, default
// expanded, try/catch silent) all live in the pure helpers exercised here.
import { loadCollapsedProjects, saveCollapsedProjects, COLLAPSED_PROJECTS_STORAGE_KEY } from './useCollapsedProjects'

const makeMemStorage = () => {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  }
}

beforeEach(() => {
  const g = globalThis as Record<string, unknown>
  g.localStorage = makeMemStorage()
})

describe('useCollapsedProjects — pure helpers', () => {
  it('pins the storage key to mivo.sidebar.collapsedProjects', () => {
    expect(COLLAPSED_PROJECTS_STORAGE_KEY).toBe('mivo.sidebar.collapsedProjects')
  })

  it('defaults to an empty collapsed set when storage is empty (default expanded)', () => {
    expect(loadCollapsedProjects().size).toBe(0)
  })

  it('round-trips a collapsed set through save → load', () => {
    saveCollapsedProjects(new Set(['p1', 'p2']))
    const loaded = loadCollapsedProjects()
    expect(loaded.has('p1')).toBe(true)
    expect(loaded.has('p2')).toBe(true)
    expect(loaded.size).toBe(2)
  })

  it('only stores collapsed ids (expanded ids are not persisted)', () => {
    saveCollapsedProjects(new Set(['p-collapsed']))
    const raw = (globalThis as { localStorage: { getItem: (k: string) => string | null } }).localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY)!
    const parsed = JSON.parse(raw) as string[]
    expect(parsed).toEqual(['p-collapsed'])
  })

  it('survives a corrupt payload (non-array JSON) by returning an empty set', () => {
    ;(globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem(
      COLLAPSED_PROJECTS_STORAGE_KEY,
      '{"not":"an array"}',
    )
    expect(loadCollapsedProjects().size).toBe(0)
  })

  it('filters non-string entries from a corrupt array payload', () => {
    ;(globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem(
      COLLAPSED_PROJECTS_STORAGE_KEY,
      JSON.stringify(['p1', 42, null, 'p2']),
    )
    const loaded = loadCollapsedProjects()
    expect(loaded.has('p1')).toBe(true)
    expect(loaded.has('p2')).toBe(true)
    expect(loaded.size).toBe(2)
  })

  it('saveCollapsedProjects is a silent no-op when localStorage throws (try/catch)', () => {
    const g = globalThis as Record<string, unknown>
    g.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    }
    expect(() => saveCollapsedProjects(new Set(['p1']))).not.toThrow()
  })

  it('loadCollapsedProjects is a silent empty-set when localStorage throws (try/catch)', () => {
    const g = globalThis as Record<string, unknown>
    g.localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    }
    expect(loadCollapsedProjects().size).toBe(0)
    void vi
  })
})
