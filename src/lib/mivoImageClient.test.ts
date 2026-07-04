import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebugLogStore } from '../store/debugLogStore'
import {
  enhanceMivoPrompt,
  formatMivoClientError,
  mivoUpstreamSafetyFailureMessage,
  mivoUpstreamTemporaryFailureMessage,
} from './mivoImageClient'

describe('formatMivoClientError', () => {
  beforeEach(() => {
    useDebugLogStore.getState().clear()
  })

  it('wraps raw 5xx upstream failures and keeps the original error in debug logs', () => {
    const message = formatMivoClientError(502, 'java.nio.channels.ClosedChannelException', 'Test')
    expect(message).toBe(mivoUpstreamTemporaryFailureMessage)
    expect(useDebugLogStore.getState().entries[0]?.message).toContain('ClosedChannelException')
  })

  it('wraps safety-style 400 failures with a user-facing suggestion', () => {
    const message = formatMivoClientError(400, 'request blocked by safety policy', 'Test')
    expect(message).toBe(mivoUpstreamSafetyFailureMessage)
    expect(useDebugLogStore.getState().entries[0]?.message).toContain('safety policy')
  })
})

describe('enhanceMivoPrompt (W4 degraded reason classification)', () => {
  beforeEach(() => {
    useDebugLogStore.getState().clear()
    // vitest 默认 node 环境无 window；fetchMivoWithTimeout 用 window.setTimeout/
    // clearTimeout。stub window = globalThis 让它们落到 node 的 setTimeout/clearTimeout。
    if (!globalThis.window) vi.stubGlobal('window', globalThis)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // response-like stub 避开 jsdom/undici Response 构造差异，只暴露 ok/status/json。
  const mockResponse = (ok: boolean, status: number, body: unknown): Response =>
    ({ ok, status, json: async () => body } as unknown as Response)

  it('non-2xx → degradedReason:upstream-http', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(false, 500, {}))
    vi.stubGlobal('fetch', fetchMock)
    const result = await enhanceMivoPrompt({ prompt: 'a cat' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.enhanced).toBe(false)
    expect(result.degradedReason).toBe('upstream-http')
  })

  it('fetch throw (network/CORS TypeError) → degradedReason:upstream-network', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const result = await enhanceMivoPrompt({ prompt: 'a cat' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.enhanced).toBe(false)
    expect(result.degradedReason).toBe('upstream-network')
  })

  it('ok + degraded payload → 透传服务端 degradedReason (bad-json) + stage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, { enhanced: false, degradedReason: 'bad-json', stage: 'fallback' }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await enhanceMivoPrompt({ prompt: 'a cat' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.enhanced).toBe(false)
    expect(result.degradedReason).toBe('bad-json')
    expect(result.stage).toBe('fallback')
  })
})
