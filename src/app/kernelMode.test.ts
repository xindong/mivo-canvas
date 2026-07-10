import { describe, expect, it, vi } from 'vitest'

// kernelMode 在模块加载时解析一次 URL + env —— resetModules + stubGlobal/stubEnv
// 逐场景重载，与 rendererMode.test.ts 同款测法。本测试锁定 T0.3 契约：
// 默认（无参数 / 非法值 / 非浏览器环境）= legacy；?kernel=new / VITE_MIVO_KERNEL=new
// 切新内核；env 优先级 > URL > 默认 legacy。

const loadWith = async (search: string | null, env?: string) => {
  vi.resetModules()
  const logSpy = vi.fn()
  const warnSpy = vi.fn()
  if (search === null) {
    vi.stubGlobal('window', undefined as unknown as Window & typeof globalThis)
  } else {
    vi.stubGlobal('window', { location: { search } } as unknown as Window & typeof globalThis)
  }
  if (env !== undefined) {
    vi.stubEnv('VITE_MIVO_KERNEL', env)
  }
  vi.doMock('../store/debugLogStore', () => ({
    debugLogger: { warn: warnSpy, log: logSpy },
  }))
  try {
    const mod = await import('./kernelMode')
    return { ...mod, debugLogger: { log: logSpy, warn: warnSpy } }
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
}

describe('kernelMode（默认 legacy，new 为迁移藏身开关）', () => {
  it('缺省 = legacy：未带参数且无 env 即走 legacy 内核', async () => {
    const mod = await loadWith('')
    expect(mod.kernelMode).toBe('legacy')
    expect(mod.isLegacyKernel).toBe(true)
    expect(mod.isNewKernel).toBe(false)
    expect(mod.getKernelMode()).toBe('legacy')
  })

  it('?kernel=new 切到新内核（URL 通道）', async () => {
    const mod = await loadWith('?kernel=new')
    expect(mod.kernelMode).toBe('new')
    expect(mod.isNewKernel).toBe(true)
    expect(mod.isLegacyKernel).toBe(false)
  })

  it('VITE_MIVO_KERNEL=new 切到新内核（env 通道，无需 URL）', async () => {
    const mod = await loadWith('', 'new')
    expect(mod.kernelMode).toBe('new')
    expect(mod.getKernelMode()).toBe('new')
  })

  it('env 优先级 > URL：env=new 且 ?kernel=legacy → new', async () => {
    const mod = await loadWith('?kernel=legacy', 'new')
    expect(mod.kernelMode).toBe('new')
  })

  it('?kernel=legacy 显式请求与缺省等价', async () => {
    const mod = await loadWith('?kernel=legacy')
    expect(mod.kernelMode).toBe('legacy')
  })

  it('非法值回退默认 legacy', async () => {
    const mod = await loadWith('?kernel=future')
    expect(mod.kernelMode).toBe('legacy')
  })

  it('非浏览器环境（SSR/单测）默认 legacy', async () => {
    const mod = await loadWith(null)
    expect(mod.kernelMode).toBe('legacy')
  })
})

describe('kernelMode T0.3 — 内核身份 Debug Log', () => {
  it('缺省启动：有且仅有一条内核身份 log，无 warn', async () => {
    const mod = await loadWith('')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(mod.debugLogger.warn).not.toHaveBeenCalled()
    expect(mod.debugLogger.log.mock.calls[0][0]).toBe('Kernel')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('legacy')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('identity')
  })

  it('?kernel=new：走 new 通道 log（来源 url）', async () => {
    const mod = await loadWith('?kernel=new')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('new kernel requested')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('来源 url')
  })

  it('env=new：同样走 new 通道 log（来源 env）', async () => {
    const mod = await loadWith('', 'new')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('new kernel requested')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('来源 env')
  })

  it('显式 ?kernel=legacy：同样一条身份 log', async () => {
    const mod = await loadWith('?kernel=legacy')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(mod.debugLogger.warn).not.toHaveBeenCalled()
  })

  it('非法值：warn 一条，不额外打身份 log（warn 即身份记录）', async () => {
    const mod = await loadWith('?kernel=future')
    expect(mod.debugLogger.warn).toHaveBeenCalledTimes(1)
    expect(mod.debugLogger.log).not.toHaveBeenCalled()
  })

  it('非浏览器环境（SSR/单测）不打身份 log（与 rendererMode 同：避免污染未 mock debugLogger 的测试）', async () => {
    const mod = await loadWith(null)
    expect(mod.kernelMode).toBe('legacy')
    expect(mod.debugLogger.log).not.toHaveBeenCalled()
    expect(mod.debugLogger.warn).not.toHaveBeenCalled()
  })
})
