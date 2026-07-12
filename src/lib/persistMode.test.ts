import { describe, expect, it, vi } from 'vitest'

// persistMode 在模块加载时解析一次 URL + env —— resetModules + stubGlobal/stubEnv
// 逐场景重载,与 kernelMode.test.ts 同款测法。本测试锁定 G1-a 三态开关契约:
// 默认(无参数 / 非法值 / 非浏览器环境)= local;?persist=server|shadow / VITE_MIVO_PERSIST
// 切对应态;env 优先级 > URL > 默认 local。默认 local = 生产零变化(adapter unwired / queue inert)。

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
    vi.stubEnv('VITE_MIVO_PERSIST', env)
  }
  vi.doMock('../store/debugLogStore', () => ({
    debugLogger: { warn: warnSpy, log: logSpy },
  }))
  try {
    const mod = await import('./persistMode')
    return { ...mod, debugLogger: { log: logSpy, warn: warnSpy } }
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
}

describe('persistMode(默认 local,server/shadow 为 G1-a 藏身开关)', () => {
  it('缺省 = local:未带参数且无 env 即走 local(生产零变化)', async () => {
    const mod = await loadWith('')
    expect(mod.persistMode).toBe('local')
    expect(mod.isLocalPersist).toBe(true)
    expect(mod.isShadowPersist).toBe(false)
    expect(mod.isServerPersist).toBe(false)
    expect(mod.getPersistMode()).toBe('local')
  })

  it('?persist=server 切到 server(URL 通道)', async () => {
    const mod = await loadWith('?persist=server')
    expect(mod.persistMode).toBe('server')
    expect(mod.isServerPersist).toBe(true)
    expect(mod.isLocalPersist).toBe(false)
  })

  it('?persist=shadow 切到 shadow(URL 通道)', async () => {
    const mod = await loadWith('?persist=shadow')
    expect(mod.persistMode).toBe('shadow')
    expect(mod.isShadowPersist).toBe(true)
  })

  it('VITE_MIVO_PERSIST=server 切到 server(env 通道,无需 URL)', async () => {
    const mod = await loadWith('', 'server')
    expect(mod.persistMode).toBe('server')
    expect(mod.getPersistMode()).toBe('server')
  })

  it('env 优先级 > URL:env=server 且 ?persist=local → server', async () => {
    const mod = await loadWith('?persist=local', 'server')
    expect(mod.persistMode).toBe('server')
  })

  it('?persist=local 显式请求与缺省等价', async () => {
    const mod = await loadWith('?persist=local')
    expect(mod.persistMode).toBe('local')
  })

  it('非法值回退默认 local', async () => {
    const mod = await loadWith('?persist=future')
    expect(mod.persistMode).toBe('local')
  })

  it('非浏览器环境(SSR/单测)默认 local', async () => {
    const mod = await loadWith(null)
    expect(mod.persistMode).toBe('local')
  })
})

describe('persistMode G1-a — 持久化身份 Debug Log', () => {
  it('缺省启动:有且仅有一条身份 log,无 warn', async () => {
    const mod = await loadWith('')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(mod.debugLogger.warn).not.toHaveBeenCalled()
    expect(mod.debugLogger.log.mock.calls[0][0]).toBe('Persist')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('local')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('identity')
  })

  it('?persist=server:走 server 通道 log(来源 url)', async () => {
    const mod = await loadWith('?persist=server')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('server persist requested')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('来源 url')
  })

  it('env=server:同样走 server 通道 log(来源 env)', async () => {
    const mod = await loadWith('', 'server')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('server persist requested')
    expect(String(mod.debugLogger.log.mock.calls[0][1])).toContain('来源 env')
  })

  it('显式 ?persist=local:同样一条身份 log', async () => {
    const mod = await loadWith('?persist=local')
    expect(mod.debugLogger.log).toHaveBeenCalledTimes(1)
    expect(mod.debugLogger.warn).not.toHaveBeenCalled()
  })

  it('非法值:warn 一条,不额外打身份 log(warn 即身份记录)', async () => {
    const mod = await loadWith('?persist=future')
    expect(mod.debugLogger.warn).toHaveBeenCalledTimes(1)
    expect(mod.debugLogger.log).not.toHaveBeenCalled()
  })

  it('非浏览器环境(SSR/单测)不打身份 log(避免污染未 mock debugLogger 的测试)', async () => {
    const mod = await loadWith(null)
    expect(mod.persistMode).toBe('local')
    expect(mod.debugLogger.log).not.toHaveBeenCalled()
    expect(mod.debugLogger.warn).not.toHaveBeenCalled()
  })
})
