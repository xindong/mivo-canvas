import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SERVER_ASSET_PREFIX,
  serverAssetUrl,
  isServerAssetUrl,
  serverAssetId,
  resolveAssetsMode,
  isAssetsServerMode,
  uploadAssetToServer,
  fetchServerAssetBlob,
} from './assetService'

// Mock authHeaders (no settingsStore) + debugLogger (no remote reporter side effects).
// P2.8: fixture key carries the FAKEKEY marker (gitleaks allowlisted; real key shapes still scanned).
vi.mock('./authHeaders', () => ({ authHeaders: () => ({ 'X-Mivo-Api-Key': 'mivo_FAKEKEY_mk' }) }))
vi.mock('../store/debugLogStore', () => ({
  debugLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const jsonOk = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })

describe('assetService — prefix helpers', () => {
  it('serverAssetUrl / isServerAssetUrl / serverAssetId round-trip', () => {
    const id = 'a'.repeat(64)
    const url = serverAssetUrl(id)
    expect(url).toBe(`${SERVER_ASSET_PREFIX}${id}`)
    expect(isServerAssetUrl(url)).toBe(true)
    expect(isServerAssetUrl('mivo-asset:xyz')).toBe(false)
    expect(isServerAssetUrl(undefined)).toBe(false)
    expect(isServerAssetUrl('https://example.com/x.png')).toBe(false)
    expect(serverAssetId(url)).toBe(id)
  })
})

describe('assetService — gate (resolveAssetsMode / isAssetsServerMode)', () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  })

  it('default (no env, no URL) → local', () => {
    expect(resolveAssetsMode()).toBe('local')
    expect(isAssetsServerMode()).toBe(false)
  })

  it('VITE_MIVO_ASSETS=server env → server', () => {
    vi.stubEnv('VITE_MIVO_ASSETS', 'server')
    expect(resolveAssetsMode()).toBe('server')
    expect(isAssetsServerMode()).toBe(true)
  })

  it('VITE_MIVO_ASSETS=local env → local (explicit)', () => {
    vi.stubEnv('VITE_MIVO_ASSETS', 'local')
    expect(resolveAssetsMode()).toBe('local')
  })

  it('?assets=server URL param → server (no env)', () => {
    vi.stubGlobal('window', { location: { search: '?assets=server' } })
    expect(resolveAssetsMode()).toBe('server')
  })

  it('?assets=local URL param → local', () => {
    vi.stubGlobal('window', { location: { search: '?assets=local' } })
    expect(resolveAssetsMode()).toBe('local')
  })

  it('env wins over URL (CI force) — env=server, ?assets=local → server', () => {
    vi.stubEnv('VITE_MIVO_ASSETS', 'server')
    vi.stubGlobal('window', { location: { search: '?assets=local' } })
    expect(resolveAssetsMode()).toBe('server')
  })

  it('invalid env value falls through to URL / default', () => {
    vi.stubEnv('VITE_MIVO_ASSETS', 'wat')
    expect(resolveAssetsMode()).toBe('local')
  })
})

describe('assetService — uploadAssetToServer', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.unstubAllEnvs()
  })

  it('POSTs multipart with authHeaders; returns parsed upload result', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as FormData
      const file = body.get('image') as File
      expect(file).toBeInstanceOf(File)
      expect(file.name).toBe('a.png')
      expect(init.headers).toMatchObject({ 'X-Mivo-Api-Key': 'mivo_FAKEKEY_mk' })
      return jsonOk({
        assetId: 'a'.repeat(64),
        mimeType: 'image/png',
        originalName: 'a.png',
        sizeBytes: file.size,
        refcount: 1,
        deduped: false,
      })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    const blob = new Blob([bytes], { type: 'image/png' })
    const result = await uploadAssetToServer(blob, 'a.png', 'image/png')
    expect(result.assetId).toBe('a'.repeat(64))
    expect(result.deduped).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/assets')
  })

  it('non-2xx → throws (surfaces failure)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'bad' }), { status: 413 })) as unknown as typeof fetch
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/png' })
    await expect(uploadAssetToServer(blob, 'a.png', 'image/png')).rejects.toThrow(/413/)
  })
})

describe('assetService — fetchServerAssetBlob', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('200 → { blob, mimeType }', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    globalThis.fetch = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/api/assets/')
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    const result = await fetchServerAssetBlob('a'.repeat(64))
    expect(result?.mimeType).toBe('image/png')
    expect(result?.blob.size).toBe(bytes.byteLength)
  })

  it('404 → null (no warn, asset purged/missing)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    const result = await fetchServerAssetBlob('0'.repeat(64))
    expect(result).toBeNull()
  })

  it('500 → null + warn', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    const result = await fetchServerAssetBlob('0'.repeat(64))
    expect(result).toBeNull()
  })

  it('P2.7: network reject (fetch throws) → null, no unhandled rejection', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await fetchServerAssetBlob('0'.repeat(64))
    expect(result).toBeNull()
  })

  it('P2.7: AbortError preserved (re-thrown, not swallowed)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    globalThis.fetch = vi.fn(async () => {
      throw abort
    }) as unknown as typeof fetch
    await expect(fetchServerAssetBlob('0'.repeat(64))).rejects.toBe(abort)
  })
})
