// state.mjs — bug-doctor 运行时状态(state.json / ledger.csv / logs.md / 互斥锁)
//
// 状态目录默认 <repoRoot>/history/loops/bug-doctor/(不入 git),可用
// MIVO_BUG_DOCTOR_STATE_DIR 或 --state-dir 覆盖(测试与多 checkout 场景)。
// state.json v1 schema 见 docs/plan/bug-doctor-execution-plan.md Phase 1;
// 在其上追加实现所需字段(lock 文件独立、processedIds、hourly、digest),
// 均为增量字段,不改动既定字段语义。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync, renameSync, statSync, readdirSync } from 'node:fs'
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

// 孤儿 .reap 残骸清扫阈:收尸流程本身是毫秒级,.reap 文件存活超过 60s 说明
// 收尸者在 rename 与清理之间崩了——该文件只是死尸副本(不是锁),按龄清除
const REAP_ORPHAN_TTL_MS = 60_000

// 文本是否为"新鲜活锁"payload(可解析且 acquiredAt 在 TTL 内)
const isFreshLockPayload = (text, ttlMs) => {
  try {
    const t = Date.parse(JSON.parse(text)?.acquiredAt)
    return Number.isFinite(t) && Date.now() - t <= ttlMs
  } catch {
    return false
  }
}

// 清扫超龄孤儿 .reap 残骸(只在走到陈锁路径时调用,常规路径零开销)
const sweepOrphanReaps = (stateDir) => {
  let names = []
  try {
    names = readdirSync(stateDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(`${LOCK_FILE}.reap.`)) continue
    const p = join(stateDir, name)
    try {
      if (Date.now() - statSync(p).mtimeMs > REAP_ORPHAN_TTL_MS) unlinkSync(p)
    } catch {
      /* 已消失/读不到即跳过 */
    }
  }
}

/**
 * 陈锁收尸(原子 rename 协议;导出仅供回归测试注入交错时序):
 * rename(lock → lock.reap.<自己的token>) 同一源路径只有一个赢家——输家 ENOENT
 * 让位,天然杜绝双接管;.reap 目标名含自己的 token,是私有文件,后续 unlink
 * 无 TOCTOU。锁与 .reap 同目录(同一文件系统),rename 不跨 fs 不退化。
 *
 * 验尸比对:陈旧判定与 rename 之间存在微窗——尸体可能已被别的收尸者收走并
 * 换上新锁,此时 rename 收到的是别人的活锁。用判定时刻的字节快照比对收到的
 * 文件:不符 = 错收活锁 → 原位放回(空窗内无人建新锁时)并让位;若放回瞬间
 * 已有新持有者建锁,则不覆盖对方,错收文件降级为孤儿副本删除。
 * (残余窗口如实声明:三方在微秒级窗口内连环交错时,被错收又无法放回的
 * 原持有者会丢锁——概率量级远低于被替换的 guard 方案 60s 窗,且 state 写入
 * 已是原子 rename,最坏后果是单轮更新丢失,不会损坏台账结构。)
 *
 * snapshotRaw = 判定时读到的原始字节(半写/损坏锁给 null,此时以"收到的
 * 文件不是新鲜活锁"为验尸判据)。
 */
export const reapStaleLock = (stateDir, { snapshotRaw, ttlMs, token }) => {
  const path = join(stateDir, LOCK_FILE)
  const reap = `${path}.reap.${token}`
  try {
    renameSync(path, reap)
  } catch (err) {
    if (err.code === 'ENOENT') return { reaped: false, reason: 'lost-race' }
    throw err
  }
  let corpse = null
  try {
    corpse = readFileSync(reap, 'utf8')
  } catch {
    corpse = null
  }
  const isJudgedCorpse = snapshotRaw !== null ? corpse === snapshotRaw : !isFreshLockPayload(corpse, ttlMs)
  if (!isJudgedCorpse) {
    // 错收了别人的活锁:优先原位放回;放回目标已被新持有者占用则不覆盖,
    // 错收文件只是副本,删除即可(真相在 path 上的新锁)
    try {
      if (!existsSync(path)) {
        renameSync(reap, path)
        return { reaped: false, reason: 'misreap-restored' }
      }
    } catch {
      /* 放回失败走删除分支 */
    }
    try {
      unlinkSync(reap)
    } catch {
      /* 留作孤儿由 sweepOrphanReaps 清 */
    }
    return { reaped: false, reason: 'misreap' }
  }
  try {
    unlinkSync(reap)
  } catch {
    /* 私有残骸,超龄清扫兜底 */
  }
  return { reaped: true }
}

/**
 * 尝试取锁。成功 → { acquired: true, token };
 * 已被持有且未过期 → { acquired: false, holder };
 * 过期(> ttlMinutes)→ 经原子 rename 收尸接管,恰一方成功:
 * { acquired: true, stale: true, token },其余 { acquired: false }。
 * token 是本次持有凭证,释放时传回 releaseLock 做归属校验(只删自己的锁)。
 *
 * 原子性要点(审查 P1-NEW):O_EXCL 只保证目录项原子,payload 落盘前文件已
 * 可见——所以 EEXIST 后锁文件"不可解析/缺 acquiredAt"不能当陈锁(很可能是
 * 对方刚创建还没写完),此时按文件 mtime 保守判:TTL 内一律视为有人持有。
 * 陈锁接管协议见 reapStaleLock(三轮审查后由 recovery guard 换为原子 rename,
 * 消除 guard 清理的 TOCTOU)。
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
  // 下一次调用自然重试首路径。raw 为判定时刻的字节快照,供收尸验尸比对。
  let holder = null
  let raw = null
  try {
    raw = readFileSync(path, 'utf8')
    holder = JSON.parse(raw)
  } catch {
    holder = null
  }
  let ageMs = null
  if (holder?.acquiredAt && Number.isFinite(Date.parse(holder.acquiredAt))) {
    ageMs = Date.now() - Date.parse(holder.acquiredAt)
  } else {
    try {
      ageMs = Date.now() - statSync(path).mtimeMs
    } catch {
      ageMs = null
    }
  }
  if (ageMs === null || ageMs <= ttlMs) {
    return { acquired: false, holder }
  }

  // ---- 陈锁接管(原子 rename 收尸,恰一赢家)----
  sweepOrphanReaps(stateDir)
  const reapResult = reapStaleLock(stateDir, { snapshotRaw: raw, ttlMs, token })
  if (!reapResult.reaped) {
    return { acquired: false, holder, recovery: reapResult.reason }
  }
  try {
    writeFileSync(path, payload, { flag: 'wx' })
  } catch (err) {
    if (err.code === 'EEXIST') {
      // 收尸后、建锁前的空窗被首路径新来者抢先:对方是合法新持有者,让位
      return { acquired: false, holder: null, recovery: 'lost-race' }
    }
    throw err
  }
  return { acquired: true, stale: true, previousHolder: holder, token }
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
