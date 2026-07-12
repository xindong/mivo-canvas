// @vitest-environment node
// server/__tests__/readiness.singleflight.test.ts
// R2-5:probeAssetDirWritable singleflight — 并发首波共享一次 in-flight probe(防 thundering herd)。
//
// 对抗负例(sol3 复现):旧实现只缓存**完成**结果(cachedAssetProbe 存 resolved result);
// 并发首波(TTL 已过期/首次)全部 cache miss → N 个并发请求各自 stat+write+unlink:
//  1. inode churn 放大 N 倍(每请求 create/unlink 一个 probe 文件);
//  2. N 个并发 writeFile 争写(固定 sentinel 名时还可能互相 clobber / 删既有同名文件)。
// 修法:缓存 in-flight **Promise**(非仅结果)——首波共享一次 fs ops;独占随机临时文件名杜绝冲突。
//
// 测法:mock node:fs/promises 的 stat/writeFile,stat 模拟 30ms 慢(让并发首波都到达后才 resolve),
//       计数 stat/writeFile 调用次数 → 并发 5 个只 stat 1 次 = singleflight 生效。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted:vi.mock factory 在 import 解析前求值(hoisted),闭包外变量不可达 → 用 hoisted 持有可变计数器。
const { counters, mocks } = vi.hoisted(() => {
  const counters = { statCalls: 0, writeCalls: 0 }
  return {
    counters,
    mocks: {
      stat: async () => {
        counters.statCalls++
        // 慢 stat:让并发首波全部到达后才 resolve(模拟 stat 慢 / 池耗尽)→ 触发 singleflight 路径。
        await new Promise((r) => setTimeout(r, 30))
        return { isDirectory: () => true }
      },
      writeFile: async () => {
        counters.writeCalls++
      },
      unlink: async () => {},
    },
  }
})

vi.mock('node:fs/promises', () => ({ default: mocks, ...mocks }))

describe('R2-5: probeAssetDirWritable singleflight (mock fs)', () => {
  beforeEach(() => {
    counters.statCalls = 0
    counters.writeCalls = 0
    vi.resetModules() // 每测重置 readiness 模块态(inflightProbe/cachedAssetProbe)
  })

  it('并发首波 → 共享一次 in-flight probe(stat/writeFile 各调 1 次,非 5×)', async () => {
    const { probeAssetDirWritable } = await import('../lib/readiness')
    const dir = '/tmp/mivo-singleflight-concurrent'
    const results = await Promise.all([
      probeAssetDirWritable(dir, true),
      probeAssetDirWritable(dir, true),
      probeAssetDirWritable(dir, true),
      probeAssetDirWritable(dir, true),
      probeAssetDirWritable(dir, true),
    ])
    // singleflight:5 个并发请求共享一次 in-flight probe → stat 1 次(非 5)、writeFile 1 次(非 5)。
    expect(counters.statCalls).toBe(1)
    expect(counters.writeCalls).toBe(1)
    expect(results.every((r) => r.status === 'ok')).toBe(true)
  })

  it('TTL 窗内顺序复用(不重复 stat;首波后 cachedProbe 命中)', async () => {
    const { probeAssetDirWritable } = await import('../lib/readiness')
    const dir = '/tmp/mivo-ttl-reuse'
    await probeAssetDirWritable(dir, true)
    await probeAssetDirWritable(dir, true)
    await probeAssetDirWritable(dir, true)
    // 首次 probe 后 TTL(2s)窗内复用 cachedProbe → 无再 stat。
    expect(counters.statCalls).toBe(1)
  })

  it('enabled=false → skipped,不触 fs(stat 0 次)', async () => {
    const { probeAssetDirWritable } = await import('../lib/readiness')
    const r = await probeAssetDirWritable('/tmp/mivo-skipped', false)
    expect(r.status).toBe('skipped')
    expect(counters.statCalls).toBe(0)
  })
})
