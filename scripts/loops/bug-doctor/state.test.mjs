import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LOCK_FILE,
  STATE_SCHEMA_VERSION,
  acquireLock,
  appendLedger,
  appendLog,
  defaultState,
  loadState,
  releaseLock,
  saveState,
} from './state.mjs'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bug-doctor-state-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('state.json 读写', () => {
  it('无文件时返回 v1 默认骨架', () => {
    const s = loadState(dir, 1)
    expect(s.schemaVersion).toBe(STATE_SCHEMA_VERSION)
    expect(s.fingerprintVersion).toBe(1)
    expect(s.cursor).toBe('')
    expect(s.clusters).toEqual({})
    expect(s.runCount).toBe(0)
    expect(s.consecutiveGateFailures).toBe(0)
  })

  it('保存后可回读,且 clusters/数组稳定排序(字节级幂等)', () => {
    const s = defaultState(1)
    s.clusters['b::x'] = { source: 'b', pattern: 'x', sLevel: 'S3', tCap: 'T2', count: 1, clients: ['z', 'a'], firstSeen: 't1', lastSeen: 't1', appVersions: ['2', '1'], status: 'new', attempts: 0, issue: null, pr: null, levels: ['warning', 'error'], recent: [{ t: 't2', c: 'b' }, { t: 't1', c: 'a' }], samples: [] }
    s.clusters['a::y'] = { source: 'a', pattern: 'y', sLevel: 'S3', tCap: 'T2', count: 1, clients: [], firstSeen: 't1', lastSeen: 't1', appVersions: [], status: 'new', attempts: 0, issue: null, pr: null, levels: [], recent: [], samples: [] }
    saveState(dir, s)
    const raw1 = readFileSync(join(dir, 'state.json'), 'utf8')
    saveState(dir, loadState(dir, 1))
    const raw2 = readFileSync(join(dir, 'state.json'), 'utf8')
    expect(raw2).toBe(raw1)
    expect(Object.keys(JSON.parse(raw1).clusters)).toEqual(['a::y', 'b::x'])
    expect(JSON.parse(raw1).clusters['b::x'].clients).toEqual(['a', 'z'])
  })

  it('fingerprintVersion 不符时拒绝混写台账', () => {
    saveState(dir, defaultState(1))
    expect(() => loadState(dir, 2)).toThrow(/fingerprintVersion/)
  })

  it('schemaVersion 不符时拒绝静默覆盖', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 99 }))
    expect(() => loadState(dir, 1)).toThrow(/schemaVersion/)
  })
})

describe('互斥锁(TTL 60min)', () => {
  it('首取成功;二取(未过期)失败并返回持有者', () => {
    expect(acquireLock(dir, { ttlMinutes: 60, owner: 'gate:full' }).acquired).toBe(true)
    const second = acquireLock(dir, { ttlMinutes: 60, owner: 'gate:s0-only' })
    expect(second.acquired).toBe(false)
    expect(second.holder.owner).toBe('gate:full')
  })

  it('过期陈锁被接管(防上一实例崩溃后永久自锁)', () => {
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 1, owner: 'dead', acquiredAt: '2020-01-01T00:00:00.000Z' }))
    const took = acquireLock(dir, { ttlMinutes: 60, owner: 'gate:full' })
    expect(took.acquired).toBe(true)
    expect(took.stale).toBe(true)
  })

  it('释放后可再取;重复释放不抛错', () => {
    acquireLock(dir, { ttlMinutes: 60, owner: 'a' })
    releaseLock(dir)
    releaseLock(dir)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
    expect(acquireLock(dir, { ttlMinutes: 60, owner: 'b' }).acquired).toBe(true)
  })
})

describe('ledger.csv / logs.md 只增', () => {
  it('首写带表头,追加不重复表头', () => {
    appendLedger(dir, { runAt: 't1', mode: 'full', newRecords: 3, newClusters: 1, activeClusters: 1, s0: 0, workpacketClusters: 1, cost: 0 })
    appendLedger(dir, { runAt: 't2', mode: 's0-only', newRecords: 0, newClusters: 0, activeClusters: 1, s0: 0, workpacketClusters: 0, cost: 0 })
    const lines = readFileSync(join(dir, 'ledger.csv'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^runAt,/)
    expect(lines[2]).toBe('t2,s0-only,0,0,1,0,0,0')
  })

  it('logs.md 每轮一行只增', () => {
    appendLog(dir, 'line-1')
    appendLog(dir, 'line-2')
    const content = readFileSync(join(dir, 'logs.md'), 'utf8')
    expect(content).toContain('- line-1\n- line-2\n')
  })
})
