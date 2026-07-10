// persistUserId — per-user namespace source for the cache layer (FX-6).
//
// The canvas/chat persist adapters (idbStateStorage) and the asset blob store
// (assetStorage) namespace their physical keys by the current auth user id so one
// account's cache is invisible to another (A logout → B login, mutually isolated).
// The "anonymous" namespace (no authenticated user) maps to the LEGACY raw key —
// no suffix — so:
//   - existing pre-auth / test-env sessions keep using the un-suffixed keys they
//     always used (the characterization + contract tests that seed
//     `mivo-canvas-demo` / `mivo-chat-demo` directly still pass byte-for-byte);
//   - the first authenticated user migrates the legacy raw key into their namespaced
//     key (one-time, data-loss prevention), claiming whatever anonymous data lived
//     on the device.
//
// This module imports nothing. It is the shared seam every cache layer
// (persistIdbStorage, assetStorage) and the auth slice read/write through. Keeping
// it dependency-free breaks what would otherwise be a lib↔store import cycle
// (authSlice → persistIdbStorage → assetStorage ↔ useAuthStore).

export const ANONYMOUS_USER_ID = 'anonymous'

let currentUserId: string = ANONYMOUS_USER_ID

/** Current cache-namespace user id. Defaults to 'anonymous' until authSlice.hydrate sets it. */
export const getPersistUserId = (): string => currentUserId

/**
 * Set the current cache-namespace user id. Called by authSlice on hydrate (after
 * /api/auth/me resolves the session) and on logout (after cache clearing). Empty
 * / null resets to 'anonymous'. Idempotent — a no-op when unchanged so re-hydrating
 * the same session does not trip the namespace-switch detector.
 */
export const setPersistUserId = (id: string | null | undefined): void => {
  const next = id && id.trim() ? id.trim() : ANONYMOUS_USER_ID
  if (next === currentUserId) return
  currentUserId = next
}

/**
 * Compose the physical storage key for a logical persist name. The anonymous
 * namespace returns the raw name (legacy compatibility); an authenticated
 * namespace appends `:<userId>`. Callers MUST route the result through — never
 * read/write the raw name once a user might be authenticated.
 */
export const namespacedKey = (name: string): string => {
  const uid = currentUserId
  return uid === ANONYMOUS_USER_ID ? name : `${name}:${uid}`
}

/** Test-only: reset to anonymous between unit tests. */
export const __resetPersistUserId = (): void => {
  currentUserId = ANONYMOUS_USER_ID
}
