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
import { ANONYMOUS_USER_ID, getPersistUserId, namespacedKey } from './persistUserId'
import { clearAssetsForUser } from './assetStorage'
import type { RawStorage } from '../kernel/persistMigration'

// FX-6 per-user cache namespacing. The canvas + chat persist NAMES stay static
// (`mivo-canvas-demo` / `mivo-chat-demo`) so the zustand persist contract and the
// characterization/contract tests that pin them are untouched; the adapter routes
// the physical IDB key through `namespacedKey(name)`, which appends `:<userId>` for
// an authenticated user and returns the raw name for the anonymous namespace
// (legacy compatibility — pre-auth and test sessions keep using the un-suffixed
// key they always used, so existing tests pass byte-for-byte). The settings
// store's `strictIdbStateStorage` (gatewayKey / mivoKey, DP-7) is deliberately NOT
// namespaced — those keys are device-local API keys that never enter
// /api/user-state and are shared across accounts on the same device by design.
const CANVAS_PERSIST_NAME = 'mivo-canvas-demo'
const CHAT_PERSIST_NAME = 'mivo-chat-demo'

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

const nsMigratedMarker = (name: string, uid: string) => `mivo-ns-migrated:${name}:${uid}`

/**
 * FX-6 one-shot legacy → namespaced migration. Pre-FX-6 sessions wrote the canvas
 * / chat state under the raw static name (no `:userId` suffix); once a user
 * authenticates their cache must live under `name:<userId>`. On the first
 * authenticated getItem, if the namespaced key is absent but the legacy raw key
 * exists in IDB, copy it across and delete the legacy key — preventing data loss.
 * Idempotent: the legacy key is deleted after a successful copy, so the next call
 * finds the namespaced key present and short-circuits. A per-(name, user)
 * sessionStorage marker skips the two extra IDB reads after the first boot per tab.
 *
 * Skipped entirely for the anonymous namespace — anonymous IS the raw key, so
 * there is nothing to migrate and no namespaced target to migrate into. This also
 * keeps the legacy/contract test paths (which never authenticate) on the raw key.
 */
const migrateToNamespaced = async (name: string): Promise<void> => {
  const uid = getPersistUserId()
  if (uid === ANONYMOUS_USER_ID) return
  if (typeof sessionStorage === 'undefined') return
  const marker = nsMigratedMarker(name, uid)
  if (sessionStorage.getItem(marker)) return

  const physical = namespacedKey(name)
  try {
    const existing = await runTransaction<KvRecord | undefined>('readonly', (store) =>
      store.get(physical) as IDBRequest<KvRecord | undefined>,
    )
    if (existing) {
      // Namespaced key already has data — nothing to migrate. Mark and done.
      sessionStorage.setItem(marker, '1')
      return
    }
    const legacy = await runTransaction<KvRecord | undefined>('readonly', (store) =>
      store.get(name) as IDBRequest<KvRecord | undefined>,
    )
    if (legacy) {
      await runTransaction('readwrite', (store) =>
        store.put({ key: physical, value: legacy.value } as unknown as KvRecord),
      )
      await runTransaction('readwrite', (store) => store.delete(name))
      debugLogger.log(
        SOURCE,
        `migrated legacy cache key ${name} → ${physical} for user ${uid} (one-time)`,
      )
    }
    // Whether we copied or found nothing, the legacy key is now either moved or
    // absent — mark so subsequent getItems skip the two extra reads this boot.
    sessionStorage.setItem(marker, '1')
  } catch (error) {
    // Marker NOT set → next boot retries. Never silently lose the chance to migrate.
    debugLogger.warn(SOURCE, `namespace migration failed for ${name}: ${errMessage(error)}`)
  }
}

const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === 'QuotaExceededError' || error.name === 'QuotaExceeded')

// G1-a seam:服务端持久化接线点。**有意保持空实现**——整 blob 推服务端的 P4c 旧设计已被
// G1-a 的"按 record 增量写"路径取代:非画布域(project/canvas-meta/user-state/asset)的增量写
// 经 ServerPersistAdapter(createFetchServerPersistAdapter)→ BFF → PG,网络失败重试经
// writeRetryQueue(persistWriteExecutor),hydrate 经 adapter 读方法 + serverPersistHydrate。
// 这些 per-record 路径才是 G1-a 的真实接线,不是这里的整 zustand-persist blob 同步。
//
// 保留空实现的理由:① zustand persist setItem 拿到的是整序列化 blob,做"增量"需要 store 层
// diff(非本存储层职责);② 画布域写(node/edge/anchor)挂 G1-c/N2-0,server 模式下画布 blob
// 暂无服务端可同步目标;③ **默认 mode=local → 生产零变化**:空实现保证 local 模式绝不发
// 网络请求。server/shadow 模式的真实增量写走 adapter + queue,不经此 blob 路径。
//
// setItem 内的 `// P4c: fire-and-forget server sync` 注释(下方 setItem)仅指未来 shadow 模式
// 的整 blob 双写比对,当前不启用;G1-a 真实写路径见 src/lib/serverPersistAdapter.ts。
export const syncToServer = async (): Promise<void> => {
  // G1-a:有意空实现(见上注释)。整 blob 同步被 per-record adapter 路径取代;
  // local 模式(默认)绝不发网络请求 → 生产零变化。
}

/**
 * zustand persist StateStorage backed by IndexedDB. Pass to
 * `createJSONStorage(() => idbStateStorage)` in FU4-2.
 */
export const idbStateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isIdbAvailable()) {
      debugLogger.warn(SOURCE, 'IndexedDB unavailable; falling back to localStorage')
      return typeof localStorage !== 'undefined' ? localStorage.getItem(namespacedKey(name)) : null
    }
    try {
      await migrateFromLocalStorage(name)
      await migrateToNamespaced(name)
      const record = await runTransaction<KvRecord | undefined>('readonly', (store) =>
        store.get(namespacedKey(name)) as IDBRequest<KvRecord | undefined>,
      )
      return record?.value ?? null
    } catch (error) {
      debugLogger.warn(
        SOURCE,
        `getItem failed for ${name}; falling back to localStorage: ${errMessage(error)}`,
      )
      return typeof localStorage !== 'undefined' ? localStorage.getItem(namespacedKey(name)) : null
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    // Bench opt-out: the bench measures render perf, not persistence. Setting
    // __MIVO_BENCH_PERSIST_SKIP__ makes setItem a no-op so 50k-node fixtures don't
    // serialize+put on every replaceSnapshot (the old localStorage shim no-ops
    // localStorage.setItem, which no longer intercepts this IDB-backed write).
    if (
      typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { __MIVO_BENCH_PERSIST_SKIP__?: boolean }).__MIVO_BENCH_PERSIST_SKIP__
    ) {
      return
    }
    if (!isIdbAvailable()) {
      debugLogger.warn(SOURCE, 'IndexedDB unavailable; writing to localStorage')
      if (typeof localStorage !== 'undefined') localStorage.setItem(namespacedKey(name), value)
      return
    }
    try {
      await runTransaction('readwrite', (store) =>
        store.put({ key: namespacedKey(name), value } as unknown as KvRecord),
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
      if (typeof localStorage !== 'undefined') localStorage.removeItem(namespacedKey(name))
      return
    }
    try {
      await runTransaction('readwrite', (store) => store.delete(namespacedKey(name)))
    } catch (error) {
      debugLogger.warn(SOURCE, `removeItem failed for ${name}: ${errMessage(error)}`)
    }
  },
}

/**
 * rawIdbStorage:raw IDB StateStorage(无 FX-6 namespacedKey)——S6 切主给
 * migrateV10ToV11/dryRun/rollback 用(它们内部走 namespacedKey 拼 document/session/ckpt
 * key;传 idbStateStorage namespaced adapter 会 double-namespace,Greptile 义务 1)。
 * 复用 runTransaction + localStorage fallback(同 idbStateStorage 但 key 不经 namespacedKey)。
 *
 * cast as RawStorage 集中在此导出点(Lead 裁决 ③:别散落)——调用方(S6b useStoreHydration)
 * 直接传 rawIdbStorage(已是 RawStorage 类型),无需再 cast;RawStorage brand 类型层拦 namespaced adapter。
 *
 * 命名 rawIdbStorage(直白,含 IDB;不复用 strictIdbStateStorage——后者是 DP-7 两把 key 专用
 * 语义边界,混用会让"哪些 key 永不进 user-state"审计线变糊)。
 */
export const rawIdbStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isIdbAvailable()) {
      debugLogger.warn(SOURCE, 'IndexedDB unavailable; raw storage falling back to localStorage')
      return typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null
    }
    try {
      const record = await runTransaction<KvRecord | undefined>('readonly', (store) =>
        store.get(name) as IDBRequest<KvRecord | undefined>,
      )
      return record?.value ?? null
    } catch (error) {
      debugLogger.warn(SOURCE, `raw getItem failed for ${name}: ${errMessage(error)}`)
      return typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    if (
      typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { __MIVO_BENCH_PERSIST_SKIP__?: boolean }).__MIVO_BENCH_PERSIST_SKIP__
    ) {
      return
    }
    if (!isIdbAvailable()) {
      // IDB 不可用 → localStorage fallback(失败 propagate throw;成功 return)。migrate 在极端
      // 环境回退 localStorage,getItem 也走 localStorage fallback,读写一致(非假成功)。
      debugLogger.warn(SOURCE, 'IndexedDB unavailable; raw storage writing to localStorage')
      if (typeof localStorage !== 'undefined') localStorage.setItem(name, value)
      return
    }
    try {
      await runTransaction('readwrite', (store) =>
        store.put({ key: name, value } as unknown as KvRecord),
      )
    } catch (error) {
      // Lead ①(S6b wiring 义务):setItem 失败必须 throw(quota/非 quota),不 swallow。
      // migrateV10ToV11 依赖 setItem 抛错触发 rollbackFromV11;swallow 会让迁移假成功不落盘。
      // (rollback 仪式实测见 persistMigration.test "migrate 失败→rollback")
      if (isQuotaError(error)) {
        debugLogger.error(SOURCE, `quota exceeded writing raw ${name}; state not persisted`)
        toastFeedback.error('存储已满，无法保存画布。')
      } else {
        debugLogger.warn(SOURCE, `raw setItem failed for ${name}: ${errMessage(error)}`)
      }
      throw error
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
      debugLogger.warn(SOURCE, `raw removeItem failed for ${name}: ${errMessage(error)}`)
    }
  },
} as unknown as RawStorage

/**
 * FX-6 clear the CURRENT user's cache namespace — called by authSlice.logout
 * BEFORE the optimistic state clear + SSO redirect (the redirect unloads the
 * page, so any IDB work queued after it would never land). Clears the canvas +
 * chat namespaced keys for the user being logged out and the asset blobs tagged
 * for them; it never touches another user's namespace (the physical keys are
 * per-user). The anonymous namespace is never cleared here — there is no
 * "anonymous logout", and clearing the shared raw key would nuke data other
 * tabs / the next anonymous session might still read. Node-test-safe: when IDB
 * is unavailable every step degrades to a no-op (removeItem no-ops, the asset
 * clear returns early), so the auth characterization tests that run without an
 * IDB global don't throw or emit unexpected toasts.
 */
export const clearCurrentUserCache = async (): Promise<void> => {
  const uid = getPersistUserId()
  if (uid === ANONYMOUS_USER_ID) return
  try {
    await idbStateStorage.removeItem(CANVAS_PERSIST_NAME)
    await idbStateStorage.removeItem(CHAT_PERSIST_NAME)
    debugLogger.log(SOURCE, `cleared cache namespace for user ${uid} on logout`)
  } catch (error) {
    // Never let a cache-clear failure block logout — the SSO redirect still runs,
    // and the next login re-hydrates from a possibly-stale namespace (acceptable;
    // the user-initiated logout still cleared the in-memory auth state).
    debugLogger.warn(SOURCE, `cache clear failed for user ${uid}: ${errMessage(error)}`)
  }
  try {
    await clearAssetsForUser(uid)
  } catch (error) {
    debugLogger.warn(SOURCE, `asset clear failed for user ${uid}: ${errMessage(error)}`)
  }
}

/**
 * Strict IDB-only StateStorage for SECRETS (B1: the two API keys must NEVER touch
 * localStorage — it is less protected than IDB and survives neither tab close nor
 * "clear recent history" the way an encrypted OS keychain would). Unlike
 * idbStateStorage, this NEVER falls back to localStorage: if IDB is unavailable or
 * a write fails, the value stays in-memory only (survives the session, not a
 * reload) and the user is told via toast so they can re-enter the key. Reads skip
 * the legacy localStorage migration — a brand-new secret store has no legacy key
 * to migrate, and we don't want to read a possibly-stale localStorage blob when
 * IDB is the only authority. canvasStore keeps its own canvas-friendly fallback
 * path via idbStateStorage; this strict variant is opt-in for secret stores only.
 */
export const strictIdbStateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isIdbAvailable()) {
      debugLogger.error(SOURCE, `IDB unavailable; cannot load ${name} (no localStorage fallback for secrets)`)
      return null
    }
    try {
      const record = await runTransaction<KvRecord | undefined>('readonly', (store) =>
        store.get(name) as IDBRequest<KvRecord | undefined>,
      )
      return record?.value ?? null
    } catch (error) {
      debugLogger.error(SOURCE, `getItem failed for ${name} (no fallback): ${errMessage(error)}`)
      return null
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    if (
      typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { __MIVO_BENCH_PERSIST_SKIP__?: boolean }).__MIVO_BENCH_PERSIST_SKIP__
    ) {
      return
    }
    if (!isIdbAvailable()) {
      debugLogger.error(SOURCE, `IDB unavailable; ${name} not persisted (will not survive reload)`)
      toastFeedback.error('浏览器存储不可用，Key 未持久化。请检查隐私模式或浏览器存储设置。')
      return
    }
    try {
      await runTransaction('readwrite', (store) =>
        store.put({ key: name, value } as unknown as KvRecord),
      )
    } catch (error) {
      if (isQuotaError(error)) {
        debugLogger.error(SOURCE, `quota exceeded writing ${name}; secret not persisted`)
        toastFeedback.error('存储已满，Key 未保存。请清理浏览器存储后重试。')
        return
      }
      debugLogger.error(SOURCE, `setItem failed for ${name} (no fallback): ${errMessage(error)}`)
      toastFeedback.error('Key 持久化失败，请重试。')
    }
  },

  removeItem: async (name: string): Promise<void> => {
    // No localStorage fallback path ever wrote anything, so when IDB is down there
    // is nothing to delete. Just log + no-op.
    if (!isIdbAvailable()) return
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
