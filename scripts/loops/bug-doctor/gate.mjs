#!/usr/bin/env node
// gate.mjs — bug-doctor 发现层入口(确定性脚本,零 LLM)
//
// 每个工作轮第一步:拉四路信号 → 指纹聚类 → 打分定 S 级 → 对照台账过滤 →
// 产出 workpacket.json;空 → 记日志秒退(exit 0)。契约见 docs/loops/bug-doctor.md,
// 打分/S级/禁区规则单一真相源 scripts/loops/bug-doctor/rules.json。
//
// 结构照 scripts/changelog/auto-changelog.mjs 零依赖模式:Node 内置 + ssh/gh CLI。
//
// 信号源:
//   ① 生产 debug log:SSH **只读** cat JSONL(增量按记录 id 去重 + receivedAt 游标)
//   ② react 基线 diff:T3 产物 react-baseline.json(本轮留接口,缺失记 skipped)
//   ③ nightly-e2e:gh run list 最近一次结论,红灯 = S0 信号
//   ④ verify:logging:T-后续接入,留接口(默认 skipped)
//
// 用法:
//   node scripts/loops/bug-doctor/gate.mjs [--s0-only] [--input <jsonl>] [--no-gh]
//        [--state-dir <dir>] [--json-out <path>]
//
// 生产安全:对生产服务器仅执行 `ssh <host> 'cat <glob>'`(只读);本脚本不含任何
// 远端写命令。所有台账写操作幂等(同输入重跑 → clusters/workpacket 零 diff)。
//
// 退出码:0=成功(含空跑/锁被占/空转跳过);1=失败(累计 consecutiveGateFailures,
// 连续 ≥3 由轻巡告警"loop 失明");2=用法错误。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { FINGERPRINT_VERSION, fingerprintOf, normalizeMessage } from './fingerprint.mjs'
import {
  WORKPACKET_FILE,
  acquireLock,
  appendLedger,
  appendLog,
  loadState,
  releaseLock,
  saveState,
} from './state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const RULES_PATH = join(__dirname, 'rules.json')

const SSH_HOST = process.env.MIVO_BUG_DOCTOR_SSH_HOST || 'zhuzan@10.102.80.15'
const SSH_LOG_GLOB = process.env.MIVO_BUG_DOCTOR_LOG_GLOB || '/AIGC_Group/mivo-canvas/data/debug-logs/*.jsonl'
const NIGHTLY_WORKFLOW = process.env.MIVO_BUG_DOCTOR_NIGHTLY_WORKFLOW || 'nightly-e2e'
const RETENTION_DAYS = 7
const RECENT_WINDOW_HOURS = 48
const MAX_SAMPLES_PER_CLUSTER = 3

// 台账里视为"已处理"的簇状态:不进工作包(known-noise 由进化轮沉淀)
const SETTLED_STATUSES = new Set(['fixed', 'issue-filed', 'known-noise'])
const HOUR_MS = 3_600_000

// ---- 基础工具 ----

const parseArgs = (argv) => {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
          out[a.slice(2)] = true
        } else {
          out[a.slice(2)] = next
          i += 1
        }
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

const log = (msg) => process.stderr.write(`[bug-doctor:gate] ${msg}\n`)

const localNowIso = () => {
  const now = new Date()
  const pad2 = (n) => String(n).padStart(2, '0')
  const off = -now.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

const loadRules = () => {
  const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'))
  if (rules.version !== 1) throw new Error(`rules.json version=${rules.version} 不支持(当前实现 v1)`)
  return rules
}

const compilePatterns = (patterns) => (patterns || []).map((p) => new RegExp(p, 'i'))
const matchesAny = (res, text) => res.some((re) => re.test(text))

// ---- 信号源① 生产 debug log ----

// 生产只读铁律:仅 cat,glob 由服务端 shell 展开;本进程对远端不执行任何写命令。
const fetchProductionRecords = () => {
  const command = `cat ${SSH_LOG_GLOB}`
  log(`SSH 只读拉数: ssh ${SSH_HOST} '${command}'`)
  const raw = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', SSH_HOST, command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseJsonlRecords(raw)
}

const parseJsonlRecords = (raw) => {
  const records = []
  let malformed = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec && typeof rec === 'object' && rec.receivedAt) records.push(rec)
      else malformed += 1
    } catch {
      malformed += 1
    }
  }
  if (malformed > 0) log(`警告:${malformed} 行 JSONL 解析失败,已跳过(fail-open:不因脏行整轮失败)`)
  records.sort((a, b) => (a.receivedAt === b.receivedAt ? 0 : a.receivedAt < b.receivedAt ? -1 : 1))
  return records
}

// 记录去重 key:服务端 id 全局唯一;老记录无 id 时降级组合键
const recordKey = (rec) => rec.id || `${rec.receivedAt}|${rec.clientId || ''}|${createHash('sha256').update(String(rec.message || '')).digest('hex').slice(0, 12)}`

// ---- 信号源③ nightly-e2e ----

const fetchNightlySignal = () => {
  try {
    const out = execFileSync(
      'gh',
      ['run', 'list', '--workflow', NIGHTLY_WORKFLOW, '-L', '1', '--json', 'conclusion,status,url,createdAt'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const runs = JSON.parse(out)
    if (!Array.isArray(runs) || runs.length === 0) return { status: 'no-runs' }
    const run = runs[0]
    const red = run.status === 'completed' && !['success', 'neutral', 'skipped'].includes(run.conclusion)
    return { status: 'ok', conclusion: run.conclusion, runStatus: run.status, url: run.url, createdAt: run.createdAt, red }
  } catch (err) {
    // fail-open 方向:gh 查询失败不整轮失败,但在工作包里如实标注 degraded
    log(`警告:gh run list 失败(${err.message.split('\n')[0]}),nightly 信号降级`)
    return { status: 'degraded' }
  }
}

// ---- 聚类与打分 ----

const upsertRecord = (state, rec, flags) => {
  const fp = fingerprintOf(rec)
  let cluster = state.clusters[fp]
  const isNew = !cluster
  if (!cluster) {
    cluster = {
      source: String(rec.source || 'Unknown'),
      pattern: normalizeMessage(rec.message),
      sLevel: 'S3', // 每轮由 scoreClusters 重算;初值最低档
      tCap: 'T2', // gate 不看 diff 文件集,一律先按默认档 T2;分诊裁定最终 T 级
      count: 0,
      clients: [],
      firstSeen: rec.receivedAt,
      lastSeen: rec.receivedAt,
      appVersions: [],
      status: 'new',
      attempts: 0,
      issue: null,
      pr: null,
      levels: [],
      serverFault: false,
      silentFailure: false,
      recent: [],
      samples: [],
    }
    state.clusters[fp] = cluster
  }
  // 生产日志记录并入人工报告簇(同指纹碰撞,如 source 恰为 HumanReport):
  // 解除 origin 保护,让真实日志判据接管 S 级(否则 silentFailure/S0 会被
  // 人工候诊 S1 压住)。人工报告不自动高于日志信号,反之亦然。
  if (!isNew && cluster.origin === 'human-report') delete cluster.origin
  cluster.count += 1
  if (rec.receivedAt < cluster.firstSeen) cluster.firstSeen = rec.receivedAt
  if (rec.receivedAt > cluster.lastSeen) cluster.lastSeen = rec.receivedAt
  if (rec.clientId && !cluster.clients.includes(rec.clientId)) cluster.clients.push(rec.clientId)
  if (rec.appVersion && !cluster.appVersions.includes(rec.appVersion)) cluster.appVersions.push(rec.appVersion)
  if (rec.level && !cluster.levels.includes(rec.level)) cluster.levels.push(rec.level)
  if (flags.serverFault) cluster.serverFault = true
  if (flags.silentFailure) cluster.silentFailure = true
  cluster.recent.push({ t: rec.receivedAt, c: rec.clientId || 'unknown' })
  cluster.samples.push(rec)
  cluster.samples.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1))
  if (cluster.samples.length > MAX_SAMPLES_PER_CLUSTER) {
    cluster.samples = cluster.samples.slice(-MAX_SAMPLES_PER_CLUSTER)
  }
  return isNew
}

// 参考时刻 = 全量数据最大 receivedAt(不用挂钟,保证同输入重跑打分确定性)
const pruneWindows = (state, refNowMs) => {
  const recentCutoff = refNowMs - RECENT_WINDOW_HOURS * HOUR_MS
  for (const cluster of Object.values(state.clusters)) {
    cluster.recent = (cluster.recent || []).filter((e) => Date.parse(e.t) > recentCutoff)
  }
  const retentionCutoff = refNowMs - RETENTION_DAYS * 24 * HOUR_MS
  for (const [key, receivedAt] of Object.entries(state.processedIds)) {
    if (Date.parse(receivedAt) <= retentionCutoff) delete state.processedIds[key]
  }
}

const windowStats = (cluster, refNowMs) => {
  const cutoff24h = refNowMs - 24 * HOUR_MS
  const cutoff48h = refNowMs - 48 * HOUR_MS
  let count24h = 0
  let prev24h = 0
  const clients24h = new Set()
  for (const entry of cluster.recent || []) {
    const t = Date.parse(entry.t)
    if (t > cutoff24h) {
      count24h += 1
      clients24h.add(entry.c)
    } else if (t > cutoff48h) {
      prev24h += 1
    }
  }
  return { count24h, prev24h, distinctClients24h: clients24h.size }
}

const buildProcessMatchers = (rules) =>
  rules.coreProcesses.map((proc) => ({ id: proc.id, label: proc.label, res: compilePatterns(proc.sourcePatterns) }))

const coreProcessOf = (matchers, source) => {
  for (const m of matchers) {
    if (matchesAny(m.res, source)) return m
  }
  return null
}

/**
 * 对全部簇重算 score 与 sLevel(纯函数式重算,不看挂钟)。
 * score = levelWeight × min(distinctClients, cap) × processWeight × freshness × growth
 */
const scoreClusters = (state, rules, refNowMs) => {
  const matchers = buildProcessMatchers(rules)
  const scoring = rules.scoring
  const s0 = rules.sLevels.s0
  const repeatThreshold = rules.sLevels.s2.repeatThreshold

  // 新鲜度基准:全台账观察到的"最新有效 appVersion"(0.0.0/unknown 忽略,T2 注入后生效)
  const ignored = new Set(scoring.ignoredAppVersions)
  const versions = new Set()
  for (const c of Object.values(state.clusters)) {
    for (const v of c.appVersions) if (!ignored.has(v)) versions.add(v)
  }
  const latestVersion = [...versions].sort().at(-1) || null

  const scored = {}
  for (const [fp, cluster] of Object.entries(state.clusters)) {
    const proc = coreProcessOf(matchers, cluster.source)
    const isError = cluster.levels.includes('error')
    const { count24h, prev24h, distinctClients24h } = windowStats(cluster, refNowMs)

    const levelWeight = isError ? scoring.levelWeights.error : scoring.levelWeights.warning
    const impact = Math.min(cluster.clients.length, scoring.clientCap) || 1
    const processWeight = proc ? scoring.coreProcessWeight : scoring.nonCoreProcessWeight
    const fresh = latestVersion && cluster.appVersions.includes(latestVersion) && cluster.appVersions.every((v) => ignored.has(v) || v === latestVersion)
    const freshness = fresh ? scoring.freshnessMultiplier : 1
    const growth = prev24h > 0 && count24h >= prev24h * 2 ? scoring.growthMultiplier : 1
    const score = levelWeight * impact * processWeight * freshness * growth

    // 人工报告簇(intake.mjs 写入,origin=human-report):S 级由 intake 默认
    // (S1 候诊)与分诊会话裁定,gate 不按日志判据重算覆盖(source=HumanReport
    // 不命中核心流程 pattern,重算会把候诊 S1 错降成 S2/S3)。score 仍正常算。
    if (cluster.origin === 'human-report') {
      scored[fp] = { score, count24h, prev24h, distinctClients24h, process: proc ? proc.id : null }
      continue
    }

    // S 级判定(S0→S3 顺序短路;判据全部来自 rules.json)
    let sLevel = 'S3'
    if (isError && cluster.silentFailure) {
      sLevel = 'S0'
    } else if (proc && isError && (distinctClients24h >= s0.minDistinctClients || count24h >= s0.minCount)) {
      sLevel = 'S0'
    } else if (proc && isError) {
      sLevel = 'S1'
    } else if (proc && !isError && cluster.serverFault) {
      // 核心流程 warn 但命中服务端 5xx 特征:客户端有绕行才降成 warn,按"核心 error 有绕行"判 S1
      sLevel = 'S1'
    } else if (isError || cluster.count >= repeatThreshold) {
      sLevel = 'S2'
    }

    cluster.sLevel = sLevel
    scored[fp] = { score, count24h, prev24h, distinctClients24h, process: proc ? proc.id : null }
  }
  return scored
}

// ---- 工作包 ----

const buildWorkpacket = ({ state, scored, rules, mode, signals }) => {
  const clusters = Object.entries(state.clusters)
    .filter(([, c]) => !SETTLED_STATUSES.has(c.status))
    .map(([fp, c]) => ({
      fp,
      source: c.source,
      pattern: c.pattern,
      sLevel: c.sLevel,
      tCap: c.tCap,
      status: c.status,
      attempts: c.attempts,
      issue: c.issue,
      pr: c.pr,
      score: scored[fp]?.score ?? 0,
      process: scored[fp]?.process ?? null,
      count: c.count,
      count24h: scored[fp]?.count24h ?? 0,
      prev24h: scored[fp]?.prev24h ?? 0,
      distinctClients24h: scored[fp]?.distinctClients24h ?? 0,
      clients: [...c.clients].sort(),
      levels: [...c.levels].sort(),
      appVersions: [...c.appVersions].sort(),
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      serverFault: c.serverFault,
      silentFailure: c.silentFailure,
      samples: c.samples,
    }))
    .sort((a, b) => b.score - a.score || (a.fp < b.fp ? -1 : 1))

  const s0Clusters = clusters.filter((c) => c.sLevel === 'S0')
  const selected = mode === 's0-only' ? s0Clusters : clusters
  const s0Alerts = [...s0Clusters.map((c) => ({ kind: 'cluster', fp: c.fp, source: c.source, pattern: c.pattern }))]
  if (signals.nightly?.red) {
    s0Alerts.push({ kind: 'nightly-red', url: signals.nightly.url, conclusion: signals.nightly.conclusion })
  }

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    rulesVersion: rules.version,
    mode,
    cursor: state.cursor,
    signals,
    s0Alerts,
    clusters: selected,
  }
}

const workpacketDigest = (workpacket) => {
  const essence = workpacket.clusters.map((c) => [c.fp, c.count, c.sLevel, c.status])
  essence.push(['__s0Alerts__', workpacket.s0Alerts.length])
  return createHash('sha256').update(JSON.stringify(essence)).digest('hex')
}

// ---- 主流程 ----

const usage = () => {
  process.stderr.write(
    '用法: node scripts/loops/bug-doctor/gate.mjs [--s0-only] [--input <jsonl>] [--no-gh] [--state-dir <dir>] [--json-out <path>]\n',
  )
  process.exit(2)
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) usage()
  const mode = args['s0-only'] ? 's0-only' : 'full'
  const stateDir = resolve(
    args['state-dir'] || process.env.MIVO_BUG_DOCTOR_STATE_DIR || join(REPO_ROOT, 'history', 'loops', 'bug-doctor'),
  )
  const rules = loadRules()

  // 互斥锁:gate/主轮/补轮共用;被占(未过 TTL)→ 立即退出,不排队不等待
  const lock = acquireLock(stateDir, { ttlMinutes: rules.loop.lockTtlMinutes, owner: `gate:${mode}` })
  if (!lock.acquired) {
    log(`锁被占用(holder=${JSON.stringify(lock.holder)}),本实例立即退出`)
    process.stdout.write(`${JSON.stringify({ status: 'locked', holder: lock.holder })}\n`)
    process.exit(0)
  }
  if (lock.stale) log(`接管过期陈锁(previousHolder=${JSON.stringify(lock.previousHolder)})`)

  let state
  try {
    state = loadState(stateDir, FINGERPRINT_VERSION)

    // -- 信号源① debug log(--input 为离线/测试通道,跳过 SSH)--
    const allRecords = args.input ? parseJsonlRecords(readFileSync(args.input, 'utf8')) : fetchProductionRecords()

    // 增量识别:记录 id 去重为主(gap-check 扩窗/游标重置天然免疫重复计数),游标为辅
    const silentFailureRes = compilePatterns(rules.sLevels.s0.silentFailureMessagePatterns)
    const serverFaultRes = compilePatterns(rules.sLevels.s1.coreWarningEscalationPatterns)
    let newRecords = 0
    let newClusters = 0
    for (const rec of allRecords) {
      const key = recordKey(rec)
      if (state.processedIds[key]) continue
      const rawText = `${rec.source || ''} ${rec.message || ''}`
      const isNew = upsertRecord(state, rec, {
        serverFault: matchesAny(serverFaultRes, rawText),
        silentFailure: matchesAny(silentFailureRes, rawText),
      })
      state.processedIds[key] = rec.receivedAt
      if (rec.receivedAt > state.cursor) state.cursor = rec.receivedAt
      newRecords += 1
      if (isNew) newClusters += 1
    }

    // -- 信号源③ nightly-e2e;②/④ 留接口 --
    const nightly = args['no-gh'] ? { status: 'skipped' } : fetchNightlySignal()
    const reactBaselinePath = join(stateDir, 'react-baseline.json')
    const signals = {
      debugLog: { totalRecords: allRecords.length, newRecords, newClusters },
      nightly,
      // T3 产物接入点:基线存在时由后续任务实现 diff,此处只报告可用性
      reactBaseline: { status: existsSync(reactBaselinePath) ? 'present-not-diffed' : 'skipped' },
      verifyLogging: { status: 'skipped' },
    }

    // -- 打分 + S 级(参考时刻 = 游标,确定性)--
    const refNowMs = state.cursor ? Date.parse(state.cursor) : 0
    pruneWindows(state, refNowMs)
    const scored = scoreClusters(state, rules, refNowMs)

    // -- 工作包 + 空转检测(指纹一致 <6h 跳过;≥6h 心跳强制放行)--
    const workpacket = buildWorkpacket({ state, scored, rules, mode, signals })
    const digest = workpacketDigest(workpacket)
    const sinceEmitMs = state.lastEmittedAt ? Date.now() - Date.parse(state.lastEmittedAt) : Number.POSITIVE_INFINITY
    const idleSkip = digest === state.lastWorkpacketDigest && sinceEmitMs < rules.loop.idleHeartbeatHours * HOUR_MS

    if (!idleSkip) {
      writeFileSync(join(stateDir, WORKPACKET_FILE), `${JSON.stringify(workpacket, null, 2)}\n`)
      state.lastWorkpacketDigest = digest
      state.lastEmittedAt = new Date().toISOString()
    }

    // -- 台账落笔(幂等:clusters 只由记录 id 驱动;本段为运行元数据)--
    if (mode === 'full') state.runCount += 1
    state.consecutiveGateFailures = 0
    state.lastRunAt = new Date().toISOString()
    saveState(stateDir, state)

    const s0Count = workpacket.s0Alerts.length
    const activeClusters = Object.values(state.clusters).filter((c) => !SETTLED_STATUSES.has(c.status)).length
    const runAt = localNowIso()
    appendLedger(stateDir, {
      runAt,
      mode,
      newRecords,
      newClusters,
      activeClusters,
      s0: s0Count,
      workpacketClusters: workpacket.clusters.length,
      cost: 0,
    })
    appendLog(
      stateDir,
      `${runAt} · mode=${mode} · 新记录 ${newRecords} · 新簇 ${newClusters} · 活跃簇 ${activeClusters} · S0 ${s0Count}` +
        (idleSkip ? ' · 空转跳过(工作包指纹一致)' : ` · 工作包 ${workpacket.clusters.length} 簇`),
    )

    const summary = {
      status: idleSkip ? 'idle-skip' : workpacket.clusters.length === 0 && s0Count === 0 ? 'empty' : 'workpacket',
      mode,
      newRecords,
      newClusters,
      activeClusters,
      s0: s0Count,
      workpacketClusters: workpacket.clusters.length,
      stateDir,
    }
    if (args['json-out']) writeFileSync(args['json-out'], `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } catch (err) {
    // 失败路径:累计 consecutiveGateFailures(轻巡按阈值告警"loop 失明"),方向 fail-open
    log(`失败: ${err.message}`)
    try {
      const failState = state ?? loadState(stateDir, FINGERPRINT_VERSION)
      failState.consecutiveGateFailures += 1
      saveState(stateDir, failState)
      appendLog(stateDir, `${localNowIso()} · mode=${mode} · 失败: ${err.message.split('\n')[0]} · 连续失败 ${failState.consecutiveGateFailures}`)
    } catch (persistErr) {
      log(`失败状态落盘也失败: ${persistErr.message}`)
    }
    releaseLock(stateDir, { token: lock.token })
    process.exit(1)
  }
  releaseLock(stateDir, { token: lock.token })
}

main()
