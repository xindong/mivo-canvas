// persistMode.build-env.test.ts
// SC-A 构建模式分离证明(lead D1):仓库内提交 `.env.production`(VITE_MIVO_PERSIST=server)→
// `vite build`(production mode)加载它 → 生产构建 server 持久化;`npm run dev`(development mode)与
// 单测(test mode)不加载 .env.production → 仍 local(开发/测试零变化)。
//
// 本测试用 Vite 构建期加载 .env 文件的**同一函数** `loadEnv(mode, envDir)` 直接验证:
//  - production mode → loadEnv 合并 .env + .env.production → VITE_MIVO_PERSIST='server'(文件形态正确 + Vite 按 mode 加载)。
//  - development/test mode → loadEnv 不加载 .env.production → VITE_MIVO_PERSIST 不由本文件设 → local。
// 配合 persistMode.test.ts(env 通道:动态索引 import.meta.env[PERSIST_ENV_KEY] 读取,vi.stubEnv 生效)→
// 端到端证明:production build = server,dev/test = local。SC-A 的"构建期验证"证据即本测试通过。
//
// 注:loadEnv 合并 process.env(优先级高于 .env 文件);本机/CI 未设 VITE_MIVO_PERSIST 进程 env,
// 故 development/test 断言 not.toBe('server')(文件不生效);若外部进程 env 恰设了 server,此断言会
// 误判——但那非本仓库 .env.production 的作用,属环境异常。

import { describe, expect, it } from 'vitest'
import { loadEnv } from 'vite'

describe('SC-A 构建模式分离 — .env.production 按 mode 加载(lead D1)', () => {
  it('production mode 加载 .env.production → VITE_MIVO_PERSIST=server(生产构建 server 持久化)', () => {
    const env = loadEnv('production', process.cwd())
    expect(env.VITE_MIVO_PERSIST).toBe('server')
  })

  it('development mode 不加载 .env.production → 本文件不生效(dev 仍 local)', () => {
    const env = loadEnv('development', process.cwd())
    // dev mode 只加载 .env / .env.development(不含 .env.production)→ 本文件不设 VITE_MIVO_PERSIST。
    expect(env.VITE_MIVO_PERSIST).not.toBe('server')
  })

  it('test mode 不加载 .env.production → 单测环境 local(既有测试全绿的前提)', () => {
    const env = loadEnv('test', process.cwd())
    expect(env.VITE_MIVO_PERSIST).not.toBe('server')
  })
})
