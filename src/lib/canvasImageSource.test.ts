import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// readImportedAssetFile 走 IDB；单测走外链 fetch 路径，故 mock 为 undefined。
vi.mock('./assetStorage', () => ({
  readImportedAssetFile: vi.fn(async () => undefined),
}))
// 黑块修复：canvasImageSource 现在依赖 debugLogger（归一失败告警）。mock 掉 store，
// 既隔离 zustand/remoteDebugReporter，又可断言 warn 被调。
const debugLoggerSpies = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../store/debugLogStore', () => ({ debugLogger: debugLoggerSpies }))

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
    // 非 result kind → normalizeGeneratedResultForEdit 直接 return，不调 createImageBitmap。
    // node 环境无 createImageBitmap；若误触发会抛错。File 成功返回即证明未 flatten。
    const file = await readCanvasImageBlob(makeNode('http://example.com/img.png'))
    expect(file).toBeInstanceOf(File)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// —— 黑块修复：result 源恒不透明归一（白底重绘导出 PNG） ————————————————————
describe('readCanvasImageBlob（黑块修复：result 源恒归一）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    debugLoggerSpies.warn.mockReset()
  })

  const resultNode = (assetUrl: string): MivoCanvasNode =>
    ({
      id: 'r1',
      type: 'image',
      assetUrl,
      title: 'result',
      assetOriginalName: 'result.png',
      assetMimeType: 'image/png',
      aiWorkflow: { kind: 'result', status: 'ready' },
    } as unknown as MivoCanvasNode)

  const stubFetchPng = () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, blob: async () => blob } as unknown as Response))
  }

  // 全不透明 16x16 RGBA（归一后 canvas 的正常形态）。
  const opaqueImageData = () => {
    const data = new Uint8ClampedArray(16 * 16 * 4)
    data.fill(255)
    return { data, width: 16, height: 16 } as ImageData
  }

  it('result kind → 无论输入是否透明，一律白底重绘导出 PNG（fillRect 先于 drawImage + 输出 alpha 校验）', async () => {
    stubFetchPng()
    const ops: string[] = []
    const flattenedBlob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' })
    const fakeCtx = {
      fillStyle: '',
      fillRect: vi.fn(() => ops.push('fillRect')),
      drawImage: vi.fn(() => ops.push('drawImage')),
      getImageData: vi.fn(() => { ops.push('getImageData'); return opaqueImageData() }),
      putImageData: vi.fn(() => ops.push('putImageData')),
    }
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx,
      toBlob: (cb: (b: Blob | null) => void) => cb(flattenedBlob),
    }
    vi.stubGlobal('document', { createElement: () => fakeCanvas })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 16, close: vi.fn() })))

    const file = await readCanvasImageBlob(resultNode('http://example.com/result.png'))
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(flattenedBlob.size) // 返回的是归一后的 PNG，不是原 file
    // 白底先铺，再重绘源图（透明区被白底填充 → 全图不透明），导出前校验输出 alpha
    expect(ops).toEqual(['fillRect', 'drawImage', 'getImageData'])
    expect(fakeCtx.fillStyle).toBe('#ffffff')
    // 输出已全不透明 → 无需强制修正，不告警
    expect(fakeCtx.putImageData).not.toHaveBeenCalled()
    expect(debugLoggerSpies.warn).not.toHaveBeenCalled()
  })

  it('result kind 输出校验发现残余 alpha<255 → 强制置 255（putImageData）+ warn，仍导出 PNG', async () => {
    stubFetchPng()
    const flattenedBlob = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' })
    const residual = opaqueImageData()
    residual.data[3] = 128 // 首像素残余半透明（异常合成实现兜底路径）
    const fakeCtx = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => residual),
      putImageData: vi.fn(),
    }
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx,
      toBlob: (cb: (b: Blob | null) => void) => cb(flattenedBlob),
    }
    vi.stubGlobal('document', { createElement: () => fakeCanvas })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 16, close: vi.fn() })))

    const file = await readCanvasImageBlob(resultNode('http://example.com/result.png'))
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(flattenedBlob.size)
    expect(fakeCtx.putImageData).toHaveBeenCalledTimes(1)
    expect(residual.data[3]).toBe(255) // 残余像素已被强制不透明
    expect(debugLoggerSpies.warn).toHaveBeenCalledTimes(1)
    expect(String(debugLoggerSpies.warn.mock.calls[0][1])).toContain('residual translucent')
  })

  it('result kind 解码失败 → debugLogger.warn 且返回原 file（不静默、不阻断）', async () => {
    stubFetchPng()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode boom') }))
    const file = await readCanvasImageBlob(resultNode('http://example.com/result.png'))
    expect(file).toBeInstanceOf(File)
    expect(debugLoggerSpies.warn).toHaveBeenCalledTimes(1)
    expect(String(debugLoggerSpies.warn.mock.calls[0][1])).toContain('decode boom')
  })

  it('result kind PNG 导出返回 null → debugLogger.warn 且返回原 file', async () => {
    stubFetchPng()
    const fakeCtx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => opaqueImageData()), putImageData: vi.fn() }
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx,
      toBlob: (cb: (b: Blob | null) => void) => cb(null),
    }
    vi.stubGlobal('document', { createElement: () => fakeCanvas })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 16, close: vi.fn() })))
    const file = await readCanvasImageBlob(resultNode('http://example.com/result.png'))
    expect(file).toBeInstanceOf(File)
    expect(debugLoggerSpies.warn).toHaveBeenCalledTimes(1)
  })
})
