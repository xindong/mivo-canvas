import { describe, expect, it } from 'vitest'

import { buildBlindnessAlert, buildS0Alert } from './patrol.mjs'

describe('轻巡告警模板(Mivo 更名 + P 编号展示,P3-9)', () => {
  it('失明告警:Mivo 署名 + [mivo] 前缀 + P0 措辞,无 bug-doctor 字样', () => {
    const { title, text } = buildBlindnessAlert({ failures: 3, threshold: 3, stateDir: '/tmp/x' })
    expect(title).toContain('[mivo]')
    expect(title).toContain('Mivo')
    expect(text).toContain('P0 检测已停摆')
    expect(`${title}\n${text}`).not.toContain('bug-doctor')
    expect(`${title}\n${text}`).not.toMatch(/S0/)
  })

  it('P0 告警:标题 [mivo]+P0,簇统计行 S 级映射为 P 级展示(内部字段仍是 S)', () => {
    const alert = { kind: 'cluster', fp: 'Persist Boot::x', source: 'Persist Boot', pattern: 'x' }
    const clustersByFp = {
      'Persist Boot::x': { sLevel: 'S1', count24h: 4, distinctClients24h: 2, count: 9 },
    }
    const { title, text } = buildS0Alert({ newAlerts: [alert], clustersByFp, stateDir: '/tmp/x' })
    expect(title).toBe('🚨 [mivo] P0 告警 · 1 项(整点轻巡)')
    expect(text).toContain('P1 · 24h 4 次 / 2 客户端 · 累计 9')
    expect(text).not.toMatch(/S1/)
    expect(`${title}\n${text}`).not.toContain('bug-doctor')
  })

  it('nightly 红灯项描述不受映射影响', () => {
    const { text } = buildS0Alert({
      newAlerts: [{ kind: 'nightly-red', conclusion: 'failure', url: 'https://x/runs/1' }],
      clustersByFp: {},
      stateDir: '/tmp/x',
    })
    expect(text).toContain('nightly-e2e 红灯(failure): https://x/runs/1')
  })
})
