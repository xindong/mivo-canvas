import { describe, expect, it } from 'vitest'
import { FINGERPRINT_VERSION, fingerprintOf, normalizeMessage } from './fingerprint.mjs'

describe('fingerprint 规整(fpv:1)', () => {
  it('版本号锁定为 1(升版需台账双写过渡,见执行计划)', () => {
    expect(FINGERPRINT_VERSION).toBe(1)
  })

  it('剥离 UUID:同根因不同 id 的记录聚成同簇', () => {
    const a = normalizeMessage('write dae69e09-75e0-44e2-b7ef-c1c65852a70e rejected by server: {"error":"unknown-project"}')
    const b = normalizeMessage('write 7e857b1c-5765-479b-9dab-96c0c114fb08 rejected by server: {"error":"unknown-project"}')
    expect(a).toBe(b)
    expect(a).toContain('<uuid>')
    expect(a).toContain('unknown-project')
  })

  it('剥离长 hex(≥8)与前缀 UUID(canvas-<uuid> 形态)', () => {
    const a = normalizeMessage('fetchCanvas content hydrate failed for canvas-78c5bed3-c018-402a-a37c-abb95f9a59db: HTTP 500')
    const b = normalizeMessage('fetchCanvas content hydrate failed for canvas-11112222-3333-4444-5555-666677778888: HTTP 500')
    expect(a).toBe(b)
    expect(normalizeMessage('commit deadbeefcafe1234 failed')).toBe('commit <hex> failed')
  })

  it('剥离数字串但保留错误语义词(HTTP 状态码归一,语义词保留)', () => {
    const a = normalizeMessage('ServerPersistAdapter HTTP 500 GET /api/canvas/variants (content stays local)')
    const b = normalizeMessage('ServerPersistAdapter HTTP 502 GET /api/canvas/variants (content stays local)')
    expect(a).toBe(b)
    expect(a).toContain('ServerPersistAdapter')
    expect(a).toContain('HTTP <n>')
  })

  it('剥离引号路径与 URL query,保留裸路径语义', () => {
    expect(normalizeMessage('load "/Users/x/a.png" failed')).toBe('load <path> failed')
    expect(normalizeMessage("load '/var/data/b.json' failed")).toBe('load <path> failed')
    const a = normalizeMessage('GET https://api.example.com/v1/items?id=123&t=456 failed')
    const b = normalizeMessage('GET https://api.example.com/v1/items?id=999 failed')
    expect(a).toBe(b)
    expect(a).toContain('/v<n>/items')
  })

  it('不同规整前缀不误合并(unknown-project 与 project-exists 分簇)', () => {
    const a = fingerprintOf({ source: 'Write Retry Queue', message: 'write dae69e09-75e0-44e2-b7ef-c1c65852a70e rejected by server: {"error":"unknown-project"}' })
    const b = fingerprintOf({ source: 'Write Retry Queue', message: 'write f0f7e1fe-fada-48e4-b890-882f34d43c12 rejected by server: {"error":"project-exists","id":"project-demo-concept-battlepass"}' })
    expect(a).not.toBe(b)
    expect(a.startsWith('Write Retry Queue::')).toBe(true)
  })

  it('纯函数:同输入恒等输出;source 缺失降级 Unknown', () => {
    const rec = { source: 'Persist Boot', message: 'migration candidate createCanvas variants terminally failed at 2026-07-16T04:05:06Z' }
    expect(fingerprintOf(rec)).toBe(fingerprintOf({ ...rec }))
    expect(fingerprintOf({ message: 'x' })).toBe('Unknown::x')
  })

  it('超长消息截断到固定前缀长度(尾部变量噪声不影响聚类)', () => {
    const long = `boom ${'y'.repeat(500)}`
    expect(normalizeMessage(long).length).toBeLessThanOrEqual(200)
    expect(normalizeMessage(long)).toBe(normalizeMessage(`${long} tail-差异`))
  })
})
