import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATE = join(__dirname, 'gate.mjs')

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bug-doctor-gate-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 固定时间基准的合成 JSONL(receivedAt 全落在同一 24h 窗内,打分确定性由游标基准保证)
const BASE = '2026-07-17T0'
const rec = (i, over = {}) => ({
  id: `rec-${i}`,
  level: 'error',
  source: 'Write Retry Queue',
  message: `write ${i}0000000-0000-4000-8000-00000000000${i % 10} rejected by server: {"error":"unknown-project"}`,
  clientId: `client-${i}`,
  sessionId: 's',
  appVersion: '0.0.0',
  receivedAt: `${BASE}${i % 10}:00:00.000Z`,
  ...over,
})

const fixtureLines = [
  // 核心流程(持久化)error,3 个 distinct clientId,24h 内 → S0
  rec(1),
  rec(2),
  rec(3),
  // Persist Boot warn + HTTP 500(服务端故障、客户端有绕行)→ serverFault 升级 S1
  rec(4, { level: 'warning', source: 'Persist Boot', message: 'fetchCanvas content hydrate failed for canvas-78c5bed3-c018-402a-a37c-abb95f9a59db: ServerPersistAdapter HTTP 500 GET /api/canvas/x (content stays local)', clientId: 'client-a' }),
  rec(5, { level: 'warning', source: 'Persist Boot', message: 'fetchCanvas content hydrate failed for variants: ServerPersistAdapter HTTP 500 GET /api/canvas/variants (content stays local)', clientId: 'client-a' }),
  // 非核心 error → S2
  rec(6, { source: 'Console', message: 'Unhandled promise rejection: boom at line 42', clientId: 'client-b' }),
  // 核心流程 warn 单次、无服务端故障特征 → S3
  rec(7, { level: 'warning', source: 'Canvas Store', message: 'Hydration cleared 1 orphan projectId(s) (not in projects list)', clientId: 'client-c' }),
]

const writeFixture = (records) => {
  const path = join(dir, 'fixture.jsonl')
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`)
  return path
}

const runGate = (extraArgs = [], { expectFail = false } = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [GATE, '--no-gh', '--state-dir', dir, ...extraArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, summary: JSON.parse(stdout.trim().split('\n').at(-1)) }
  } catch (err) {
    if (!expectFail) throw err
    return { code: err.status, stderr: String(err.stderr || '') }
  }
}

describe('gate 端到端(fixture 驱动,零网络)', () => {
  it('聚类 + S 级判定:S0(核心 error 3 客户端)/S1(核心 warn+HTTP500)/S2(非核心 error)/S3', () => {
    const input = writeFixture(fixtureLines)
    const { summary } = runGate(['--input', input])
    expect(summary.status).toBe('workpacket')
    expect(summary.newRecords).toBe(7)

    const wp = JSON.parse(readFileSync(join(dir, 'workpacket.json'), 'utf8'))
    const byLevel = Object.fromEntries(wp.clusters.map((c) => [c.fp, c.sLevel]))
    const fps = Object.keys(byLevel)

    const wrq = fps.find((f) => f.startsWith('Write Retry Queue::'))
    const persistBootFps = fps.filter((f) => f.startsWith('Persist Boot::fetchCanvas'))
    const consoleFp = fps.find((f) => f.startsWith('Console::'))
    const canvasStore = fps.find((f) => f.startsWith('Canvas Store::'))

    expect(byLevel[wrq]).toBe('S0')
    expect(byLevel[consoleFp]).toBe('S2')
    expect(byLevel[canvasStore]).toBe('S3')

    // UUID 变量被剥离:3 条 unknown-project 聚成一簇,3 个 distinct clientId
    const wrqCluster = wp.clusters.find((c) => c.fp === wrq)
    expect(wrqCluster.count).toBe(3)
    expect(wrqCluster.distinctClients24h).toBe(3)
    // Persist Boot 两条按 canvas slug 分簇(fpv:1 只剥 UUID/hex/数字/引号路径/query,
    // 裸 slug 与语义词不可通用区分,细化归进化轮),但每簇都命中 serverFault → S1
    expect(persistBootFps.length).toBe(2)
    for (const fp of persistBootFps) {
      expect(byLevel[fp]).toBe('S1')
      expect(wp.clusters.find((c) => c.fp === fp).serverFault).toBe(true)
    }
    // 工作包按 score 降序,S0 簇在首位
    expect(wp.clusters[0].fp).toBe(wrq)
    expect(wp.s0Alerts.some((a) => a.fp === wrq)).toBe(true)
  })

  it('幂等:同输入重跑,clusters 与 workpacket 零 diff(空转跳过)', () => {
    const input = writeFixture(fixtureLines)
    runGate(['--input', input])
    const clusters1 = JSON.stringify(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).clusters)
    const wp1 = readFileSync(join(dir, 'workpacket.json'), 'utf8')

    const { summary } = runGate(['--input', input])
    expect(summary.status).toBe('idle-skip')
    expect(summary.newRecords).toBe(0)
    const clusters2 = JSON.stringify(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).clusters)
    const wp2 = readFileSync(join(dir, 'workpacket.json'), 'utf8')
    expect(clusters2).toBe(clusters1)
    expect(wp2).toBe(wp1)
  })

  it('空增量:exit 0 + logs.md 记一行 + 游标不动', () => {
    const input = writeFixture([])
    const { code, summary } = runGate(['--input', input])
    expect(code).toBe(0)
    expect(summary.status).toBe('empty')
    expect(summary.newRecords).toBe(0)
    const logs = readFileSync(join(dir, 'logs.md'), 'utf8')
    expect(logs.trim().split('\n').filter((l) => l.startsWith('- ')).length).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).cursor).toBe('')
  })

  it('--s0-only:工作包只含 S0 簇(轻巡模式)', () => {
    const input = writeFixture(fixtureLines)
    const { summary } = runGate(['--input', input, '--s0-only'])
    expect(summary.s0).toBe(1)
    const wp = JSON.parse(readFileSync(join(dir, 'workpacket.json'), 'utf8'))
    expect(wp.mode).toBe('s0-only')
    expect(wp.clusters).toHaveLength(1)
    expect(wp.clusters[0].sLevel).toBe('S0')
    // 轻巡不计入工作轮
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).runCount).toBe(0)
  })

  it('锁被占(未过期)时第二实例立即退出且不动台账', () => {
    writeFileSync(join(dir, 'gate.lock'), JSON.stringify({ pid: 99999, owner: 'gate:full', acquiredAt: new Date().toISOString() }))
    const input = writeFixture(fixtureLines)
    const { code, summary } = runGate(['--input', input])
    expect(code).toBe(0)
    expect(summary.status).toBe('locked')
    expect(() => readFileSync(join(dir, 'state.json'))).toThrow()
  })

  it('失败路径:输入不可读 → exit 1 + consecutiveGateFailures 累计 + 锁释放', () => {
    const r1 = runGate(['--input', join(dir, 'missing.jsonl')], { expectFail: true })
    expect(r1.code).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).consecutiveGateFailures).toBe(1)
    const r2 = runGate(['--input', join(dir, 'missing.jsonl')], { expectFail: true })
    expect(r2.code).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).consecutiveGateFailures).toBe(2)
    // 失败后锁已释放,正常输入可继续跑
    const input = writeFixture(fixtureLines)
    const { summary } = runGate(['--input', input])
    expect(summary.status).toBe('workpacket')
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).consecutiveGateFailures).toBe(0)
  })
})
