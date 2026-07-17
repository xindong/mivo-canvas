// state.mjs — bug-doctor 运行时状态(state.json / ledger.csv / logs.md / 互斥锁)
//
// 状态目录默认 <repoRoot>/history/loops/bug-doctor/(不入 git),可用
// MIVO_BUG_DOCTOR_STATE_DIR 或 --state-dir 覆盖(测试与多 checkout 场景)。
// state.json v1 schema 见 docs/plan/bug-doctor-execution-plan.md Phase 1;
// 在其上追加实现所需字段(lock 文件独立、processedIds、hourly、digest),
// 均为增量字段,不改动既定字段语义。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_SCHEMA_VERSION = 1

export const STATE_FILE = 'state.json'
export const LEDGER_FILE = 'ledger.csv'
export const LOGS_FILE = 'logs.md'
export const WORKPACKET_FILE = 'workpacket.json'
export const LOCK_FILE = 'gate.lock'

const LEDGER_HEADER = 'runAt,mode,newRecords,newClusters,activeClusters,s0,workpacketClusters,cost\n'

/** 初始 state(schema v1)。 */
export const defaultState = (fingerprintVersion) => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  fingerprintVersion,
  cursor: '',
  clusters: {},
  openPRs: [],
  runCount: 0,
  consecutiveGateFailures: 0,
  // ---- 以下为 v1 增量实现字段 ----
  // 已消费记录 id(防 gap-check 扩窗/游标重置时重复计数;按 receivedAt 剪枝到 7 天保留窗)
  processedIds: {},
  // 空转检测:上次工作包指纹摘要 + 上次实际产出时刻(6h 心跳强制放行)
  lastWorkpacketDigest: '',
  lastEmittedAt: '',
  lastRunAt: '',
})

export const ensureStateDir = (stateDir) => {
  mkdirSync(stateDir, { recursive: true })
}

export const loadState = (stateDir, fingerprintVersion) => {
  const path = join(stateDir, STATE_FILE)
  if (!existsSync(path)) return defaultState(fingerprintVersion)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`state.json schemaVersion=${parsed.schemaVersion} 与当前 ${STATE_SCHEMA_VERSION} 不符,需迁移(拒绝静默覆盖)`)
  }
  if (parsed.fingerprintVersion !== fingerprintVersion) {
    throw new Error(
      `state.json fingerprintVersion=${parsed.fingerprintVersion} 与当前算法 ${fingerprintVersion} 不符;` +
        '升版需按计划走新旧指纹双写过渡,拒绝直接混写台账',
    )
  }
  // 补齐增量字段(向后兼容旧骨架)
  return { ...defaultState(fingerprintVersion), ...parsed }
}

// 序列化时对 clusters/数组做稳定排序,保证同输入重跑输出字节级一致(幂等 SC)
const stableState = (state) => {
  const clusters = {}
  for (const fp of Object.keys(state.clusters).sort()) {
    const c = state.clusters[fp]
    clusters[fp] = {
      ...c,
      clients: [...c.clients].sort(),
      appVersions: [...c.appVersions].sort(),
      levels: [...(c.levels || [])].sort(),
      // recent:48h 内 (receivedAt, clientId) 明细,供 24h 窗口打分;按 (t,c) 稳定排序
      recent: [...(c.recent || [])].sort((a, b) => (a.t === b.t ? (a.c < b.c ? -1 : 1) : a.t < b.t ? -1 : 1)),
      samples: [...(c.samples || [])].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1)),
    }
  }
  const processedIds = Object.fromEntries(
    Object.entries(state.processedIds || {}).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  return { ...state, clusters, processedIds }
}

export const saveState = (stateDir, state) => {
  ensureStateDir(stateDir)
  writeFileSync(join(stateDir, STATE_FILE), `${JSON.stringify(stableState(state), null, 2)}\n`)
}

export const appendLedger = (stateDir, row) => {
  ensureStateDir(stateDir)
  const path = join(stateDir, LEDGER_FILE)
  if (!existsSync(path)) writeFileSync(path, LEDGER_HEADER)
  const line = [row.runAt, row.mode, row.newRecords, row.newClusters, row.activeClusters, row.s0, row.workpacketClusters, row.cost ?? 0].join(',')
  appendFileSync(path, `${line}\n`)
}

export const appendLog = (stateDir, line) => {
  ensureStateDir(stateDir)
  const path = join(stateDir, LOGS_FILE)
  if (!existsSync(path)) {
    writeFileSync(path, '# bug-doctor logs(只增,每轮一行;零也记)\n\n')
  }
  appendFileSync(path, `- ${line}\n`)
}

// ---- 互斥锁(gate/主轮/补轮共用;文件级 O_EXCL 原子创建 + TTL 自愈) ----

/**
 * 尝试取锁。成功 → { acquired: true };
 * 已被持有且未过期 → { acquired: false, holder };
 * 过期(> ttlMinutes)→ 视为陈锁,接管并返回 { acquired: true, stale: true }。
 */
export const acquireLock = (stateDir, { ttlMinutes, owner }) => {
  ensureStateDir(stateDir)
  const path = join(stateDir, LOCK_FILE)
  const payload = `${JSON.stringify({ pid: process.pid, owner, acquiredAt: new Date().toISOString() })}\n`
  try {
    writeFileSync(path, payload, { flag: 'wx' })
    return { acquired: true }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  let holder = null
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    holder = null
  }
  const age = holder?.acquiredAt ? Date.now() - Date.parse(holder.acquiredAt) : Number.POSITIVE_INFINITY
  if (age > ttlMinutes * 60_000) {
    // 陈锁(上一实例崩溃未清):接管。方向性:宁可接管跑一轮,不永久自锁。
    writeFileSync(path, payload)
    return { acquired: true, stale: true, previousHolder: holder }
  }
  return { acquired: false, holder }
}

export const releaseLock = (stateDir) => {
  try {
    unlinkSync(join(stateDir, LOCK_FILE))
  } catch {
    /* 已不存在即目的达成 */
  }
}
