import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetIdbPersist,
  idbStateStorage,
} from './persistIdbStorage'

// In-memory localStorage + sessionStorage stubs (node vitest has no DOM globals).
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

// Minimal in-memory IDB mock covering the adapter's touch points:
// open(name, version) → onupgradeneeded / onsuccess / result = IDBDatabase
// db.transaction(store, mode) → IDBTransaction with objectStore()
// store.get/put/delete → IDBRequest with onsuccess/onerror/result/error
// tx.oncomplete / onerror / onabort
//
// Not spec-compliant — just enough surface for persistIdbStorage's three
// operations. Lifecycle invariant the adapter relies on: a request's onsuccess
// fires BEFORE the transaction's oncomplete (real IDB settles requests within the
// tx, then completes). The mock enforces this by scheduling tx.oncomplete as a
// microtask queued from inside each request's settle handler.
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
        // After the request settles, schedule the transaction to complete (mirrors
        // real IDB: requests settle first, then tx.oncomplete fires).
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
        // In real IDB, request.result is available DURING onupgradeneeded — set it
        // before firing the upgrade handler so the adapter can read objectStoreNames.
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

const CANVAS_KEY = 'mivo-canvas-demo'
const CHAT_KEY = 'mivo-chat-demo'
const MIGRATED_CANVAS = 'mivo-persist-migrated:mivo-canvas-demo'
const MIGRATED_CHAT = 'mivo-persist-migrated:mivo-chat-demo'

beforeEach(async () => {
  await __resetIdbPersist()
  vi.stubGlobal('indexedDB', makeInMemoryIdb())
  vi.stubGlobal('localStorage', memStorage())
  vi.stubGlobal('sessionStorage', memStorage())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await __resetIdbPersist()
})

describe('idbStateStorage — round-trip', () => {
  it('setItem then getItem returns the same value', async () => {
    await idbStateStorage.setItem(CANVAS_KEY, '{"state":{"a":1}}')
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBe('{"state":{"a":1}}')
  })

  it('getItem returns null for a key that was never set', async () => {
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBeNull()
  })

  it('removeItem deletes a previously-set value', async () => {
    await idbStateStorage.setItem(CANVAS_KEY, 'v1')
    await idbStateStorage.removeItem(CANVAS_KEY)
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBeNull()
  })

  it('overwrite: setItem replaces the previous value (put upsert)', async () => {
    await idbStateStorage.setItem(CANVAS_KEY, 'v1')
    await idbStateStorage.setItem(CANVAS_KEY, 'v2')
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBe('v2')
  })

  it('two keys are independent (canvas + chat)', async () => {
    await idbStateStorage.setItem(CANVAS_KEY, 'canvas-state')
    await idbStateStorage.setItem(CHAT_KEY, 'chat-state')
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBe('canvas-state')
    expect(await idbStateStorage.getItem(CHAT_KEY)).toBe('chat-state')
  })
})

describe('idbStateStorage — migration localStorage → IDB', () => {
  it('migrates a legacy localStorage key to IDB on first getItem', async () => {
    localStorage.setItem(CANVAS_KEY, '{"state":{"legacy":true}}')
    const result = await idbStateStorage.getItem(CANVAS_KEY)
    expect(result).toBe('{"state":{"legacy":true}}')
    expect(localStorage.getItem(CANVAS_KEY)).toBeNull()
  })

  it('migration is idempotent — second getItem does not re-read localStorage', async () => {
    localStorage.setItem(CANVAS_KEY, 'legacy')
    await idbStateStorage.getItem(CANVAS_KEY)
    expect(localStorage.getItem(CANVAS_KEY)).toBeNull()
    expect(sessionStorage.getItem(MIGRATED_CANVAS)).not.toBeNull()
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBe('legacy')
  })

  it('no legacy key — getItem still marks migrated (skips localStorage next time)', async () => {
    expect(localStorage.getItem(CANVAS_KEY)).toBeNull()
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBeNull()
    expect(sessionStorage.getItem(MIGRATED_CANVAS)).not.toBeNull()
  })

  it('migration marker is per-key (canvas migrates independently of chat)', async () => {
    localStorage.setItem(CANVAS_KEY, 'c-legacy')
    await idbStateStorage.getItem(CANVAS_KEY)
    expect(sessionStorage.getItem(MIGRATED_CANVAS)).not.toBeNull()
    expect(sessionStorage.getItem(MIGRATED_CHAT)).toBeNull()
  })
})

describe('idbStateStorage — IDB unavailable degradation', () => {
  it('getItem falls back to localStorage when IndexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    localStorage.setItem(CANVAS_KEY, 'fallback')
    expect(await idbStateStorage.getItem(CANVAS_KEY)).toBe('fallback')
  })

  it('setItem writes to localStorage when IndexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await idbStateStorage.setItem(CANVAS_KEY, 'degraded-write')
    expect(localStorage.getItem(CANVAS_KEY)).toBe('degraded-write')
  })

  it('removeItem deletes from localStorage when IndexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    localStorage.setItem(CANVAS_KEY, 'x')
    await idbStateStorage.removeItem(CANVAS_KEY)
    expect(localStorage.getItem(CANVAS_KEY)).toBeNull()
  })
})

// A minimal IDB factory whose `put` rejects with QuotaExceededError. Verifies the
// adapter surfaces quota failures via debugLogger.error + toastFeedback instead of
// silently dropping the write.
const makeQuotaErrorIdb = (): IDBFactory => {
  const err = new DOMException('quota', 'QuotaExceededError')
  const store = {
    get: () => mkReq(undefined),
    put: () => mkReq(undefined, err),
    delete: () => mkReq(undefined),
  } as unknown as IDBObjectStore
  const mkReq = <T>(result: T, error: DOMException | null = null) => {
    const r = { onsuccess: null, onerror: null, result, error } as unknown as IDBRequest<T>
    queueMicrotask(() => {
      if (error) (r as unknown as { onerror: ((ev: Event) => void) | null }).onerror?.(new Event('error'))
      else (r as unknown as { onsuccess: ((ev: Event) => void) | null }).onsuccess?.(new Event('success'))
    })
    return r
  }
  const tx = {
    objectStore: () => store,
    oncomplete: null,
    onerror: null,
    onabort: null,
    error: err,
  } as unknown as IDBTransaction
  const db = {
    transaction: () => {
      queueMicrotask(() => {
        ;(tx as unknown as { onerror: ((ev: Event) => void) | null }).onerror?.(new Event('error'))
      })
      return tx
    },
    close: () => {},
  } as unknown as IDBDatabase
  const openReq = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db } as unknown as IDBOpenDBRequest
  queueMicrotask(() => {
    ;(openReq as unknown as { onsuccess: ((ev: Event) => void) | null }).onsuccess?.(new Event('success'))
  })
  return { open: () => openReq, deleteDatabase: () => openReq, databases: () => Promise.resolve([]) } as unknown as IDBFactory
}

describe('idbStateStorage — QuotaExceededError is not silent', () => {
  it('setItem surfaces quota error via toast + debug log and does not throw', async () => {
    const { debugLogger } = await import('../store/debugLogStore')
    const { toastFeedback } = await import('../store/toastStore')
    const errorSpy = vi.spyOn(debugLogger, 'error').mockImplementation(() => {})
    const toastSpy = vi.spyOn(toastFeedback, 'error').mockImplementation(() => '')

    vi.stubGlobal('indexedDB', makeQuotaErrorIdb())
    await idbStateStorage.setItem(CANVAS_KEY, 'big-payload')

    expect(errorSpy).toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('存储已满'))

    errorSpy.mockRestore()
    toastSpy.mockRestore()
  })
})
