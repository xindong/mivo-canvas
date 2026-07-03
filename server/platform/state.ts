// server/platform/state.ts
// In-memory token + chatSession cache with single-flight + 401 authRetry.
// Ported verbatim from vite.config.ts L587-L675. Module-level state (single-instance)
// preserves single-flight semantics; P4 horizontal scaling needs a shared store.
import type { PlatformCtx } from '../lib/config'

let mivoPlatformToken: string | null = null
let mivoPlatformChatSessionId: string | null = null
let mivoPlatformTokenPromise: Promise<string> | null = null
let mivoPlatformChatSessionPromise: Promise<string> | null = null

// Test-only: clear in-memory cache between cases (no production caller).
export const resetPlatformState = (): void => {
  mivoPlatformToken = null
  mivoPlatformChatSessionId = null
  mivoPlatformTokenPromise = null
  mivoPlatformChatSessionPromise = null
}

export const sanitizePlatformError = (text: string): string =>
  String(text)
    .replace(/mivo_[A-Za-z0-9_-]+/g, 'mivo_***')
    .replace(/"(authorization|session|sub|token)":\s*"[^"]*"/gi, '"$1":"***"')
    .slice(0, 300)

export const mivoPlatformRefreshToken = async (ctx: PlatformCtx, signal?: AbortSignal): Promise<string> => {
  const res = await fetch(`${ctx.platformEndpoint}/api/v1/state/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '', sub: ctx.platformKey, name: '' }),
    signal,
  })
  if (!res.ok) throw new Error(`platform token ${res.status}`)
  const json = (await res.json()) as { session?: string }
  if (!json.session) throw new Error('platform token no session')
  mivoPlatformToken = json.session
  mivoPlatformChatSessionId = null
  mivoPlatformChatSessionPromise = null
  return json.session
}

export const mivoPlatformEnsureToken = async (ctx: PlatformCtx, signal?: AbortSignal): Promise<string> => {
  if (mivoPlatformToken) return mivoPlatformToken
  if (!mivoPlatformTokenPromise) {
    mivoPlatformTokenPromise = mivoPlatformRefreshToken(ctx, signal).finally(() => {
      mivoPlatformTokenPromise = null
    })
  }
  return mivoPlatformTokenPromise
}

export const mivoPlatformEnsureChatSession = async (ctx: PlatformCtx, signal?: AbortSignal): Promise<string> => {
  if (mivoPlatformChatSessionId) return mivoPlatformChatSessionId
  if (!mivoPlatformChatSessionPromise) {
    mivoPlatformChatSessionPromise = (async () => {
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
      mivoPlatformChatSessionId = id
      return id
    })().finally(() => {
      mivoPlatformChatSessionPromise = null
    })
  }
  return mivoPlatformChatSessionPromise
}

// Unified authRetry: 401 → single-flight refresh → retry ONCE; no llm-proxy fallback.
export const mivoPlatformFetch = async (
  url: string,
  init: RequestInit,
  ctx: PlatformCtx,
  signal?: AbortSignal,
): Promise<Response> => {
  let token = await mivoPlatformEnsureToken(ctx, signal)
  const authHeaders = { ...init.headers, Authorization: `Bearer ${token}` }
  let res = await fetch(url, { ...init, headers: authHeaders, signal })
  if (res.status === 401) {
    mivoPlatformToken = null
    mivoPlatformTokenPromise = null
    token = await mivoPlatformEnsureToken(ctx, signal)
    const retryHeaders = { ...init.headers, Authorization: `Bearer ${token}` }
    res = await fetch(url, { ...init, headers: retryHeaders, signal })
  }
  return res
}
