import { describe, expect, it, vi } from 'vitest'

// rendererMode 在模块加载时解析一次 URL —— resetModules + stubGlobal 逐场景
// 重载,与 textPaintMode.test.ts 同款测法。本测试锁定 2026-07-06 的默认切换:
// 默认(无参数/非法值/非浏览器环境)= leafer;?renderer=dom 是应急回退通道。

const loadWithSearch = async (search: string | null) => {
  vi.resetModules()
  if (search === null) {
    vi.stubGlobal('window', undefined as unknown as Window & typeof globalThis)
  } else {
    vi.stubGlobal('window', { location: { search } } as unknown as Window & typeof globalThis)
  }
  vi.doMock('../store/debugLogStore', () => ({
    debugLogger: { warn: vi.fn(), log: vi.fn() },
  }))
  try {
    return await import('./rendererMode')
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('rendererMode(默认 leafer,dom 为应急回退通道)', () => {
  it('缺省 = leafer:未带参数即走 Leafer 渲染', async () => {
    const mod = await loadWithSearch('')
    expect(mod.rendererMode).toBe('leafer')
    expect(mod.isLeaferRendererRequested).toBe(true)
  })

  it('非法值回退默认 leafer(不再回退 dom)', async () => {
    const mod = await loadWithSearch('?renderer=webgl2')
    expect(mod.rendererMode).toBe('leafer')
  })

  it('非浏览器环境(SSR/单测)默认 leafer', async () => {
    const mod = await loadWithSearch(null)
    expect(mod.rendererMode).toBe('leafer')
  })

  it('?renderer=dom 应急回退通道语义不变', async () => {
    const mod = await loadWithSearch('?renderer=dom')
    expect(mod.rendererMode).toBe('dom')
    expect(mod.isLeaferRendererRequested).toBe(false)
  })

  it('?renderer=leafer 显式请求与缺省等价', async () => {
    const mod = await loadWithSearch('?renderer=leafer')
    expect(mod.rendererMode).toBe('leafer')
  })

  it('?renderer=pixi spike 通道保留(工装用)', async () => {
    const mod = await loadWithSearch('?renderer=pixi')
    expect(mod.rendererMode).toBe('pixi')
  })
})
