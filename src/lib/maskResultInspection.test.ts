import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  mapBoundsToResultSpace,
  blackRatioInRegion,
  judgeBlackPlate,
  inspectMaskResultForBlackPlate,
} from './maskResultInspection'
import type { ImageMaskBounds } from '../canvas/imageMaskGeometry'

// 像素构造助手 ---------------------------------------------------------------

const fillRgba = (
  width: number,
  height: number,
  fill: 'black' | 'white' | 'transparent',
): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4
    if (fill === 'black') {
      data[idx] = 0
      data[idx + 1] = 0
      data[idx + 2] = 0
      data[idx + 3] = 255
    } else if (fill === 'white') {
      data[idx] = 255
      data[idx + 1] = 255
      data[idx + 2] = 255
      data[idx + 3] = 255
    } else {
      // transparent: RGB=0 but alpha=0 (透明 PNG 的透明区常见编码)
      data[idx] = 0
      data[idx + 1] = 0
      data[idx + 2] = 0
      data[idx + 3] = 0
    }
  }
  return data
}

// 纯函数单测 -----------------------------------------------------------------

describe('mapBoundsToResultSpace', () => {
  it('SC-W1④: 1600x900 源 → 1024 low 结果等比缩放 bounds', () => {
    const bounds: ImageMaskBounds = { x: 800, y: 400, width: 400, height: 300 }
    const result = mapBoundsToResultSpace(bounds, { width: 1600, height: 900 }, { width: 1024, height: 1024 })
    // scaleX = 1024/1600 = 0.64; scaleY = 1024/900 ≈ 1.1378
    expect(result.x).toBe(512) // floor(800 * 0.64)
    // right = ceil(1200 * 0.64) = 768; width = 768 - 512 = 256
    expect(result.width).toBe(256)
    // y = floor(400 * 1.1378) = 455
    expect(result.y).toBe(455)
    // bottom = ceil(700 * 1.1378) = 797; height = 797 - 455 = 342
    expect(result.height).toBe(342)
  })

  it('源与结果同尺寸时 bounds 像素级保持（仅 floor/ceil 取整）', () => {
    const bounds: ImageMaskBounds = { x: 100, y: 50, width: 200, height: 150 }
    const result = mapBoundsToResultSpace(bounds, { width: 1024, height: 1024 }, { width: 1024, height: 1024 })
    expect(result).toEqual({ x: 100, y: 50, width: 200, height: 150 })
  })

  it('越界 bounds 被 clamp 到结果图边界', () => {
    const bounds: ImageMaskBounds = { x: -10, y: -10, width: 2000, height: 2000 }
    const result = mapBoundsToResultSpace(bounds, { width: 1000, height: 1000 }, { width: 500, height: 500 })
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
    expect(result.width).toBe(500)
    expect(result.height).toBe(500)
  })
})

describe('blackRatioInRegion', () => {
  it('全黑区 → ratio=1', () => {
    const w = 10
    const h = 10
    const rgba = fillRgba(w, h, 'black')
    const { ratio, sampled } = blackRatioInRegion(rgba, { width: w, height: h }, { x: 0, y: 0, width: w, height: h })
    expect(sampled).toBe(100)
    expect(ratio).toBe(1)
  })

  it('全白区 → ratio=0', () => {
    const w = 10
    const h = 10
    const rgba = fillRgba(w, h, 'white')
    const { ratio } = blackRatioInRegion(rgba, { width: w, height: h }, { x: 0, y: 0, width: w, height: h })
    expect(ratio).toBe(0)
  })

  it('半黑半白 → ratio≈0.5', () => {
    const w = 10
    const h = 10
    const rgba = fillRgba(w, h, 'white')
    // 左半边涂黑
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w / 2; x++) {
        const idx = (y * w + x) * 4
        rgba[idx] = 0
        rgba[idx + 1] = 0
        rgba[idx + 2] = 0
        rgba[idx + 3] = 255
      }
    }
    const { ratio, sampled } = blackRatioInRegion(rgba, { width: w, height: h }, { x: 0, y: 0, width: w, height: h })
    expect(sampled).toBe(100)
    expect(ratio).toBeCloseTo(0.5, 1)
  })

  it('透明像素（alpha=0）不计入分母，即使 RGB=0 也不算黑', () => {
    const w = 10
    const h = 10
    const rgba = fillRgba(w, h, 'transparent') // 全透明，RGB 全 0
    const { ratio, sampled } = blackRatioInRegion(rgba, { width: w, height: h }, { x: 0, y: 0, width: w, height: h })
    expect(sampled).toBe(0)
    expect(ratio).toBe(0) // 无采样像素 → 视为不黑（保守，避免空区误判）
  })

  it('W1.4: 目标输出大面积黑但非失败（源本黑样例）—— 全黑不透明区 ratio=1', () => {
    // 用户真要画纯黑区时，结果图该区也全黑。judgeBlackPlate 靠 source 也黑来排除。
    const w = 8
    const h = 8
    const rgba = fillRgba(w, h, 'black')
    const { ratio } = blackRatioInRegion(rgba, { width: w, height: h }, { x: 0, y: 0, width: w, height: h })
    expect(ratio).toBe(1)
  })
})

describe('judgeBlackPlate 四态', () => {
  it('SC-W1①: 黑盘 — 结果≥70%黑 + 源<30%黑 → true', () => {
    expect(judgeBlackPlate(0.8, 0.1)).toBe(true)
  })

  it('SC-W1②: 正常 — 结果<70%黑 → false', () => {
    expect(judgeBlackPlate(0.3, 0.1)).toBe(false)
  })

  it('SC-W1③: 源本黑 — 源≥30%黑 → false（即使结果全黑也不自愈）', () => {
    expect(judgeBlackPlate(0.95, 0.5)).toBe(false)
  })

  it('边界: 结果正好 70% + 源 29% → true（≥70 临界算黑盘）', () => {
    expect(judgeBlackPlate(0.7, 0.29)).toBe(true)
  })

  it('边界: 结果 69% → false（未达阈值）', () => {
    expect(judgeBlackPlate(0.69, 0.0)).toBe(false)
  })
})

// 集成测试：mock createImageBitmap + OffscreenCanvas，验证编排 ----------------

describe('inspectMaskResultForBlackPlate 集成', () => {
  const makeFakeBitmap = (width: number, height: number) => ({ width, height, close: vi.fn() })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('结果图 mask 区全黑 + 源图同区全白 → true（直接控制 ImageData）', async () => {
    // 更直接：让 getImageData 第一次返回全黑（result），第二次返回全白（source）
    let callIndex = 0
    const resultSize = { width: 8, height: 8 }
    const sourceSize = { width: 16, height: 16 }
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        callIndex++
        // 第一次=result（黑），第二次=source（白）
        if (callIndex === 1) {
          return { data: fillRgba(resultSize.width, resultSize.height, 'black'), width: resultSize.width, height: resultSize.height } as ImageData
        }
        return { data: fillRgba(sourceSize.width, sourceSize.height, 'white'), width: sourceSize.width, height: sourceSize.height } as ImageData
      }),
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => makeFakeBitmap(8, 8)))
    vi.stubGlobal('OffscreenCanvas', class {
      width: number; height: number
      constructor(w: number, h: number) { this.width = w; this.height = h }
      getContext() { return fakeCtx }
    })

    const detected = await inspectMaskResultForBlackPlate(
      {
        sourceSizePx: sourceSize,
        maskBoundsPx: { x: 0, y: 0, width: 16, height: 16 },
      },
      { sourceBlob: new Blob([]), resultB64: 'AAAA' },
    )
    expect(detected).toBe(true)
  })

  it('结果图 mask 区全白 → false（正常路径）', async () => {
    let callIndex = 0
    const resultSize = { width: 8, height: 8 }
    const sourceSize = { width: 16, height: 16 }
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        callIndex++
        if (callIndex === 1) {
          return { data: fillRgba(resultSize.width, resultSize.height, 'white'), width: resultSize.width, height: resultSize.height } as ImageData
        }
        return { data: fillRgba(sourceSize.width, sourceSize.height, 'white'), width: sourceSize.width, height: sourceSize.height } as ImageData
      }),
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => makeFakeBitmap(8, 8)))
    vi.stubGlobal('OffscreenCanvas', class {
      width: number; height: number
      constructor(w: number, h: number) { this.width = w; this.height = h }
      getContext() { return fakeCtx }
    })

    const detected = await inspectMaskResultForBlackPlate(
      {
        sourceSizePx: sourceSize,
        maskBoundsPx: { x: 0, y: 0, width: 16, height: 16 },
      },
      { sourceBlob: new Blob([]), resultB64: 'AAAA' },
    )
    expect(detected).toBe(false)
  })

  it('结果全黑但源也全黑 → false（源本黑，不误触发自愈）', async () => {
    let callIndex = 0
    const resultSize = { width: 8, height: 8 }
    const sourceSize = { width: 16, height: 16 }
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        callIndex++
        if (callIndex === 1) {
          return { data: fillRgba(resultSize.width, resultSize.height, 'black'), width: resultSize.width, height: resultSize.height } as ImageData
        }
        return { data: fillRgba(sourceSize.width, sourceSize.height, 'black'), width: sourceSize.width, height: sourceSize.height } as ImageData
      }),
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => makeFakeBitmap(8, 8)))
    vi.stubGlobal('OffscreenCanvas', class {
      width: number; height: number
      constructor(w: number, h: number) { this.width = w; this.height = h }
      getContext() { return fakeCtx }
    })

    const detected = await inspectMaskResultForBlackPlate(
      {
        sourceSizePx: sourceSize,
        maskBoundsPx: { x: 0, y: 0, width: 16, height: 16 },
      },
      { sourceBlob: new Blob([]), resultB64: 'AAAA' },
    )
    expect(detected).toBe(false)
  })

  it('createImageBitmap 抛错 → 保守返回 false（不误触发自愈）', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed') }))
    vi.stubGlobal('OffscreenCanvas', class {
      constructor() {}
      getContext() { return null }
    })

    const detected = await inspectMaskResultForBlackPlate(
      {
        sourceSizePx: { width: 10, height: 10 },
        maskBoundsPx: { x: 0, y: 0, width: 10, height: 10 },
      },
      { sourceBlob: new Blob([]), resultB64: 'AAAA' },
    )
    expect(detected).toBe(false)
  })
})
