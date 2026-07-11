import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// P3.10 — gate-off characterization. The assets gate (?assets=server /
// VITE_MIVO_ASSETS=server) is OFF by default (local IDB). This test PINS the
// local-path outputs + IDB side effects of save/resolve/read/serialize/restore so
// the T1.5 server-mode seam is PROVEN to be a zero-behavior-change addition: with
// the gate off, every local operation is byte-for-byte identical to pre-T1.5.
//
// fake-indexeddb supplies a real in-memory IndexedDB so the assetStorage IDB
// adapter is exercised end-to-end (not a hand-rolled mock — the actual put/get/
// cursor path runs against a faithful IDB implementation).

// Mock the gate module: isAssetsServerMode → false (gate off). Prefix helpers
// (isServerAssetUrl / serverAssetUrl / serverAssetId) stay REAL so the routing
// predicate is also characterized (a server URL would route to the server branch).
vi.mock('./assetServiceMode', async (importActual) => {
  const actual = await importActual<typeof import('./assetServiceMode')>()
  return { ...actual, isAssetsServerMode: vi.fn(() => false) }
})
// Mock the server IO module (dynamically imported only on a server-prefix path).
// fetchServerAssetBlob → null by default so a server-URL resolve returns '' without
// a real network call (the local path is never hit for server URLs — prefix routing).
vi.mock('./assetService', () => ({
  uploadAssetToServer: vi.fn(),
  fetchServerAssetBlob: vi.fn(async () => null),
}))
// Mock debugLogger (no remote-reporter side effects).
vi.mock('../store/debugLogStore', () => ({
  debugLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  saveImportedAsset,
  resolveAssetUrl,
  readImportedAssetFile,
  serializeImportedAsset,
  restoreSerializedAsset,
  isImportedAssetUrl,
  importedAssetUrl,
  type SerializedCanvasAsset,
} from './assetStorage'
import { isAssetsServerMode } from './assetServiceMode'
import { fetchServerAssetBlob } from './assetService'
import { __resetPersistUserId } from './persistUserId'

// Non-image file so prepareImportedImage returns the fallback (no
// createImageBitmap / canvas — those are browser-only and out of the storage-
// layer characterization scope). The storage/resolve/serialize/restore contract is
// type-agnostic; pinning it on a markdown file covers the IDB seam T1.5 touched.
const mdFile = (name = 'note.md', content = 'hello world') =>
  new File([content], name, { type: 'text/markdown' })

// node has no FileReader; blobToDataUrl uses it to embed bytes as a data: URL.
class FakeFileReader {
  result: string | ArrayBuffer | null = null
  error: unknown = null
  onload: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  async readAsDataURL(blob: Blob): Promise<void> {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`
      this.onload?.({})
    } catch (e) {
      this.error = e
      this.onerror?.({})
    }
  }
}

// dataUrlToBlob uses fetch(dataUrl). node's undici fetch supports data: URLs, but
// to keep the test hermetic + deterministic, stub fetch to decode the data URL
// (no node Buffer — btoa/atob/TextEncoder are browser-standard).
const dataUrlToBlobStub = (url: string): Response => {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(url) ?? []
  const [, type = 'application/octet-stream', b64, body = ''] = m
  const text = b64 ? atob(body) : decodeURIComponent(body)
  const bytes = new TextEncoder().encode(text)
  return new Response(bytes, { status: 200, headers: { 'content-type': type } })
}

describe('assetStorage — gate-off (local IDB) characterization (P3.10)', () => {
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>
  const realFetch = globalThis.fetch

  beforeEach(() => {
    vi.mocked(isAssetsServerMode).mockReturnValue(false) // gate OFF (default)
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(
      (obj) => `blob:${(obj as Blob).size}`,
    )
    vi.stubGlobal('FileReader', FakeFileReader)
    globalThis.fetch = ((url: string) => {
      if (typeof url === 'string' && url.startsWith('data:')) return Promise.resolve(dataUrlToBlobStub(url))
      return Promise.reject(new TypeError('unexpected fetch in gate-off test'))
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    createObjectURLSpy.mockRestore()
    vi.unstubAllGlobals()
    globalThis.fetch = realFetch
    __resetPersistUserId()
  })

  it('save → local IDB put; assetUrl = mivo-asset:<uuid>; gate stays off', async () => {
    const file = mdFile()
    const ref = await saveImportedAsset(file)
    expect(isAssetsServerMode()).toBe(false) // gate off → local
    expect(ref.assetUrl.startsWith('mivo-asset:')).toBe(true)
    expect(ref.name).toBe('note.md')
    expect(ref.type).toBe('text/markdown')
    expect(ref.sizeBytes).toBe(file.size)
    expect(ref.title).toBe('note')
  })

  it('resolve → reads the stored blob from IDB → createObjectURL', async () => {
    const content = 'payload'
    const file = mdFile('pic.md', content)
    const ref = await saveImportedAsset(file)
    const url = await resolveAssetUrl(ref.assetUrl)
    expect(url).toBe(`blob:${content.length}`) // blob:<size> per the spy
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
  })

  it('resolve → empty string for a missing asset (no createObjectURL)', async () => {
    const url = await resolveAssetUrl(importedAssetUrl('never-stored-uuid'))
    expect(url).toBe('')
    expect(createObjectURLSpy).not.toHaveBeenCalled()
  })

  it('readImportedAssetFile → { name, type, blob, createdAt } from IDB', async () => {
    const file = mdFile('doc.md', 'body-bytes')
    const ref = await saveImportedAsset(file)
    const read = await readImportedAssetFile(ref.assetUrl)
    expect(read?.name).toBe('doc.md')
    expect(read?.type).toBe('text/markdown')
    expect(read?.blob.size).toBe(file.size)
    expect(typeof read?.createdAt).toBe('number')
    expect(await read?.blob.text()).toBe('body-bytes')
  })

  it('serialize → self-contained dataUrl archive entry (bytes embedded from IDB)', async () => {
    const file = mdFile('arc.md', 'archive-me')
    const ref = await saveImportedAsset(file)
    const out = await serializeImportedAsset(ref.assetUrl)
    expect(out).toBeDefined()
    expect(out?.assetUrl).toBe(ref.assetUrl)
    expect(out?.name).toBe('arc.md')
    expect(out?.type).toBe('text/markdown')
    expect(out?.dataUrl.startsWith('data:text/markdown;base64,')).toBe(true)
    // round-trip the dataUrl back to bytes → matches the original content
    const resp = dataUrlToBlobStub(out!.dataUrl)
    expect(await resp.text()).toBe('archive-me')
  })

  it('restore → re-stores the bytes under the SAME id (idempotent local re-import)', async () => {
    const file = mdFile('rst.md', 'restore-me')
    const ref = await saveImportedAsset(file)
    const serialized: SerializedCanvasAsset = {
      assetUrl: ref.assetUrl,
      name: 'rst.md',
      type: 'text/markdown',
      dataUrl: 'data:text/markdown;base64,' + btoa('restore-me'),
      createdAt: 12345,
    }
    await restoreSerializedAsset(serialized)
    const read = await readImportedAssetFile(ref.assetUrl)
    expect(await read?.blob.text()).toBe('restore-me')
    expect(read?.name).toBe('rst.md')
    expect(read?.type).toBe('text/markdown')
  })

  it('a server-prefix assetUrl routes to the server branch (NOT local IDB) even with gate off', async () => {
    // Routing invariant: resolve/read route by PREFIX, not the current gate. A
    // mivo-sasset: URL must NOT hit local IDB even when the gate is off — proving
    // the local path is untouched for local URLs and only server URLs take the seam.
    const serverUrl = 'mivo-sasset:' + 'a'.repeat(64)
    expect(isImportedAssetUrl(serverUrl)).toBe(true)
    vi.mocked(fetchServerAssetBlob).mockResolvedValue(null) // server fetch → null → ''
    const url = await resolveAssetUrl(serverUrl)
    expect(url).toBe('') // server fetch returned null → empty (NOT an IDB lookup)
    expect(fetchServerAssetBlob).toHaveBeenCalledTimes(1) // routed to server, not IDB
    expect(createObjectURLSpy).not.toHaveBeenCalled() // no IDB → no blob URL
  })
})
