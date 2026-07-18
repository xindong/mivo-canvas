import { describe, expect, it } from 'vitest'
import { activeClusters, buildHtml, computeLights, dataAnchor, esc, mergeGhItems, pLabel, parseLedger, parseLogs, queueCounts } from './render.mjs'

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

describe('Mivo 更名 + P3-9 展示层映射', () => {
  it('pLabel:S→P 一一映射,未知值原样兜底', () => {
    expect(['S0', 'S1', 'S2', 'S3'].map(pLabel)).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(pLabel('S9')).toBe('S9')
  })

  it('mergeGhItems:新旧标题前缀([mivo]/[bug-doctor])检索结果合并,按 number 去重排序——旧档不失联', () => {
    const newList = [
      { number: 300, title: '[mivo] fix: xxx' },
      { number: 281, title: 'feat(t2-intake): ...' },
    ]
    const oldList = [
      { number: 279, title: '[bug-doctor] fix(e2e): archive-cr6-409 prod 拓扑跳过' },
      { number: 281, title: 'feat(t2-intake): ...' }, // 两边都命中 → 去重
    ]
    const merged = mergeGhItems([newList, oldList])
    expect(merged.map((i) => i.number)).toEqual([300, 281, 279])
    expect(merged.some((i) => i.title.includes('[bug-doctor]'))).toBe(true) // 旧前缀样例仍被收录
    expect(merged.some((i) => i.title.includes('[mivo]'))).toBe(true)
  })

  it('buildHtml:标题 Mivo 看板、队列徽章 P0-P3、Top 簇 P 级列(内部字段仍 S 级传入)', () => {
    const runs = parseLogs('- 2026-07-18T02:30:00+08:00 · mode=full · 新记录 1 · 新簇 1 · 活跃簇 2 · S0 1 · 工作包 2 簇\n')
    const state = { clusters: {}, openPRs: [] }
    const act = [
      cluster({ fp: 'a', sLevel: 'S0', levels: ['error'], status: 'new' }),
      cluster({ fp: 'b', sLevel: 'S1', status: 'new' }),
    ]
    const ctx = {
      now: NOW,
      state,
      wp: { clusters: [{ fp: 'a', sLevel: 'S0', score: 9, source: 'Persist Boot', pattern: 'boom' }] },
      baseline: null,
      runs,
      ledger: parseLedger(''),
      gh: { prs: [], issues: [], stale: true, error: 'off', fetchedAt: null },
      stateDirLabel: '/tmp/x',
      q: queueCounts(act),
      costTotal: 0,
      lights: computeLights(act, RULES, NOW),
      anchor: NOW,
    }
    const html = buildHtml(ctx)
    expect(html).toContain('<title>Mivo 看板</title>')
    expect(html).toContain('<h1>Mivo 看板</h1>')
    expect(html).toContain('P0 1')
    expect(html).toContain('P1 1')
    expect(html).toContain('P2 0')
    expect(html).toContain('P3 0')
    expect(html).toContain('<th>P级</th>')
    expect(html).toContain('>P0</span>') // Top 簇徽章 S0 → P0 展示
    expect(html).not.toContain('badge s0">S0') // 队列徽章不再出 S 编号(logs 原文 tooltip 不在此列)
    expect(html).not.toContain('bug-doctor 状态看板')
  })
})
