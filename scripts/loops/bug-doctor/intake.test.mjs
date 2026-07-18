import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FINGERPRINT_VERSION, fingerprintOf } from './fingerprint.mjs'
import { defaultState, loadState, saveState } from './state.mjs'
import {
  HUMAN_DEFAULT_SLEVEL,
  HUMAN_ORIGIN,
  HUMAN_SOURCE,
  applyReport,
  buildStatus,
  loadAllowlist,
  queuePositionOf,
  resolveDefaultStateDir,
  shortId,
} from './intake.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INTAKE = join(__dirname, 'intake.mjs')
const GATE = join(__dirname, 'gate.mjs')

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bug-doctor-intake-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-07-18T12:00:00.000Z'
const KEY_A = 'slack:T02AYQYFS:C0BJ2PZA97C:1784351780.602959'
const KEY_B = 'slack:T02AYQYFS:C0BJ2PZA97C:1784359999.000001'
const REPORTER = 'U01D851JXL7'

const writeAllowlist = (ids = [REPORTER]) => {
  writeFileSync(join(dir, 'notify.env'), `SLACK_CHANNEL_ID=C0BJ2PZA97C\nINTAKE_ALLOWLIST=${ids.join(',')}\n`)
}

const runIntake = (args) =>
  JSON.parse(
    execFileSync('node', [INTAKE, ...args, '--state-dir', dir], { encoding: 'utf8' }).trim(),
  )

const reportArgs = (over = {}) => {
  const base = {
    'external-key': KEY_A,
    reporter: REPORTER,
    description: '画布里拖拽图片节点后撤销,节点残留半透明幽灵',
    now: NOW,
  }
  return Object.entries({ ...base, ...over }).flatMap(([k, v]) => [`--${k}`, v])
}

describe('loadAllowlist', () => {
  it('解析 INTAKE_ALLOWLIST(逗号分隔,容忍空白)', () => {
    writeFileSync(join(dir, 'notify.env'), 'INTAKE_ALLOWLIST= U1 , U2 ,\nSLACK_CHANNEL_ID=C\n')
    expect(loadAllowlist(dir)).toEqual(['U1', 'U2'])
  })

  it('文件缺失/变量缺失 → 空名单(fail-closed 由调用方拒绝)', () => {
    expect(loadAllowlist(dir)).toEqual([])
    writeFileSync(join(dir, 'notify.env'), 'SLACK_CHANNEL_ID=C\n')
    expect(loadAllowlist(dir)).toEqual([])
  })
})

describe('report(CLI 端到端,--state-dir 隔离)', () => {
  it('SC②/①:白名单报单 → 建 S1 候诊人工簇,ack 含队列位置与指纹号', () => {
    writeAllowlist()
    const out = runIntake(['report', ...reportArgs()])
    expect(out.allowed).toBe(true)
    expect(out.kind).toBe('created')
    expect(out.sLevel).toBe(HUMAN_DEFAULT_SLEVEL)
    expect(out.pLevel).toBe('P1')
    expect(out.fpShort).toMatch(/^[0-9a-f]{8}$/)
    expect(out.queuePosition).toBe(1)
    expect(out.queueSize).toBe(1)

    const state = loadState(dir, FINGERPRINT_VERSION)
    const cluster = state.clusters[out.fp]
    expect(cluster.origin).toBe(HUMAN_ORIGIN)
    expect(cluster.source).toBe(HUMAN_SOURCE)
    expect(cluster.status).toBe('new')
    expect(cluster.reporters).toEqual([REPORTER])
    expect(state.intake.threads[KEY_A].fp).toBe(out.fp)
  })

  it('SC③:同串追问 → followup 不建新簇;同串同文案重跑 → duplicate 台账零变化', () => {
    writeAllowlist()
    const first = runIntake(['report', ...reportArgs()])
    const followup = runIntake([
      'report',
      ...reportArgs({ description: '补充:仅 leafer 渲染器出现,dom 回退正常', now: '2026-07-18T12:05:00.000Z' }),
    ])
    expect(followup.kind).toBe('followup')
    expect(followup.fp).toBe(first.fp)

    const stateAfterFollowup = readFileSync(join(dir, 'state.json'), 'utf8')
    const dup = runIntake([
      'report',
      ...reportArgs({ description: '补充:仅 leafer 渲染器出现,dom 回退正常', now: '2026-07-18T12:06:00.000Z' }),
    ])
    expect(dup.kind).toBe('duplicate')
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(stateAfterFollowup)

    const state = loadState(dir, FINGERPRINT_VERSION)
    expect(Object.keys(state.clusters)).toHaveLength(1)
    expect(state.clusters[first.fp].count).toBe(2)
  })

  it('不同串同指纹 → merged 并入既有簇,两串绑同簇', () => {
    writeAllowlist()
    const a = runIntake(['report', ...reportArgs()])
    const b = runIntake(['report', ...reportArgs({ 'external-key': KEY_B, now: '2026-07-18T13:00:00.000Z' })])
    expect(b.kind).toBe('merged')
    expect(b.fp).toBe(a.fp)
    const state = loadState(dir, FINGERPRINT_VERSION)
    expect(Object.keys(state.clusters)).toHaveLength(1)
    expect(state.intake.threads[KEY_A].fp).toBe(a.fp)
    expect(state.intake.threads[KEY_B].fp).toBe(a.fp)
  })

  it('SC④:非白名单 → allowed:false 且不写台账;名单缺失同样拒绝(fail-closed)', () => {
    writeAllowlist(['U_SOMEONE_ELSE'])
    const out = runIntake(['report', ...reportArgs()])
    expect(out.allowed).toBe(false)
    expect(out.reason).toBe('not-allowlisted')
    expect(existsSync(join(dir, 'state.json'))).toBe(false)

    rmSync(join(dir, 'notify.env'))
    const out2 = runIntake(['report', ...reportArgs()])
    expect(out2.allowed).toBe(false)
    expect(out2.reason).toBe('allowlist-missing')
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
  })

  it('台账被锁 → {status:locked} 不写入(交会话重试)', () => {
    writeAllowlist()
    writeFileSync(
      join(dir, 'gate.lock'),
      `${JSON.stringify({ pid: 99999, owner: 'gate:full', acquiredAt: new Date().toISOString() })}\n`,
    )
    const out = runIntake(['report', ...reportArgs()])
    expect(out.status).toBe('locked')
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
  })

  it('P1-1 回归:gate 长跑锁(10min,< TTL 60min)在场 → intake 必须让位,不夺锁不删锁', () => {
    writeAllowlist()
    const lockPayload = `${JSON.stringify({
      pid: 99999,
      owner: 'gate:full',
      token: 'gate-own-token',
      acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })}\n`
    writeFileSync(join(dir, 'gate.lock'), lockPayload)
    const out = runIntake(['report', ...reportArgs()])
    expect(out.status).toBe('locked')
    expect(out.holder.owner).toBe('gate:full')
    // 锁文件原样保留(未被夺取、未被 finally 误删)
    expect(readFileSync(join(dir, 'gate.lock'), 'utf8')).toBe(lockPayload)
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
  })

  it('P2-2 回归:同串超过 samples 容量(3)后,重放最早一条完全相同输入仍判 duplicate 零写入', () => {
    writeAllowlist()
    const msgs = ['bug 原始描述 A', '补充 B', '补充 C', '补充 D'] // 4 条,samples 只留最后 3 条
    msgs.forEach((m, i) =>
      runIntake(['report', ...reportArgs({ description: m, now: `2026-07-18T12:0${i}:00.000Z` })]),
    )
    const before = readFileSync(join(dir, 'state.json'), 'utf8')
    const replay = runIntake(['report', ...reportArgs({ description: msgs[0], now: '2026-07-18T12:09:00.000Z' })])
    expect(replay.kind).toBe('duplicate')
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before)
    const state = loadState(dir, FINGERPRINT_VERSION)
    const fp = state.intake.threads[KEY_A].fp
    expect(state.clusters[fp].count).toBe(4) // 重放没有 +1
  })
})

describe('queuePositionOf(与看板同源 activeClusters 口径)', () => {
  it('S0 排在人工 S1 之前;settled 簇不占位', () => {
    const state = defaultState(FINGERPRINT_VERSION)
    applyReport(state, { externalKey: KEY_A, reporter: REPORTER, description: 'bug 一号', level: 'error', screenshot: null, now: NOW })
    const humanFp = state.intake.threads[KEY_A].fp
    state.clusters['Persist::boom'] = {
      ...state.clusters[humanFp],
      origin: undefined,
      reporters: undefined,
      sLevel: 'S0',
      status: 'triaged',
      lastSeen: '2026-07-18T11:00:00.000Z',
    }
    state.clusters['Old::done'] = { ...state.clusters[humanFp], sLevel: 'S0', status: 'fixed' }
    const { position, queueSize } = queuePositionOf(state, humanFp)
    expect(queueSize).toBe(2)
    expect(position).toBe(2)
  })
})

describe('gate 兼容性(人工簇进流水线且不破坏幂等)', () => {
  const gateRun = (input) =>
    JSON.parse(
      execFileSync('node', [GATE, '--input', input, '--no-gh', '--state-dir', dir], { encoding: 'utf8' }).trim(),
    )

  const clustersOf = () => {
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    return JSON.stringify(state.clusters)
  }

  it('SC②:gate 重打分不覆盖人工簇 S1;人工簇进 workpacket;三连跑 clusters/workpacket 字节稳定', () => {
    writeAllowlist()
    const reported = runIntake(['report', ...reportArgs()])

    // 合成一条日志记录(非核心 error → S2),证明两类簇同流水线共存
    const fixture = join(dir, 'fixture.jsonl')
    writeFileSync(
      fixture,
      `${JSON.stringify({
        id: 'rec-1',
        level: 'error',
        source: 'Debug Panel',
        message: 'panel exploded 12345',
        clientId: 'client-1',
        appVersion: '0.0.0',
        receivedAt: '2026-07-18T12:30:00.000Z',
      })}\n`,
    )

    gateRun(fixture)
    const afterFirst = clustersOf()
    const wpAfterFirst = readFileSync(join(dir, 'workpacket.json'), 'utf8')

    const state = loadState(dir, FINGERPRINT_VERSION)
    expect(state.clusters[reported.fp].sLevel).toBe('S1') // 未被重算降级
    expect(state.clusters[reported.fp].origin).toBe(HUMAN_ORIGIN)

    const wp = JSON.parse(wpAfterFirst)
    const wpHuman = wp.clusters.find((c) => c.fp === reported.fp)
    expect(wpHuman).toBeTruthy() // 人工簇能被班车工作包消化
    expect(wpHuman.sLevel).toBe('S1')

    // 幂等三连:同输入重跑,clusters 与 workpacket 零 diff
    gateRun(fixture)
    expect(clustersOf()).toBe(afterFirst)
    expect(readFileSync(join(dir, 'workpacket.json'), 'utf8')).toBe(wpAfterFirst)
    gateRun(fixture)
    expect(clustersOf()).toBe(afterFirst)
    expect(readFileSync(join(dir, 'workpacket.json'), 'utf8')).toBe(wpAfterFirst)
  })
})

describe('P2-1 回归:同指纹生产 S0 信号不被人工 origin 保护遮蔽(两个顺序)', () => {
  const S0_MSG = 'write retry queue exhausted after 5 attempts'
  const gateRun = (input) =>
    execFileSync('node', [GATE, '--input', input, '--no-gh', '--state-dir', dir], { encoding: 'utf8' })
  const s0Fixture = () => {
    const fixture = join(dir, 'fx-s0.jsonl')
    writeFileSync(
      fixture,
      `${JSON.stringify({
        id: 'rec-s0',
        level: 'error',
        source: 'HumanReport', // 生产 source 恰与人工簇同名 → 同指纹碰撞场景
        message: S0_MSG,
        clientId: 'client-prod',
        appVersion: '0.0.0',
        receivedAt: '2026-07-18T12:30:00.000Z',
      })}\n`,
    )
    return fixture
  }

  it('顺序 A:人工先报 → 同指纹 silentFailure error 日志进来 → S0(origin 保护解除)', () => {
    writeAllowlist()
    const reported = runIntake(['report', ...reportArgs({ description: S0_MSG })])
    expect(reported.sLevel).toBe('S1')
    gateRun(s0Fixture())
    const state = loadState(dir, FINGERPRINT_VERSION)
    expect(Object.keys(state.clusters)).toHaveLength(1) // 同指纹并簇,没有分裂
    const cluster = state.clusters[reported.fp]
    expect(cluster.origin).toBeUndefined() // 保护已解除
    expect(cluster.sLevel).toBe('S0') // 真实日志判据接管
    expect(cluster.reporters).toEqual([REPORTER]) // 报单人关联保留
  })

  it('顺序 B:日志先 S0 → 人工再报同指纹 → merged 且 S0 保持', () => {
    writeAllowlist()
    gateRun(s0Fixture())
    const reported = runIntake(['report', ...reportArgs({ description: S0_MSG })])
    expect(reported.kind).toBe('merged')
    expect(reported.sLevel).toBe('S0') // 并入日志簇,不降级
    gateRun(s0Fixture()) // 再跑一轮 gate,确认人工样本不把 S0 拉回 S1
    const state = loadState(dir, FINGERPRINT_VERSION)
    expect(Object.keys(state.clusters)).toHaveLength(1)
    expect(state.clusters[reported.fp].sLevel).toBe('S0')
    expect(state.clusters[reported.fp].origin).toBeUndefined()
  })
})

describe('P2-3/P2-NEW 回归:status 降级契约(不伪装正常卡)', () => {
  it('损坏 JSON → status:"degraded",exit 0;输出不含任何队列/PR/健康分字段,并记入 logs.md', () => {
    writeFileSync(join(dir, 'state.json'), '{"schemaVersion":1,"fingerprintVersion":1,"clusters":{"a')
    const out = runIntake(['status', '--now', NOW])
    expect(out.status).toBe('degraded')
    expect(out.stateError).toBeTruthy()
    // 正常卡置信语义必须缺席:接单会话拿不到可套正常模板的数字
    expect(out.queue).toBeUndefined()
    expect(out.openPRCount).toBeUndefined()
    expect(out.healthScore).toBeUndefined()
    expect(out.lastRun).toBeUndefined()
    // "已记录"文案的兑现:降级事件落 logs.md
    expect(readFileSync(join(dir, 'logs.md'), 'utf8')).toContain('intake-status · degraded')
  })

  it('schema/fingerprint 版本不符是完整性错误,不降级照旧失败', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 99 }))
    expect(() => runIntake(['status', '--now', NOW])).toThrow()
  })
})

describe('status(T2-3,与看板同源)', () => {
  it('队列 P 编号=S 级一一映射;open PR/健康分/上轮班车取现成数据', () => {
    const state = defaultState(FINGERPRINT_VERSION)
    applyReport(state, { externalKey: KEY_A, reporter: REPORTER, description: 'bug 一号', level: 'error', screenshot: null, now: NOW })
    state.clusters['Persist::boom'] = { ...Object.values(state.clusters)[0], origin: undefined, sLevel: 'S0', status: 'triaged' }
    state.openPRs = [{ number: 281 }]
    const card = buildStatus({
      state,
      baseline: { healthScore: { value: 91.4 } },
      logsMd: '# x\n\n- 2026-07-18T02:30:00+08:00 · mode=full · 新记录 3 · 新簇 1 · 活跃簇 2 · S0 0 · 工作包 2 簇\n',
      now: NOW,
    })
    expect(card.queue).toMatchObject({ P0: 1, P1: 1, P2: 0, P3: 0, activeTotal: 2 })
    expect(card.queue.sMap).toEqual({ S0: 1, S1: 1, S2: 0, S3: 0 })
    expect(card.openPRCount).toBe(1)
    expect(card.healthScore).toBe(91.4)
    expect(card.lastRun).toMatchObject({ at: '2026-07-18T02:30:00+08:00', mode: 'full', workpacketClusters: 2 })
  })

  it('CLI:空状态目录也能出卡(容错空态,status:"ok" —— 台账为空≠台账不可读)', () => {
    const out = runIntake(['status', '--now', NOW])
    expect(out.status).toBe('ok')
    expect(out.queue).toMatchObject({ P0: 0, P1: 0, P2: 0, P3: 0 })
    expect(out.healthScore).toBeNull()
    expect(out.lastRun).toBeNull()
  })
})

describe('resolveDefaultStateDir(worktree 穿透)', () => {
  it('默认状态目录指向主 checkout 的 history/loops/bug-doctor(经 git common dir 反解,与脚本所在 worktree 无关)', () => {
    const resolved = resolveDefaultStateDir()
    expect(resolved.endsWith(join('history', 'loops', 'bug-doctor'))).toBe(true)
    // 在链接 worktree 里跑测试时,必须解析到主 checkout 根,而不是 worktree 根
    const mainRoot = resolved.replace(join('history', 'loops', 'bug-doctor'), '')
    expect(existsSync(join(mainRoot, '.git'))).toBe(true)
  })
})

describe('shortId', () => {
  it('稳定 8 位 hex(同指纹同号)', () => {
    const fp = fingerprintOf({ source: HUMAN_SOURCE, message: 'x' })
    expect(shortId(fp)).toBe(shortId(fp))
    expect(shortId(fp)).toMatch(/^[0-9a-f]{8}$/)
  })
})
