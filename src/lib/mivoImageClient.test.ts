import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebugLogStore } from '../store/debugLogStore'
import { useSettingsStore } from '../store/settingsSlice'
import {
  editMivoImage,
  enhanceMivoPrompt,
  formatMivoClientError,
  generateMivoImage,
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

// FX-1: 同步生图链路 (/api/mivo/generate + /api/mivo/edit) 必须与异步 tasks 链路
// (mivoTaskClient) 及 enhance 一样透传 authHeaders()，否则带认证态的请求会落到
// BFF env-key 兜底而非 per-key 上下文。带/不带认证态两分支均覆盖。
describe('generateMivoImage / editMivoImage — authHeaders 透传 (FX-1)', () => {
  type FetchMock = ReturnType<typeof vi.fn>
  // response-like stub 避开 jsdom/undici Response 构造差异，只暴露 ok/status/json。
  const mockResponse = (ok: boolean, status: number, body: unknown): Response =>
    ({ ok, status, json: async () => body } as unknown as Response)
  const initOf = (m: FetchMock): RequestInit => m.mock.calls[0][1] as RequestInit
  const headersOf = (m: FetchMock): Record<string, string> =>
    (initOf(m).headers ?? {}) as Record<string, string>

  beforeEach(() => {
    useDebugLogStore.getState().clear()
    // 重置为无认证态，避免其他用例 setState 的 key 泄漏进来。
    useSettingsStore.setState({ mivoKey: '', gatewayKey: '' })
    // vitest 默认 node 环境无 window；fetchMivoWithTimeout 用 window.setTimeout/
    // clearTimeout。stub window = globalThis 让它们落到 node 的 setTimeout/clearTimeout。
    if (!globalThis.window) vi.stubGlobal('window', globalThis)
  })
  afterEach(() => {
    useSettingsStore.setState({ mivoKey: '', gatewayKey: '' })
    vi.unstubAllGlobals()
  })

  it('generateMivoImage: 无认证态 → 仅 Content-Type，不带 X-Mivo/X-Gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, { images: [{ b64: 'abc' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateMivoImage({ prompt: 'a cat' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const headers = headersOf(fetchMock)
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Mivo-Api-Key']).toBeUndefined()
    expect(headers['X-Gateway-Key']).toBeUndefined()
  })

  it('generateMivoImage: 带认证态 → 附带 X-Mivo-Api-Key + X-Gateway-Key', async () => {
    useSettingsStore.setState({ mivoKey: 'mk_test', gatewayKey: 'gk_test' })
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, { images: [{ b64: 'abc' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateMivoImage({ prompt: 'a cat' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const headers = headersOf(fetchMock)
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Mivo-Api-Key']).toBe('mk_test')
    expect(headers['X-Gateway-Key']).toBe('gk_test')
  })

  it('editMivoImage: 无认证态 → FormData body，headers 空（无 auth 无 Content-Type）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, { images: [{ b64: 'abc' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await editMivoImage({ prompt: 'a cat', image: new Blob(['x'], { type: 'image/png' }) })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(initOf(fetchMock).body).toBeInstanceOf(FormData)
    const headers = headersOf(fetchMock)
    expect(headers['X-Mivo-Api-Key']).toBeUndefined()
    expect(headers['X-Gateway-Key']).toBeUndefined()
    // FormData 必须由浏览器自带 Content-Type boundary，客户端不能手设。
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('editMivoImage: 带认证态 → 附带 X-Mivo/X-Gateway，仍不设 Content-Type', async () => {
    useSettingsStore.setState({ mivoKey: 'mk_test', gatewayKey: 'gk_test' })
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200, { images: [{ b64: 'abc' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await editMivoImage({ prompt: 'a cat', image: new Blob(['x'], { type: 'image/png' }) })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(initOf(fetchMock).body).toBeInstanceOf(FormData)
    const headers = headersOf(fetchMock)
    expect(headers['X-Mivo-Api-Key']).toBe('mk_test')
    expect(headers['X-Gateway-Key']).toBe('gk_test')
    expect(headers['Content-Type']).toBeUndefined()
  })
})
