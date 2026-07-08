// server/routes/keys.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { keysRoute } from './keys'
import { rejectInvalidMivoApiKey } from '../lib/keys'

describe('POST /api/keys/test — gateway key probe', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const probe = (key: string) =>
    keysRoute.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })

  it('200 valid key → {success:true}', async () => {
    fetchSpy.mockResolvedValue(new Response('[]', { status: 200 }))
    const res = await probe('sk-validkey1234')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('401 → {success:false, error:"Key 无效，请检查"}', async () => {
    fetchSpy.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const res = await probe('sk-badkey1234')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: false, error: 'Key 无效，请检查' })
  })

  it('other HTTP → 服务异常 (HTTP N)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }))
    const res = await probe('sk-somekey1234')
    const body = (await res.json()) as { success: boolean; error?: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('服务异常 (HTTP 500)')
  })

  it('network throw → 网络连接失败', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'))
    const res = await probe('sk-somekey1234')
    const body = (await res.json()) as { success: boolean; error?: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('网络连接失败，请检查网络')
  })

  it('abort (timeout) → 网络连接失败 (catch covers AbortError)', async () => {
    fetchSpy.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const res = await probe('sk-somekey1234')
    const body = (await res.json()) as { success: boolean; error?: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('网络连接失败，请检查网络')
  })

  it('non sk- key → 400 format error (no upstream call)', async () => {
    const res = await probe('not-a-key')
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mivo_ key → 400 (wrong family, no upstream call)', async () => {
    const res = await probe('mivo_FAKEKEY_test')
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('bare sk- prefix (no content) → 400 format error (no upstream call)', async () => {
    const res = await probe('sk-')
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('invalid JSON body → 400', async () => {
    const res = await keysRoute.request('/test', {
      method: 'POST',
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('probe sends Authorization: Bearer <key> to the gateway models endpoint', async () => {
    fetchSpy.mockResolvedValue(new Response('[]', { status: 200 }))
    await probe('sk-secret1234')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://llm-proxy.tapsvc.com/v1/models')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer sk-secret1234' })
  })
})

// F4: validateMivoApiKeyHeader — reject malformed X-Mivo-Api-Key at the boundary.
// Missing/blank → ok (env fallback, review-probe contract). Present but malformed
// → 400 (no env fallback — an attacker must not pin another tenant's env key).
describe('validateMivoApiKeyHeader (F4)', () => {
  const app = new Hono()
  app.get('/p', (c) => {
    const bad = rejectInvalidMivoApiKey(c)
    if (bad) return bad
    return c.json({ ok: true })
  })

  it('missing header → ok (env fallback)', async () => {
    const res = await app.request('/p')
    expect(res.status).toBe(200)
  })

  it('blank header → ok (env fallback)', async () => {
    const res = await app.request('/p', { headers: { 'x-mivo-api-key': '   ' } })
    expect(res.status).toBe(200)
  })

  it('valid mivo_ key → ok', async () => {
    const res = await app.request('/p', { headers: { 'x-mivo-api-key': 'mivo_FAKEKEY_test' } })
    expect(res.status).toBe(200)
  })

  it('non-mivo prefix (sk-) → 400', async () => {
    const res = await app.request('/p', { headers: { 'x-mivo-api-key': 'sk-FAKEKEY-neg' } })
    expect(res.status).toBe(400)
  })

  it('weird chars → 400', async () => {
    const res = await app.request('/p', { headers: { 'x-mivo-api-key': 'mivo_abc!@#' } })
    expect(res.status).toBe(400)
  })

  it('overlong (>128) → 400', async () => {
    const res = await app.request('/p', {
      headers: { 'x-mivo-api-key': `mivo_${'a'.repeat(130)}` },
    })
    expect(res.status).toBe(400)
  })

  it('valid key with underscores/hyphens/digits → ok', async () => {
    const res = await app.request('/p', { headers: { 'x-mivo-api-key': 'mivo_FAKEKEY-1_def' } })
    expect(res.status).toBe(200)
  })
})
