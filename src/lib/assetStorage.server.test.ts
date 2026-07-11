import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// Mock the pure gate module (assetStorage statically imports isAssetsServerMode +
// prefix helpers from here) and the IO module (assetStorage dynamically imports
// uploadAssetToServer / fetchServerAssetBlob from here). Prefix helpers stay real.
vi.mock('./assetServiceMode', async (importActual) => {
  const actual = await importActual<typeof import('./assetServiceMode')>()
  return { ...actual, isAssetsServerMode: vi.fn(() => false) }
})
vi.mock('./assetService', async (importActual) => {
  const actual = await importActual<typeof import('./assetService')>()
  return { ...actual, uploadAssetToServer: vi.fn(), fetchServerAssetBlob: vi.fn() }
})
vi.mock('../store/debugLogStore', () => ({
  debugLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  isImportedAssetUrl,
  resolveAssetUrl,
  saveImportedAsset,
  serializeImportedAsset,
  restoreSerializedAsset,
  type SerializedCanvasAsset,
} from './assetStorage'
import { isAssetsServerMode, serverAssetUrl } from './assetServiceMode'
import { uploadAssetToServer, fetchServerAssetBlob } from './assetService'
import { __resetPersistUserId } from './persistUserId'

const SHA = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

describe('isImportedAssetUrl — accepts both prefixes', () => {
  it('mivo-asset: (IDB) and mivo-sasset: (server) both recognized', () => {
    expect(isImportedAssetUrl('mivo-asset:uuid-123')).toBe(true)
    expect(isImportedAssetUrl(`mivo-sasset:${SHA}`)).toBe(true)
    expect(isImportedAssetUrl('https://example.com/x.png')).toBe(false)
    expect(isImportedAssetUrl('')).toBe(false)
    expect(isImportedAssetUrl(undefined)).toBe(false)
  })
})

describe('resolveAssetUrl — prefix routing', () => {
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.mocked(fetchServerAssetBlob).mockReset()
    // URL.createObjectURL is browser-only; install a spy so the server resolve
    // path produces a stable blob: URL without a real DOM. (assetUrlLease.test.ts
    // relies on the same global being assignable.)
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => `blob:${(obj as Blob).size}`)
  })
  afterEach(() => {
    createObjectURLSpy.mockRestore()
  })

  it('mivo-sasset: → fetchServerAssetBlob + createObjectURL', async () => {
    vi.mocked(fetchServerAssetBlob).mockResolvedValue({ blob: new Blob([new Uint8Array([1, 2, 3])]), mimeType: 'image/png' })
    const url = await resolveAssetUrl(`mivo-sasset:${SHA}`)
    expect(fetchServerAssetBlob).toHaveBeenCalledWith(SHA)
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    expect(url).toBe('blob:3')
  })

  it('mivo-sasset: fetch miss (null) → empty string, no createObjectURL', async () => {
    vi.mocked(fetchServerAssetBlob).mockResolvedValue(null)
    const url = await resolveAssetUrl(`mivo-sasset:${SHA}`)
    expect(url).toBe('')
    expect(createObjectURLSpy).not.toHaveBeenCalled()
  })

  it('non-imported http url → pass-through (no fetch, no blob URL)', async () => {
    const url = await resolveAssetUrl('https://example.com/x.png')
    expect(url).toBe('https://example.com/x.png')
    expect(fetchServerAssetBlob).not.toHaveBeenCalled()
  })

  it('empty / undefined → empty string', async () => {
    expect(await resolveAssetUrl('')).toBe('')
    expect(await resolveAssetUrl(undefined)).toBe('')
  })
})

describe('saveImportedAsset — server-mode routing', () => {
  beforeEach(() => {
    vi.mocked(isAssetsServerMode).mockReset()
    vi.mocked(uploadAssetToServer).mockReset()
  })

  it('server mode on → uploadAssetToServer + mivo-sasset:<assetId> return shape', async () => {
    vi.mocked(isAssetsServerMode).mockReturnValue(true)
    vi.mocked(uploadAssetToServer).mockResolvedValue({
      assetId: SHA,
      mimeType: 'image/png',
      originalName: 'a.png',
      sizeBytes: 10,
      refcount: 1,
      deduped: false,
    })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    const file = new File([bytes], 'a.png', { type: 'image/png' })
    const ref = await saveImportedAsset(file)

    expect(uploadAssetToServer).toHaveBeenCalledTimes(1)
    // posted with the file bytes (Blob), original name, client-known type
    const [postedBlob, name, type] = vi.mocked(uploadAssetToServer).mock.calls[0]
    expect(postedBlob).toBeInstanceOf(Blob)
    expect(name).toBe('a.png')
    expect(type).toBe('image/png')
    // return shape preserved (canvasAssetImport relies on these fields)
    expect(ref.assetUrl).toBe(serverAssetUrl(SHA))
    expect(ref.name).toBe('a.png')
    expect(ref.type).toBe('image/png')
    expect(ref.sizeBytes).toBe(file.size)
    expect(ref.title).toBe('a')
  })
})

// Minimal FileReader stub (node has no FileReader). blobToDataUrl uses it to
// embed bytes as a data: URL for archive serialization. The result only needs to
// start with 'data:' for the assertions (restore checks startsWith('data:')).
class FakeFileReader {
  result: string | ArrayBuffer | null = null
  error: unknown = null
  onload: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  async readAsDataURL(blob: Blob): Promise<void> {
    try {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,QUFBQQ==`
      this.onload?.({})
    } catch (e) {
      this.error = e
      this.onerror?.({})
    }
  }
}

describe('serialize / restore — server-prefix routing', () => {
  beforeEach(() => {
    vi.mocked(fetchServerAssetBlob).mockReset()
    vi.mocked(uploadAssetToServer).mockReset()
    vi.stubGlobal('FileReader', FakeFileReader)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serialize mivo-sasset: → fetch + embed dataUrl (self-contained archive)', async () => {
    const blob = new Blob([new Uint8Array([0x42])], { type: 'image/png' })
    vi.mocked(fetchServerAssetBlob).mockResolvedValue({ blob, mimeType: 'image/png' })
    const out = await serializeImportedAsset(`mivo-sasset:${SHA}`)
    expect(fetchServerAssetBlob).toHaveBeenCalledWith(SHA)
    expect(out).toBeDefined()
    expect(out?.assetUrl).toBe(`mivo-sasset:${SHA}`)
    expect(out?.type).toBe('image/png')
    expect(out?.dataUrl.startsWith('data:')).toBe(true)
  })

  it('serialize mivo-sasset: fetch miss → undefined (omitted from archive, no broken entry)', async () => {
    vi.mocked(fetchServerAssetBlob).mockResolvedValue(null)
    const out = await serializeImportedAsset(`mivo-sasset:${SHA}`)
    expect(out).toBeUndefined()
  })

  it('restore mivo-sasset: → re-POST embedded bytes (no IDB write); idempotent dedup', async () => {
    vi.mocked(uploadAssetToServer).mockResolvedValue({
      assetId: SHA,
      mimeType: 'image/png',
      originalName: 'restored-asset',
      sizeBytes: 1,
      refcount: 1,
      deduped: true,
    })
    const asset: SerializedCanvasAsset = {
      assetUrl: `mivo-sasset:${SHA}`,
      name: 'a.png',
      type: 'image/png',
      // tiny valid data URL (1x1 transparent png-ish); only needs to start with data:
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }
    await restoreSerializedAsset(asset)
    expect(uploadAssetToServer).toHaveBeenCalledTimes(1)
    const [postedBlob, name, type] = vi.mocked(uploadAssetToServer).mock.calls[0]
    expect(postedBlob).toBeInstanceOf(Blob)
    expect(name).toBe('a.png')
    expect(type).toBe('image/png')
  })

  it('restore mivo-sasset: with non-data dataUrl → no-op (no upload)', async () => {
    const asset: SerializedCanvasAsset = {
      assetUrl: `mivo-sasset:${SHA}`,
      name: 'a.png',
      type: 'image/png',
      dataUrl: '',
    }
    await restoreSerializedAsset(asset)
    expect(uploadAssetToServer).not.toHaveBeenCalled()
  })

  it('restore mivo-sasset: upload failure → warn, no throw (archive import is best-effort)', async () => {
    vi.mocked(uploadAssetToServer).mockRejectedValue(new Error('server down'))
    const asset: SerializedCanvasAsset = {
      assetUrl: `mivo-sasset:${SHA}`,
      name: 'a.png',
      type: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }
    await expect(restoreSerializedAsset(asset)).resolves.toBeUndefined()
  })
})

// P2.7: in server mode, ONLY server-uploadable images (png/jpeg/webp/gif/avif) go to
// the server. Non-image kinds (markdown / PDF / video) and svg (image/* but server-
// rejected) stay on local IDB — T1.5's scope is vetted static images. This pins the
// routing so a non-image save in server mode never 415s against the server gate.
describe('saveImportedAsset — non-image in server mode stays on IDB (P2.7)', () => {
  beforeEach(() => {
    vi.mocked(isAssetsServerMode).mockReturnValue(true) // gate ON
    vi.mocked(uploadAssetToServer).mockReset()
  })
  afterEach(() => {
    __resetPersistUserId()
  })

  it.each([
    ['markdown', 'note.md', 'text/markdown'],
    ['pdf', 'doc.pdf', 'application/pdf'],
    ['video', 'clip.mp4', 'video/mp4'],
  ] as Array<[string, string, string]>)(
    'server mode on + %s → IDB (uploadAssetToServer NOT called; mivo-asset: url)',
    async (_kind, name, type) => {
      const file = new File(['payload-bytes'], name, { type })
      const ref = await saveImportedAsset(file)
      expect(uploadAssetToServer).not.toHaveBeenCalled()
      expect(ref.assetUrl.startsWith('mivo-asset:')).toBe(true) // IDB, not mivo-sasset:
      expect(ref.name).toBe(name)
      expect(ref.type).toBe(type)
    },
  )

  it('server mode on + svg (image/* but server-rejected) → IDB (P2.7)', async () => {
    const file = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })
    const ref = await saveImportedAsset(file)
    expect(uploadAssetToServer).not.toHaveBeenCalled()
    expect(ref.assetUrl.startsWith('mivo-asset:')).toBe(true)
  })

  it('server mode on + png (server-uploadable) → still server (regression guard)', async () => {
    // Sanity: the P2.7 gate must NOT divert a vetted static image off the server path.
    vi.mocked(uploadAssetToServer).mockResolvedValue({
      assetId: SHA,
      mimeType: 'image/png',
      originalName: 'a.png',
      sizeBytes: 10,
      refcount: 1,
      deduped: false,
    })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    const file = new File([bytes], 'a.png', { type: 'image/png' })
    const ref = await saveImportedAsset(file)
    expect(uploadAssetToServer).toHaveBeenCalledTimes(1)
    expect(ref.assetUrl).toBe(serverAssetUrl(SHA)) // mivo-sasset:
  })
})
