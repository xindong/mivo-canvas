// persistIdbStorage — IndexedDB-backed StateStorage for zustand persist (FU-4 / FU4-1).
//
// Replaces the default `createJSONStorage(() => window.localStorage)` for stores
// whose persisted state can exceed localStorage's ~5MB quota (canvas snapshot at
// 10k+ nodes). zustand v5 persist natively supports an async StateStorage
// (getItem returns Promise<string | null>), so hydration becomes async — the
// store接线 (skipHydration + App gate) lands in FU4-2. This module is pure
// infrastructure: no store imports it yet.
//
// Design: plans/leafer-designs/phase3a-asset-lease-metrics.md FU-4 §2.1/§2.4.
//
// Lifecycle:
// - Long-lived IDB connection (module-level dbPromise) — persist fires setItem on
//   every state commit, so per-call open (assetStorage's pattern) would amplify
//   overhead. The promise resets on failure so the next call reopens.
// - One-shot migration: on first getItem, if a legacy localStorage key exists it is
//   copied to IDB and the legacy key deleted. A sessionStorage marker makes it
//   idempotent per tab. Write failure keeps the legacy key (fallback) and skips the
//   marker so the next boot retries.
// - Degradation: if IDB is unavailable (private mode / old Safari / no `indexedDB`
//   global), every operation falls back to localStorage + a debugLogger.warn. A
//   QuotaExceededError on write is surfaced via debugLogger.error + toastFeedback
//   (logging invariant — never silently drop persisted state).

import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'

const DB_NAME = 'mivo-canvas-persist'
const DB_VERSION = 1
const STORE_NAME = 'kv'
const SOURCE = 'Persist IDB'

type KvRecord = { key: string; value: string }

let dbPromise: Promise<IDBDatabase> | undefined

/** Runtime check — private mode / old Safari may lack `indexedDB`. */
const isIdbAvailable = (): boolean =>
  typeof indexedDB !== 'undefined' && indexedDB !== null

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  // A failed open (blocked / version conflict) must not poison subsequent calls —
  // drop the cached promise so the next operation retries from scratch.
  dbPromise.catch(() => {
    dbPromise = undefined
  })
  return dbPromise
}

/**
 * Run a single-request transaction against the KV store. Writes resolve on
 * `tx.oncomplete` (not just request.onsuccess) so a transaction that aborts after
 * a successful put — e.g. quota exhaustion mid-commit — rejects instead of
 * returning a false success.
 */
const runTransaction = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const request = run(tx.objectStore(STORE_NAME))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
      }),
  )

const migratedMarker = (name: string) => `mivo-persist-migrated:${name}`

/**
 * One-shot localStorage → IDB migration. Lazy on first getItem. Idempotent via a
 * sessionStorage marker (per tab). Write failure keeps the legacy key and skips the
 * marker so the next boot retries.
 */
const migrateFromLocalStorage = async (name: string): Promise<void> => {
  if (typeof sessionStorage === 'undefined' || typeof localStorage === 'undefined') return
  if (sessionStorage.getItem(migratedMarker(name))) return

  const legacy = localStorage.getItem(name)
  if (legacy === null) {
    // No legacy key — nothing to migrate. Still mark so we don't re-check localStorage
    // on every getItem (localStorage reads aren't free at scale).
    sessionStorage.setItem(migratedMarker(name), '1')
    return
  }

  try {
    await runTransaction('readwrite', (store) =>
      store.put({ key: name, value: legacy } as unknown as KvRecord),
    )
    localStorage.removeItem(name)
  } catch (error) {
    debugLogger.warn(
      SOURCE,
      `migration write failed for ${name}; kept localStorage fallback: ${errMessage(error)}`,
    )
    return // marker NOT set → next boot retries
  }

  sessionStorage.setItem(migratedMarker(name), '1')
}

const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === 'QuotaExceededError' || error.name === 'QuotaExceeded')

// P4c 接线点（服务端持久化）：当前空实现。P4c 上线后改成
// `syncToServer(name, value)` —— 在 setItem 写 IDB 后把 (name, value) 推到服务端，
// IDB 退为离线缓存层（offline-first）。本 PR 不做服务端调用。
export const syncToServer = async (): Promise<void> => {
  // P4c: await fetch('/api/persist', { method: 'POST', body: value }) — fire-and-forget
  // from setItem's perspective, with a server-authoritative merge on rehydrate.
}

/**
 * zustand persist StateStorage backed by IndexedDB. Pass to
 * `createJSONStorage(() => idbStateStorage)` in FU4-2.
 */
export const idbStateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isIdbAvailable()) {
      debugLogger.warn(SOURCE, 'IndexedDB unavailable; falling back to localStorage')
      return typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null
    }
    try {
      await migrateFromLocalStorage(name)
      const record = await runTransaction<KvRecord | undefined>('readonly', (store) =>
        store.get(name) as IDBRequest<KvRecord | undefined>,
      )
      return record?.value ?? null
    } catch (error) {
      debugLogger.warn(
        SOURCE,
        `getItem failed for ${name}; falling back to localStorage: ${errMessage(error)}`,
      )
      return typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    if (!isIdbAvailable()) {
      debugLogger.warn(SOURCE, 'IndexedDB unavailable; writing to localStorage')
      if (typeof localStorage !== 'undefined') localStorage.setItem(name, value)
      return
    }
    try {
      await runTransaction('readwrite', (store) =>
        store.put({ key: name, value } as unknown as KvRecord),
      )
      // P4c: fire-and-forget server sync — void syncToServer(name, value)
    } catch (error) {
      if (isQuotaError(error)) {
        // Never silent — the user must know their canvas wasn't saved.
        debugLogger.error(SOURCE, `quota exceeded writing ${name}; state not persisted`)
        toastFeedback.error('存储已满，无法保存画布。建议导出后清理旧画布后重试。')
        return
      }
      debugLogger.warn(SOURCE, `setItem failed for ${name}: ${errMessage(error)}`)
    }
  },

  removeItem: async (name: string): Promise<void> => {
    if (!isIdbAvailable()) {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(name)
      return
    }
    try {
      await runTransaction('readwrite', (store) => store.delete(name))
    } catch (error) {
      debugLogger.warn(SOURCE, `removeItem failed for ${name}: ${errMessage(error)}`)
    }
  },
}

/**
 * Test-only: close the cached DB connection + delete the DB so the next call
 * reopens from scratch. Not for app code. Async because IDB close/delete are
 * async (a long-lived connection blocks `deleteDatabase` until closed).
 */
export const __resetIdbPersist = async (): Promise<void> => {
  const pending = dbPromise
  dbPromise = undefined
  if (pending) {
    try {
      const db = await pending
      db.close()
    } catch {
      // open failed — nothing to close
    }
  }
  if (!isIdbAvailable()) return
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
