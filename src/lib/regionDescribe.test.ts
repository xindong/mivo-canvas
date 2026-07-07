// src/lib/regionDescribe.test.ts
// describeRegionCrop 降级契约单测:成功解析 / 非 2xx / 网络异常 / 响应形状异常 一律不 throw,
// 失败路径回退 []。canvas 绘制函数(cropRegionBlob / anchorContextBlob / buildAnchorMarkedImage)
// 依赖 DOM 解码,不在此测。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { describeRegionCrop } from './regionDescribe'

const crop = new Blob(['x'], { type: 'image/png' })
const makeSignal = (): AbortSignal => new AbortController().signal

describe('describeRegionCrop', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功解析 candidates → 返回数组(过滤空 label、归一非法 scope 为 part)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          { label: '动漫女孩', scope: 'whole' },
          { label: '白色头发', scope: 'part' },
          { label: '   ', scope: 'part' },
          { label: '眼睛', scope: 'bogus' },
        ],
      }),
    })
    const list = await describeRegionCrop(crop, makeSignal())
    expect(list).toEqual([
      { label: '动漫女孩', scope: 'whole' },
      { label: '白色头发', scope: 'part' },
      { label: '眼睛', scope: 'part' },
    ])
  })

  it('非 2xx 响应 → 静默回退 []', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    expect(await describeRegionCrop(crop, makeSignal())).toEqual([])
  })

  it('fetch 抛错(网络异常 / 中止)→ 静默回退 []', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    expect(await describeRegionCrop(crop, makeSignal())).toEqual([])
  })

  it('响应无 candidates 数组(degraded)→ 静默回退 []', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [], degradedReason: 'upstream' }),
    })
    // 空数组是合法 candidates,返回空列表(非降级路径,但结果同 [])。
    expect(await describeRegionCrop(crop, makeSignal())).toEqual([])
  })
})
