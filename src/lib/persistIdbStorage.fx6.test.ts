import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetIdbPersist,
  clearCurrentUserCache,
  idbStateStorage,
} from './persistIdbStorage'
import { __resetPersistUserId as resetUserId, setPersistUserId } from './persistUserId'

// FX-6 acceptance tests — per-user cache namespacing for the canvas/chat KV
// adapter. Reuses the same in-memory IDB mock shape as persistIdbStorage.test.ts
// (request settles as a microtask, tx.oncomplete fires after). Isolation and
// migration are verified through the adapter + userId switching (no direct kv
// access) — that's the real observable contract.

// --- in-memory DOM storage stubs (node vitest has no DOM globals) ---
const memStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  }
}

// Minimal in-memory IDB factory covering the adapter's touch points:
// open(name, version) → onupgradeneeded / onsuccess → IDBDatabase
// db.transaction(store, mode) → IDBTransaction.objectStore()
// store.get/put/delete → IDBRequest.onsuccess (microtask) then tx.oncomplete.
// Not spec-compliant — enough surface for idbStateStorage's three operations.
const makeInMemoryIdb = (): IDBFactory => {
  const dbs = new Map<string, { stores: Map<string, Map<string, unknown>>; version: number }>()

  const makeStore = (
    map: Map<string, unknown>,
    scheduleTxComplete: () => void,
  ): IDBObjectStore => {
    const mkReq = <T>(result: T, error: DOMException | null = null) => {
      const r = { onsuccess: null, onerror: null, result, error } as unknown as IDBRequest<T>
      queueMicrotask(() => {
        if (error) {
          ;(r as unknown as { onerror: ((ev: Event) => void) | null }).onerror?.(new Event('error'))
        } else {
          ;(r as unknown as { onsuccess: ((ev: Event) => void) | null }).onsuccess?.(new Event('success'))
        }
        scheduleTxComplete()
      })
      return r
    }
    return {
      get: (key: string) => mkReq(map.has(key) ? map.get(key) : undefined),
      put: (value: unknown) => {
        const rec = value as { key?: string }
        if (rec && typeof rec.key === 'string') map.set(rec.key, value)
        return mkReq<unknown>(rec?.key)
      },
      delete: (key: string) => {
        map.delete(key)
        return mkReq<unknown>(undefined)
      },
    } as unknown as IDBObjectStore
  }

  const factory = {
    open(name: string, version?: number) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined, error: null }
      queueMicrotask(() => {
        let entry = dbs.get(name)
        const isNew = !entry
        if (!entry) {
          entry = { stores: new Map(), version: version ?? 1 }
          dbs.set(name, entry)
        }
        ;(req as unknown as { result: unknown }).result = {
          objectStoreNames: { contains: (n: string) => entry!.stores.has(n) },
          createObjectStore: (storeName: string) => {
            const m = new Map<string, unknown>()
            entry!.stores.set(storeName, m)
            return makeStore(m, () => {})
          },
          transaction: (storeName: string) => {
            let storeMap = entry!.stores.get(storeName)
            if (!storeMap) {
              storeMap = new Map<string, unknown>()
              entry!.stores.set(storeName, storeMap)
            }
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null } as unknown as IDBTransaction
            let completeScheduled = false
            const scheduleTxComplete = () => {
              if (completeScheduled) return
              completeScheduled = true
              queueMicrotask(() => {
                ;(tx as unknown as { oncomplete: ((ev: Event) => void) | null }).oncomplete?.(new Event('complete'))
              })
            }
            ;(tx as unknown as { objectStore: () => IDBObjectStore }).objectStore = () =>
              makeStore(storeMap!, scheduleTxComplete)
            return tx
          },
          close: () => {},
        }
        if (isNew) {
          ;(req as unknown as { onupgradeneeded: ((ev: Event) => void) | null }).onupgradeneeded?.(new Event('upgrade'))
        }
        ;(req as unknown as { onsuccess: ((ev: Event) => void) | null }).onsuccess?.(new Event('success'))
      })
      return req as unknown as IDBOpenDBRequest
    },
    deleteDatabase(name: string) {
      const req = { onsuccess: null, onerror: null, onblocked: null }
      queueMicrotask(() => {
        dbs.delete(name)
        ;(req as unknown as { onsuccess: ((ev: Event) => void) | null }).onsuccess?.(new Event('success'))
      })
      return req as unknown as IDBOpenDBRequest
    },
    databases: () => Promise.resolve([]),
  }
  return factory as unknown as IDBFactory
}

const CANVAS = 'mivo-canvas-demo'
const CHAT = 'mivo-chat-demo'

beforeEach(async () => {
  resetUserId()
  await __resetIdbPersist()
  vi.stubGlobal('indexedDB', makeInMemoryIdb())
  vi.stubGlobal('localStorage', memStorage())
  vi.stubGlobal('sessionStorage', memStorage())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  resetUserId()
  await __resetIdbPersist()
})

describe('FX-6: adapter namespace routing', () => {
  it('anonymous namespace uses the RAW legacy key (no :anonymous suffix)', async () => {
    await idbStateStorage.setItem(CANVAS, 'anon-data')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('anon-data')
    // The data lives under the raw key, NOT under mivo-canvas-demo:anonymous —
    // prove it by authenticating: the first user's getItem migrates (claims) the
    // raw key into their namespace. If anonymous had used a :anonymous suffixed
    // key, A would see nothing here.
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('anon-data')
  })

  it('authenticated namespace reads/writes mivo-*:<userId> (raw key untouched)', async () => {
    setPersistUserId('userA')
    await idbStateStorage.setItem(CANVAS, 'A-data')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('A-data')
    // anonymous (raw) key is empty — A's data lives only under :userA
    setPersistUserId('anonymous')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
  })
})

describe('FX-6: two users are isolated', () => {
  it('A and B read disjoint canvas + chat keys', async () => {
    setPersistUserId('userA')
    await idbStateStorage.setItem(CANVAS, 'A-canvas')
    await idbStateStorage.setItem(CHAT, 'A-chat')
    setPersistUserId('userB')
    await idbStateStorage.setItem(CANVAS, 'B-canvas')

    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('A-canvas')
    expect(await idbStateStorage.getItem(CHAT)).toBe('A-chat')
    setPersistUserId('userB')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('B-canvas')
    // B has no chat (A's chat is in A's namespace)
    expect(await idbStateStorage.getItem(CHAT)).toBeNull()
    // A has no B-canvas
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('A-canvas')
  })
})

describe('FX-6: legacy → namespaced migration (one-time, data-loss prevention)', () => {
  it('first authenticated getItem migrates the raw legacy key into the user namespace', async () => {
    // Seed legacy raw key as the anonymous namespace (pre-FX-6 data on disk).
    await idbStateStorage.setItem(CANVAS, 'legacy-canvas')
    // Authenticate as A — getItem must migrate anonymous raw → A's namespaced key.
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('legacy-canvas')
    // The anonymous (raw) key is now empty — the data moved to A's namespace.
    setPersistUserId('anonymous')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
    // A still owns the migrated data.
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('legacy-canvas')
  })

  it('migration is idempotent — second getItem does not re-copy or overwrite', async () => {
    await idbStateStorage.setItem(CANVAS, 'legacy')
    setPersistUserId('userA')
    await idbStateStorage.getItem(CANVAS) // triggers migration
    // A writes new data AFTER migration — must not be clobbered by a re-migration.
    await idbStateStorage.setItem(CANVAS, 'A-new')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('A-new')
    // anonymous raw still empty (no re-copy back)
    setPersistUserId('anonymous')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
  })

  it('migration does NOT overwrite when the user already has namespaced data', async () => {
    setPersistUserId('userA')
    await idbStateStorage.setItem(CANVAS, 'A-existing')
    // A stale legacy raw key appears (e.g. another tab never migrated).
    setPersistUserId('anonymous')
    await idbStateStorage.setItem(CANVAS, 'stale-legacy')
    // A's existing namespaced data must win — migration skips when namespaced exists.
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('A-existing')
  })

  it('migration only runs for authenticated users — anonymous keeps the raw key', async () => {
    await idbStateStorage.setItem(CANVAS, 'anon-data')
    // repeated anonymous getItems do not migrate or create a :anonymous key —
    // the raw key stays the source of truth for the anonymous namespace.
    expect(await idbStateStorage.getItem(CANVAS)).toBe('anon-data')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('anon-data')
    // A claims the raw key on first authenticated getItem — proves it stayed raw
    // and was never moved to a :anonymous suffixed key (which A could not claim).
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('anon-data')
  })

  it('the first authenticated user claims the legacy data; a later user does not', async () => {
    await idbStateStorage.setItem(CANVAS, 'legacy')
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('legacy') // A claims it
    // B logs in on the same device later — the legacy data already belongs to A.
    setPersistUserId('userB')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('legacy')
  })
})

describe('FX-6: clearCurrentUserCache — logout clears only the current namespace', () => {
  it('clears A\'s canvas + chat without touching B', async () => {
    setPersistUserId('userA')
    await idbStateStorage.setItem(CANVAS, 'A-canvas')
    await idbStateStorage.setItem(CHAT, 'A-chat')
    setPersistUserId('userB')
    await idbStateStorage.setItem(CANVAS, 'B-canvas')
    await idbStateStorage.setItem(CHAT, 'B-chat')

    // Simulate A's logout: namespace must be A, then clear.
    setPersistUserId('userA')
    await clearCurrentUserCache()

    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
    expect(await idbStateStorage.getItem(CHAT)).toBeNull()
    setPersistUserId('userB')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('B-canvas')
    expect(await idbStateStorage.getItem(CHAT)).toBe('B-chat')
  })

  it('anonymous namespace is never cleared (no anonymous logout; shared key protected)', async () => {
    await idbStateStorage.setItem(CANVAS, 'anon-data')
    await clearCurrentUserCache()
    expect(await idbStateStorage.getItem(CANVAS)).toBe('anon-data')
  })
})

describe('FX-6 acceptance: A logout → B login, mutually invisible', () => {
  it('after A logs out and B logs in, B sees none of A\'s canvas/chat (and vice versa)', async () => {
    // A is logged in, has data.
    setPersistUserId('userA')
    await idbStateStorage.setItem(CANVAS, 'A-canvas')
    await idbStateStorage.setItem(CHAT, 'A-chat')

    // A logs out: clear A's cache namespace.
    await clearCurrentUserCache()

    // B logs in.
    setPersistUserId('userB')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
    expect(await idbStateStorage.getItem(CHAT)).toBeNull()

    // B writes their own.
    await idbStateStorage.setItem(CANVAS, 'B-canvas')

    // A logs back in: sees none of B's data (A's was cleared; B's is in B's namespace).
    setPersistUserId('userA')
    expect(await idbStateStorage.getItem(CANVAS)).toBeNull()
    setPersistUserId('userB')
    expect(await idbStateStorage.getItem(CANVAS)).toBe('B-canvas')
  })
})
