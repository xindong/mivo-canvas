// server/platform/state.ts
// Per-key-fingerprint token + chatSession cache with single-flight + 401 authRetry.
//
// B1 (auth probe): keys live browser-side and the BFF is stateless/zero-DB, but
// different mivo_ keys MUST NOT share a platform session token. The pre-auth global
// singleton (one mivoPlatformToken for the whole process) would let user A's token
// leak into user B's request when they share a BFF process. Each PlatformCtx now
// gets its own bucket keyed by sha256(ctx.platformKey).slice(0,16); single-flight,
// 401 authRetry, and the reset test hook are all preserved per-bucket.
//
// Module-level Map state (single-instance) preserves single-flight semantics within
// a key; P4 horizontal scaling needs a shared store.
import { createHash } from 'node:crypto'
import type { PlatformCtx } from '../lib/config'
import { fetchUpstreamWithTimeout } from '../lib/upstream'

// V05: per-request timeout for every platform-channel fetch. Without this, a
// single hung request (token/submit/poll/signUrl/upload) blocks its caller
// indefinitely — the poll deadline is only checked between iterations, so a
// stalled fetch inside one iteration never yields control back. 30s is generous
// for any platform endpoint yet short enough that the poll loop's transient
// retry (V03) can treat a timeout as one consecutive failure and recover. The
// timeout error (UpstreamRequestTimeoutError) is a normal throw — not an
// AbortError — so V03's catch counts it; the caller's external signal is still
// honored (linkExternalSignal aborts the fetch on cancel).
const PLATFORM_FETCH_TIMEOUT_MS = 30_000

type PlatformBucket = {
  token: string | null
  chatSessionId: string | null
  tokenPromise: Promise<string> | null
  chatSessionPromise: Promise<string> | null
}

const buckets = new Map<string, PlatformBucket>()

// sha256 first 16 hex chars — enough collision resistance for per-key sharding
// without ever surfacing the raw key in memory snapshots / logs. Two distinct
// mivo_ keys map to two distinct fingerprints, so their session tokens never
// share a bucket.
export const fingerprintOf = (ctx: PlatformCtx): string =>
  createHash('sha256').update(ctx.platformKey).digest('hex').slice(0, 16)

const MAX_BUCKETS = 256

// An active bucket has an in-flight token or chat-session refresh. Eviction must
// skip these — dropping one would orphan its promise and force a second upstream
// fetch when the same key is requested again (the F4 REOPEN bug).
const isBucketActive = (bucket: PlatformBucket): boolean =>
  bucket.tokenPromise !== null || bucket.chatSessionPromise !== null

const getBucket = (ctx: PlatformCtx): PlatformBucket => {
  const fp = fingerprintOf(ctx)
  const existing = buckets.get(fp)
  if (existing) {
    // LRU refresh: delete + re-insert moves the entry to the tail of iteration
    // order (Map iterates in insertion order), so the least-recently-used key
    // sits at the head and is the one evicted when MAX_BUCKETS is exceeded.
    buckets.delete(fp)
    buckets.set(fp, existing)
    return existing
  }
  // Cap the bucket count: a shared BFF process must not grow memory without bound.
  // Evict the least-recently-used NON-active buckets until there is room for the
  // new bucket (size < MAX_BUCKETS) or only active buckets remain. Looping — not a
  // single eviction — is required so the count CONVERGES back to the cap after an
  // all-active spike: once those in-flight promises settle the buckets become
  // evictable, and a delete-1-add-1 miss would otherwise freeze the count at the
  // peak forever (persistent memory leak). If every remaining bucket is active
  // (≥ MAX_BUCKETS active), allow the count to exceed the cap temporarily — never
  // evict an in-flight bucket (that would orphan its refresh promise and double
  // upstream token calls).
  if (buckets.size >= MAX_BUCKETS) {
    for (const key of buckets.keys()) {
      if (buckets.size < MAX_BUCKETS) break
      const candidate = buckets.get(key)
      if (candidate && !isBucketActive(candidate)) {
        buckets.delete(key)
      }
    }
  }
  const bucket: PlatformBucket = { token: null, chatSessionId: null, tokenPromise: null, chatSessionPromise: null }
  buckets.set(fp, bucket)
  return bucket
}

// Test-only: how many buckets currently exist. Lets the LRU cap test assert the
// count never exceeds MAX_BUCKETS after a flood of distinct keys.
export const __bucketCountForTest = (): number => buckets.size

// Test-only: clear all in-memory cache between cases (no production caller).
export const resetPlatformState = (): void => {
  buckets.clear()
}

// Test-only: clear the bucket for one specific key. Used by per-key isolation
// tests so a case can start from a clean bucket without wiping other cases' state.
export const resetPlatformStateForKey = (ctx: PlatformCtx): void => {
  buckets.delete(fingerprintOf(ctx))
}

// Test-only: read the cached token for a key WITHOUT triggering a refresh. Lets
// tests assert "different keys don't share a token" without poking the upstream
// fetch a second time (which would just re-read the same bucket).
export const __getCachedTokenForTest = (ctx: PlatformCtx): string | null =>
  buckets.get(fingerprintOf(ctx))?.token ?? null

export const sanitizePlatformError = (text: string): string =>
  String(text)
    .replace(/mivo_[A-Za-z0-9_-]+/g, 'mivo_***')
    .replace(/"(authorization|session|sub|token)":\s*"[^"]*"/gi, '"$1":"***"')
    .slice(0, 300)

export const mivoPlatformRefreshToken = async (ctx: PlatformCtx, signal?: AbortSignal): Promise<string> => {
  const bucket = getBucket(ctx)
  const res = await fetchUpstreamWithTimeout(
    `${ctx.platformEndpoint}/api/v1/state/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '', sub: ctx.platformKey, name: '' }),
    },
    PLATFORM_FETCH_TIMEOUT_MS,
    signal,
  )
  if (!res.ok) throw new Error(`platform token ${res.status}`)
  const json = (await res.json()) as { session?: string }
  if (!json.session) throw new Error('platform token no session')
  bucket.token = json.session
  // A new platform token invalidates any cached chat session for this key.
  bucket.chatSessionId = null
  bucket.chatSessionPromise = null
  return json.session
}

export const mivoPlatformEnsureToken = async (ctx: PlatformCtx, signal?: AbortSignal): Promise<string> => {
  const bucket = getBucket(ctx)
  if (bucket.token) return bucket.token
  if (!bucket.tokenPromise) {
    bucket.tokenPromise = mivoPlatformRefreshToken(ctx, signal).finally(() => {
      bucket.tokenPromise = null
    })
  }
  return bucket.tokenPromise
}

export const mivoPlatformEnsureChatSession = async (ctx: PlatformCtx, signal?: AbortSignal): Promise<string> => {
  const bucket = getBucket(ctx)
  if (bucket.chatSessionId) return bucket.chatSessionId
  if (!bucket.chatSessionPromise) {
    bucket.chatSessionPromise = (async () => {
      // authRetry (401 → single-flight refresh → retry once) via mivoPlatformFetch,
      // uniform with submit/poll/signUrl/upload.
      const res = await mivoPlatformFetch(
        `${ctx.platformEndpoint}/api/v1/message/chat`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'freeform' }) },
        ctx,
        signal,
      )
      if (!res.ok) throw new Error(`platform chat ${res.status}`)
      const json = (await res.json()) as { object_id?: string; chatSessionId?: string }
      const id = json.object_id || json.chatSessionId
      if (!id) throw new Error('platform chat no id')
      bucket.chatSessionId = id
      return id
    })().finally(() => {
      bucket.chatSessionPromise = null
    })
  }
  return bucket.chatSessionPromise
}

// Unified authRetry: 401 → single-flight refresh → retry ONCE; no llm-proxy fallback.
export const mivoPlatformFetch = async (
  url: string,
  init: RequestInit,
  ctx: PlatformCtx,
  signal?: AbortSignal,
): Promise<Response> => {
  const bucket = getBucket(ctx)
  let token = await mivoPlatformEnsureToken(ctx, signal)
  const authHeaders = { ...init.headers, Authorization: `Bearer ${token}` }
  let res = await fetchUpstreamWithTimeout(url, { ...init, headers: authHeaders }, PLATFORM_FETCH_TIMEOUT_MS, signal)
  if (res.status === 401) {
    // Single-flight refresh on 401: two concurrent requests whose tokens both
    // expired must share ONE refresh — not each kick off their own (the old
    // null+null-then-ensure pattern let two 401s fire two refreshes, tripling
    // upstream token calls). Guard the invalidation on the stale token VALUE: a
    // concurrent caller that already refreshed will have left a fresh token in
    // bucket.token; we must not clobber it. ??= reuses an in-flight refresh
    // promise; ensureToken then awaits that same promise instead of starting a
    // second one. Retry still happens exactly once per caller.
    const staleToken = token
    if (bucket.token === staleToken) {
      bucket.token = null
      bucket.tokenPromise ??= mivoPlatformRefreshToken(ctx, signal).finally(() => {
        bucket.tokenPromise = null
      })
    }
    token = await mivoPlatformEnsureToken(ctx, signal)
    const retryHeaders = { ...init.headers, Authorization: `Bearer ${token}` }
    res = await fetchUpstreamWithTimeout(url, { ...init, headers: retryHeaders }, PLATFORM_FETCH_TIMEOUT_MS, signal)
  }
  return res
}
