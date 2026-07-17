import { describe, expect, it } from 'vitest'
import { activeClusters, computeLights, dataAnchor, esc, parseLedger, parseLogs, queueCounts } from './render.mjs'

const RULES = {
  coreProcesses: [
    { id: 'persistence', label: '持久化读写', sourcePatterns: ['^Persist', '^Write Retry Queue', '^Canvas Sync'] },
    { id: 'chat', label: '聊天面板', sourcePatterns: ['^Chat'] },
  ],
}
const T = (iso) => iso
const NOW = new Date('2026-07-17T03:20:52.272Z')

function cluster(over) {
  return { fp: 'x', source: 'Persist Boot', pattern: 'p', sLevel: 'S1', levels: ['warning'], status: 'new', count: 1, lastSeen: T('2026-07-17T03:00:00Z'), silentFailure: false, ...over }
}

describe('computeLights 六流程状态灯', () => {
  it('窗口内活跃 S0 簇 → 该流程红灯', () => {
    const lights = computeLights([cluster({ source: 'Write Retry Queue', sLevel: 'S0', levels: ['error'] })], RULES, NOW)
    expect(lights.find((l) => l.id === 'persistence').color).toBe('red')
    expect(lights.find((l) => l.id === 'chat').color).toBe('green')
  })
  it('无 S0 但有 error 级簇 → 黄灯', () => {
    const lights = computeLights([cluster({ levels: ['error'], sLevel: 'S1' })], RULES, NOW)
    expect(lights.find((l) => l.id === 'persistence').color).toBe('yellow')
  })
  it('纯 warning 簇 → 绿灯(降级路径不亮黄),warn 计数保留', () => {
    const lights = computeLights([cluster()], RULES, NOW)
    const p = lights.find((l) => l.id === 'persistence')
    expect(p.color).toBe('green')
    expect(p.warn).toBe(1)
  })
  it('超出 24h 窗口的 S0 不点灯', () => {
    const lights = computeLights([cluster({ sLevel: 'S0', levels: ['error'], lastSeen: T('2026-07-15T00:00:00Z') })], RULES, NOW)
    expect(lights.find((l) => l.id === 'persistence').color).toBe('green')
  })
  it('silentFailure 特征等同 S0 红灯', () => {
    const lights = computeLights([cluster({ silentFailure: true })], RULES, NOW)
    expect(lights.find((l) => l.id === 'persistence').color).toBe('red')
  })
})

describe('activeClusters / queueCounts / dataAnchor', () => {
  it('resolved/known-noise 不计入活跃', () => {
    const state = { clusters: { a: cluster({ status: 'resolved' }), b: cluster({ status: 'new', sLevel: 'S0' }), c: cluster({ status: 'known-noise' }) } }
    const act = activeClusters(state)
    expect(act.length).toBe(1)
    expect(queueCounts(act)).toEqual({ S0: 1, S1: 0, S2: 0, S3: 0 })
  })
  it('dataAnchor 取活跃簇最大 lastSeen', () => {
    const act = [cluster({ lastSeen: T('2026-07-16T00:00:00Z') }), cluster({ lastSeen: T('2026-07-17T03:20:52.272Z') })]
    expect(dataAnchor(act, new Date(0)).toISOString()).toBe('2026-07-17T03:20:52.272Z')
  })
})

describe('parseLogs / parseLedger', () => {
  it('解析运行行:有活/空转/进化轮', () => {
    const md = [
      '# bug-doctor logs',
      '- 2026-07-17T23:16:55+08:00 · mode=full · 新记录 41 · 新簇 14 · 活跃簇 14 · S0 2 · 工作包 14 簇',
      '- 2026-07-17T23:17:59+08:00 · mode=full · 新记录 0 · 新簇 0 · 活跃簇 14 · S0 2 · 空转跳过(工作包指纹一致)',
      '- 2026-07-18T02:30:00+08:00 · mode=evolve · 契约修订建议 1 条',
    ].join('\n')
    const runs = parseLogs(md)
    expect(runs.length).toBe(3)
    expect(runs[0].idle).toBe(false)
    expect(runs[0].workpacket).toBe(14)
    expect(runs[1].idle).toBe(true)
    expect(runs[2].evolve).toBe(true)
  })
  it('ledger 求和 cost,容忍空文件', () => {
    expect(parseLedger('').costTotal).toBe(0)
    const { rows, costTotal } = parseLedger('runAt,mode,cost\n2026-07-17,full,3\n2026-07-18,full,2')
    expect(rows.length).toBe(2)
    expect(costTotal).toBe(5)
  })
})

describe('esc', () => {
  it('转义 HTML 特殊字符(pattern 里有 JSON 引号)', () => {
    expect(esc('{"error":"<x>&\'y\'"}')).toBe('{&quot;error&quot;:&quot;&lt;x&gt;&amp;&#39;y&#39;&quot;}')
  })
})
