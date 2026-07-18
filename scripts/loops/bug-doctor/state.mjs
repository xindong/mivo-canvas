// state.mjs — bug-doctor 运行时状态(state.json / ledger.csv / logs.md / 互斥锁)
//
// 状态目录默认 <repoRoot>/history/loops/bug-doctor/(不入 git),可用
// MIVO_BUG_DOCTOR_STATE_DIR 或 --state-dir 覆盖(测试与多 checkout 场景)。
// state.json v1 schema 见 docs/plan/bug-doctor-execution-plan.md Phase 1;
// 在其上追加实现所需字段(lock 文件独立、processedIds、hourly、digest),
// 均为增量字段,不改动既定字段语义。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync, renameSync, statSync } from 'node:fs'
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
  // 原子替换:先写 tmp 再 rename(同目录同文件系统),并发读方(status/看板)
  // 永远只会看到完整的旧版或完整的新版,不会读到半写 JSON
  const path = join(stateDir, STATE_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(stableState(state), null, 2)}\n`)
  renameSync(tmp, path)
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

// recovery guard 自身的失效窗:接管流程本身是毫秒级,guard 存活超过 60s
// 说明上一个接管者也崩了,允许清掉 guard(下一次调用重新竞争)
const RECOVERY_GUARD_TTL_MS = 60_000

/**
 * 尝试取锁。成功 → { acquired: true, token };
 * 已被持有且未过期 → { acquired: false, holder };
 * 过期(> ttlMinutes)→ 经 recovery guard(第二把 O_EXCL)仲裁接管,
 * 恰一方成功:{ acquired: true, stale: true, token },其余 { acquired: false }。
 * token 是本次持有凭证,释放时传回 releaseLock 做归属校验(只删自己的锁)。
 *
 * 原子性要点(审查 P1-NEW):O_EXCL 只保证目录项原子,payload 落盘前文件已
 * 可见——所以 EEXIST 后锁文件"不可解析/缺 acquiredAt"不能当陈锁(很可能是
 * 对方刚创建还没写完),此时按文件 mtime 保守判:TTL 内一律视为有人持有。
 * 陈锁接管的 判定→替换 不再是裸 read-modify-write,而是先 O_EXCL 拿 guard,
 * guard 内 re-read 确认仍陈旧后 unlink + O_EXCL 重建,双竞争者只有一方赢。
 */
export const acquireLock = (stateDir, { ttlMinutes, owner }) => {
  ensureStateDir(stateDir)
  const path = join(stateDir, LOCK_FILE)
  const ttlMs = ttlMinutes * 60_000
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const payload = `${JSON.stringify({ pid: process.pid, owner, token, acquiredAt: new Date().toISOString() })}\n`

  try {
    writeFileSync(path, payload, { flag: 'wx' })
    return { acquired: true, token }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }

  // 锁文件年龄:能解析用 acquiredAt;不可解析/缺字段(半写/损坏)退到 mtime。
  // 两者都拿不到(文件在读取瞬间消失 = 对方刚释放)→ 保守按"有人持有"返回,
  // 下一次调用自然重试首路径。
  const lockAgeMs = () => {
    let holder = null
    try {
      holder = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      holder = null
    }
    if (holder?.acquiredAt) {
      const parsed = Date.parse(holder.acquiredAt)
      if (Number.isFinite(parsed)) return { holder, ageMs: Date.now() - parsed }
    }
    try {
      return { holder, ageMs: Date.now() - statSync(path).mtimeMs }
    } catch {
      return { holder, ageMs: null }
    }
  }

  const first = lockAgeMs()
  if (first.ageMs === null || first.ageMs <= ttlMs) {
    return { acquired: false, holder: first.holder }
  }

  // ---- 陈锁接管仲裁(第二把 O_EXCL)----
  const guard = `${path}.recovery`
  try {
    writeFileSync(guard, payload, { flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    // guard 被别的接管者持有:若 guard 自身也陈旧(接管者崩了)清掉自愈,
    // 本轮仍返回未取到(下一次调用重新竞争),绝不双接管
    try {
      if (Date.now() - statSync(guard).mtimeMs > RECOVERY_GUARD_TTL_MS) unlinkSync(guard)
    } catch {
      /* guard 已消失即无需清理 */
    }
    return { acquired: false, holder: first.holder, recovery: 'in-progress' }
  }
  try {
    // guard 内 re-read:确认仍陈旧(期间可能已被正常释放、或他人释放后重取)
    const again = lockAgeMs()
    if (again.ageMs !== null && again.ageMs <= ttlMs) {
      return { acquired: false, holder: again.holder }
    }
    try {
      unlinkSync(path)
    } catch {
      /* 已消失即目的达成 */
    }
    try {
      writeFileSync(path, payload, { flag: 'wx' })
    } catch (err) {
      if (err.code === 'EEXIST') {
        // unlink→create 空窗被首路径新来者抢先:对方是合法新持有者,让位
        return { acquired: false, holder: null, recovery: 'lost-race' }
      }
      throw err
    }
    return { acquired: true, stale: true, previousHolder: first.holder, token }
  } finally {
    try {
      unlinkSync(guard)
    } catch {
      /* guard 已消失即目的达成 */
    }
  }
}

/**
 * 释放锁。传 token 时做归属校验:锁文件不是本 token 持有(已被 TTL 接管/他人重取)
 * → 不删他人的锁,返回 false。不传 token 保持旧语义(无条件删,gate 崩溃恢复用)。
 */
export const releaseLock = (stateDir, { token } = {}) => {
  const path = join(stateDir, LOCK_FILE)
  if (token) {
    let holder = null
    try {
      holder = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return false // 文件不存在/不可读:无从确认归属,保守不动(陈锁由 TTL 自愈)
    }
    if (holder?.token !== token) return false
  }
  try {
    unlinkSync(path)
    return true
  } catch {
    return true /* 已不存在即目的达成 */
  }
}
