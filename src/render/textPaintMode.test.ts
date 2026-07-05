import { describe, expect, it, vi } from 'vitest'

// textPaintMode 在模块加载时解析一次 URL —— 用 resetModules + stubGlobal
// 逐场景重载,与 rendererMode/engineLodMode 的既有测法同款。

const loadWithSearch = async (search: string) => {
  vi.resetModules()
  vi.stubGlobal('window', { location: { search } } as unknown as Window & typeof globalThis)
  vi.doMock('../store/debugLogStore', () => ({
    debugLogger: { warn: vi.fn(), log: vi.fn() },
  }))
  const mod = await import('./textPaintMode')
  vi.unstubAllGlobals()
  return mod
}

describe('textPaintMode(Phase 5 spike flag)', () => {
  it('缺省 dom:未带参数时不启用 Leafer 文本绘制', async () => {
    const mod = await loadWithSearch('')
    expect(mod.textPaintMode).toBe('dom')
    expect(mod.isLeaferTextPaintRequested).toBe(false)
  })

  it('?textPaint=leafer 启用 spike 绘制', async () => {
    const mod = await loadWithSearch('?textPaint=leafer')
    expect(mod.textPaintMode).toBe('leafer')
    expect(mod.isLeaferTextPaintRequested).toBe(true)
  })

  it('非法值回退 dom(fail-safe)', async () => {
    const mod = await loadWithSearch('?textPaint=canvas2d')
    expect(mod.textPaintMode).toBe('dom')
    expect(mod.isLeaferTextPaintRequested).toBe(false)
  })

  it('显式 dom 与缺省等价', async () => {
    const mod = await loadWithSearch('?textPaint=dom')
    expect(mod.textPaintMode).toBe('dom')
  })
})
