import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// readImportedAssetFile 走 IDB；单测走外链 fetch 路径，故 mock 为 undefined。
vi.mock('./assetStorage', () => ({
  readImportedAssetFile: vi.fn(async () => undefined),
}))

import { readCanvasImageBlob } from './canvasImageSource'

describe('readCanvasImageBlob (W3 代理回退 + 终败中文 + W1 非 result 不 flatten)', () => {
  beforeEach(() => {
    // vitest 默认 node 环境无 window/document；非 result kind 不碰 canvas，无需 stub。
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const makeNode = (assetUrl: string): MivoCanvasNode =>
    ({
      id: 'n1',
      type: 'image',
      assetUrl,
      title: 'ext',
      assetOriginalName: 'img.png',
      assetMimeType: 'image/png',
      // 无 aiWorkflow → 非 result kind，flattenAlphaToWhiteIfNeeded 直接 return
    } as unknown as MivoCanvasNode)

  it('W3 direct fetch TypeError(CORS) → 代理回退成功返 File', async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    const fetchMock = vi.fn()
      // 第一次 direct fetch 抛 TypeError（CORS）
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      // 第二次 proxy fetch 成功
      .mockResolvedValueOnce({ ok: true, blob: async () => blob } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const file = await readCanvasImageBlob(makeNode('http://example.com/img.png'))
    expect(file).toBeInstanceOf(File)
    expect(fetchMock).toHaveBeenCalledTimes(2) // direct + proxy
    // 第二次 fetch 的 URL 应含 /api/mivo/proxy-image
    const proxyCallUrl = fetchMock.mock.calls[1][0] as string
    expect(String(proxyCallUrl)).toContain('/api/mivo/proxy-image')
  })

  it('W3 direct fetch !ok(403 CORS preflight) → 代理回退成功', async () => {
    const blob = new Blob([new Uint8Array([0x89])], { type: 'image/png' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, blob: async () => blob } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const file = await readCanvasImageBlob(makeNode('http://example.com/img.png'))
    expect(file).toBeInstanceOf(File)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('W3 代理也败 → 中文错误"无法读取外链图片，请下载后重新导入"', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(readCanvasImageBlob(makeNode('http://example.com/img.png'))).rejects.toThrow(
      '无法读取外链图片，请下载后重新导入',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('W1 非 result kind 不触发 alpha flatten（仅 1 次 fetch，File 直接返回）', async () => {
    const blob = new Blob([new Uint8Array([0x89])], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, blob: async () => blob } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    // 非 result kind → flattenAlphaToWhiteIfNeeded 直接 return，不调 createImageBitmap。
    // node 环境无 createImageBitmap；若误触发会抛错。File 成功返回即证明未 flatten。
    const file = await readCanvasImageBlob(makeNode('http://example.com/img.png'))
    expect(file).toBeInstanceOf(File)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
