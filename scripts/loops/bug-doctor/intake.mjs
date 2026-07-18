#!/usr/bin/env node
// intake.mjs — bug-doctor 人工报单/状态查询 helper(T2-2/T2-3,确定性脚本,零 LLM)
//
// 供 Slack 接单会话(@Cindy)调用,契约见 docs/loops/bug-doctor-intake.md:
//   report — 「报bug」动词:白名单校验 → 写台账人工报告簇(source=HumanReport,
//            origin=human-report,默认 S1 候诊)→ 输出 ack 数据(指纹号+队列位置)。
//            同 externalKey(消息串)重复报告不建新簇(followup);不同串同指纹合并
//            (merged)。全部写路径幂等:同输入重跑 → 台账零新增。
//   status — 「状态」动词:只读现成 state.json/logs.md/react-baseline.json,输出与
//            localhost:8787 看板同源的队列计数(P0-P3 展示层映射)/open PR/健康分/
//            上轮班车。复用 dashboard/render.mjs 的同名计算函数,保证字段一致。
//
// 用法:
//   node scripts/loops/bug-doctor/intake.mjs report \
//        --external-key <slack:...:ts> --reporter <slackUserId> --description <text> \
//        [--level error|warning] [--screenshot <url|note>] [--state-dir DIR] [--now ISO]
//   node scripts/loops/bug-doctor/intake.mjs status [--state-dir DIR]
//
// 输出:一行 JSON(stdout)。非白名单 → {allowed:false}(exit 0,正常业务结果,
// 会话按指引礼貌拒绝);台账被锁 → {status:"locked"}(exit 0,会话稍后重试)。
// 退出码:0=业务结果(含拒绝/锁);1=脚本失败;2=用法错误。

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { FINGERPRINT_VERSION, fingerprintOf, normalizeMessage } from './fingerprint.mjs'
import { acquireLock, appendLog, loadState, releaseLock, saveState } from './state.mjs'
import { activeClusters, queueCounts, parseLogs } from '../dashboard/render.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

export const HUMAN_SOURCE = 'HumanReport'
export const HUMAN_ORIGIN = 'human-report'
// 人工报告默认候诊级(展示层 P1;分诊会话核实后可升降,gate 不重算覆盖)
export const HUMAN_DEFAULT_SLEVEL = 'S1'
const MAX_SAMPLES_PER_CLUSTER = 3
// 与 dashboard ACTIVE_STATUSES 同源(经 activeClusters 导入使用,不在此重复定义)
const S_RANK = { S0: 0, S1: 1, S2: 2, S3: 3 }
// 展示层 P 编号 = 内部 S 级一一映射(团队沟通用 P,台账/打分内部用 S)
export const S_TO_P = { S0: 'P0', S1: 'P1', S2: 'P2', S3: 'P3' }

// ---- 通用 ----

const log = (msg) => process.stderr.write(`[bug-doctor:intake] ${msg}\n`)

/**
 * 默认状态目录穿透到主 checkout:接单会话跑在 .xdt-worktrees/ 隔离工作树里,
 * 而台账 history/(不入 git)只存在于主 checkout —— 按 git common dir 反解主
 * checkout 根,保证任意 worktree 内调用都读写同一份台账。git 不可用时回落
 * 脚本位置推导(与 gate.mjs 同口径)。
 */
export const resolveDefaultStateDir = () => {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const mainRoot = dirname(resolve(REPO_ROOT, common))
    return join(mainRoot, 'history', 'loops', 'bug-doctor')
  } catch {
    return join(REPO_ROOT, 'history', 'loops', 'bug-doctor')
  }
}

const stateDirFrom = (args) =>
  resolve(args['state-dir'] || process.env.MIVO_BUG_DOCTOR_STATE_DIR || resolveDefaultStateDir())

// 锁 TTL 权威值 = rules.json loop.lockTtlMinutes(与 gate/主轮同一把锁必须同一口径,
// 否则短 TTL 方会把长任务的活锁误判为陈锁夺走);读不到时回落契约值 60
export const lockTtlMinutes = () => {
  try {
    const rules = JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8'))
    const ttl = rules?.loop?.lockTtlMinutes
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 60
  } catch {
    return 60
  }
}

// 同步短退避(status 安全读重试用;无定时器依赖,worker 线程语义安全)
const sleepMs = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 报单文本幂等摘要:与 samples 容量上限无关的"该消息串已登记过哪些输入"持久键
const messageDigest = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)

export const shortId = (fp) => createHash('sha256').update(fp).digest('hex').slice(0, 8)

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

// ---- 白名单(notify.env 的 INTAKE_ALLOWLIST,逗号分隔 Slack user id,不入 git)----

export const loadAllowlist = (stateDir) => {
  const path = join(stateDir, 'notify.env')
  if (!existsSync(path)) return []
  const ids = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*INTAKE_ALLOWLIST\s*=\s*(.*)$/)
    if (!m) continue
    for (const id of m[1].split(',')) {
      const trimmed = id.trim()
      if (trimmed && !trimmed.startsWith('#')) ids.push(trimmed)
    }
  }
  return ids
}

// ---- 队列位置(展示口径与看板同源:activeClusters;排序确定性:S级 → lastSeen → fp)----

export const queuePositionOf = (state, fp) => {
  const act = activeClusters(state)
  const ordered = [...act].sort((a, b) => {
    const ra = S_RANK[a.sLevel] ?? 9
    const rb = S_RANK[b.sLevel] ?? 9
    if (ra !== rb) return ra - rb
    if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? -1 : 1
    return a.fp < b.fp ? -1 : 1
  })
  const idx = ordered.findIndex((c) => c.fp === fp)
  return { position: idx === -1 ? null : idx + 1, queueSize: ordered.length }
}

// ---- report 核心(纯状态变换,IO 由 CLI 层负责;now 注入保证测试确定性)----

/**
 * 幂等规则:
 *   1) 同 externalKey 已绑簇 → followup(计数+样本,不建新簇,不重复绑定);
 *      同 externalKey + 同 description 重跑 → duplicate(台账零变化,防会话重试双写)。
 *      判重键 = threads[key].seen 的消息摘要列表(持久,不受 samples 容量上限影响)。
 *   2) 不同 externalKey 但指纹相同 → merged(并入既有簇,新串绑同簇)。
 *   3) 全新 → created(S1 候诊,origin=human-report)。
 */
export const applyReport = (state, { externalKey, reporter, description, level, screenshot, now }) => {
  const intake = state.intake || (state.intake = { threads: {} })
  const threads = intake.threads || (intake.threads = {})

  const boundFp = threads[externalKey]?.fp
  const fp = boundFp || fingerprintOf({ source: HUMAN_SOURCE, message: description })
  let cluster = state.clusters[fp]
  let kind

  const sample = {
    receivedAt: now,
    source: HUMAN_SOURCE,
    message: String(description),
    level,
    reporter,
    externalKey,
    ...(screenshot ? { screenshot } : {}),
  }
  const digest = messageDigest(sample.message)

  if (cluster) {
    // 防重:同串同文案重复提交(会话重试/用户重发)→ 台账零变化。
    // 主判据 seen 摘要(持久);samples 兜底兼容 seen 字段之前的旧绑定。
    const dup =
      (threads[externalKey]?.seen || []).includes(digest) ||
      (cluster.samples || []).some((s) => s.externalKey === externalKey && s.message === sample.message)
    if (dup) {
      kind = 'duplicate'
    } else {
      kind = boundFp ? 'followup' : 'merged'
      cluster.count += 1
      if (now > cluster.lastSeen) cluster.lastSeen = now
      const clientKey = `human:${reporter}`
      if (!cluster.clients.includes(clientKey)) cluster.clients.push(clientKey)
      if (level && !cluster.levels.includes(level)) cluster.levels.push(level)
      if (!(cluster.reporters || []).includes(reporter)) (cluster.reporters ||= []).push(reporter)
      cluster.recent.push({ t: now, c: clientKey })
      cluster.samples.push(sample)
      cluster.samples.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1))
      if (cluster.samples.length > MAX_SAMPLES_PER_CLUSTER) {
        cluster.samples = cluster.samples.slice(-MAX_SAMPLES_PER_CLUSTER)
      }
    }
  } else {
    kind = 'created'
    cluster = {
      source: HUMAN_SOURCE,
      pattern: normalizeMessage(description),
      sLevel: HUMAN_DEFAULT_SLEVEL,
      tCap: 'T2',
      count: 1,
      clients: [`human:${reporter}`],
      firstSeen: now,
      lastSeen: now,
      appVersions: [],
      status: 'new',
      attempts: 0,
      issue: null,
      pr: null,
      levels: [level],
      serverFault: false,
      silentFailure: false,
      recent: [{ t: now, c: `human:${reporter}` }],
      samples: [sample],
      origin: HUMAN_ORIGIN,
      reporters: [reporter],
    }
    state.clusters[fp] = cluster
  }

  if (!threads[externalKey]) threads[externalKey] = { fp, boundAt: now, seen: [] }
  if (kind !== 'duplicate') {
    const seen = (threads[externalKey].seen ||= [])
    if (!seen.includes(digest)) seen.push(digest)
  }

  return { kind, fp, cluster }
}

const runReport = (args) => {
  const stateDir = stateDirFrom(args)
  const externalKey = args['external-key']
  const reporter = args.reporter
  const description = args.description
  const level = args.level === 'warning' ? 'warning' : 'error'
  const screenshot = typeof args.screenshot === 'string' ? args.screenshot : null
  const now = typeof args.now === 'string' ? args.now : new Date().toISOString()
  if (!externalKey || !reporter || !description || typeof description !== 'string') {
    process.stderr.write('用法: intake.mjs report --external-key K --reporter U --description TEXT [--level error|warning] [--screenshot S] [--state-dir DIR] [--now ISO]\n')
    process.exit(2)
  }

  // 白名单:fail-closed —— 名单缺失/为空一律拒绝(宁可漏收,不可越权入队)
  const allowlist = loadAllowlist(stateDir)
  if (!allowlist.includes(reporter)) {
    process.stdout.write(`${JSON.stringify({ allowed: false, reason: allowlist.length === 0 ? 'allowlist-missing' : 'not-allowlisted', reporter })}\n`)
    return
  }

  // 与 gate/主轮共用一把锁,防并发写台账;被占 → 交给会话稍后重试(不排队)。
  // TTL 必须与 gate 同权威值(rules.json):短 TTL 会把长跑中的 gate 活锁误判陈锁夺走
  const lock = acquireLock(stateDir, { ttlMinutes: lockTtlMinutes(), owner: 'intake:report' })
  if (!lock.acquired) {
    process.stdout.write(`${JSON.stringify({ status: 'locked', holder: lock.holder })}\n`)
    return
  }
  try {
    const state = loadState(stateDir, FINGERPRINT_VERSION)
    const result = applyReport(state, { externalKey, reporter, description, level, screenshot, now })
    if (result.kind !== 'duplicate') {
      saveState(stateDir, state)
      appendLog(stateDir, `${now} · intake · ${result.kind} · fp#${shortId(result.fp)} · reporter=${reporter} · key=${externalKey}`)
    }
    const { position, queueSize } = queuePositionOf(state, result.fp)
    process.stdout.write(
      `${JSON.stringify({
        allowed: true,
        kind: result.kind,
        fp: result.fp,
        fpShort: shortId(result.fp),
        sLevel: result.cluster.sLevel,
        pLevel: S_TO_P[result.cluster.sLevel] ?? result.cluster.sLevel,
        status: result.cluster.status,
        count: result.cluster.count,
        queuePosition: position,
        queueSize,
        externalKey,
      })}\n`,
    )
  } finally {
    releaseLock(stateDir, { token: lock.token }) // 只删自己持有的锁,不误删接管者的
  }
}

// ---- status 核心(只读;与看板同源计算)----

export const buildStatus = ({ state, baseline, logsMd, now }) => {
  const act = activeClusters(state)
  const q = queueCounts(act)
  const runs = parseLogs(logsMd || '')
  const last = runs[runs.length - 1] || null
  return {
    generatedAt: now,
    queue: {
      P0: q.S0,
      P1: q.S1,
      P2: q.S2,
      P3: q.S3,
      // 内部 S 字段一并输出,防展示层映射歧义(P 编号即 S 级一一映射)
      sMap: q,
      activeTotal: act.length,
    },
    openPRs: state?.openPRs || [],
    openPRCount: (state?.openPRs || []).length,
    healthScore: baseline?.healthScore?.value ?? null,
    lastRun: last
      ? { at: last.ts, mode: last.mode, idle: last.idle, workpacketClusters: last.workpacket }
      : null,
  }
}

const runStatus = (args) => {
  const stateDir = stateDirFrom(args)
  const now = typeof args.now === 'string' ? args.now : new Date().toISOString()
  // 安全读:写方已是原子 rename,这里再加短退避重试兜底(如 NFS/异常残留);
  // 解析持续失败 → 降级空态出卡(fail-open,与看板 readJsonSafe 同方向),
  // 但 schema/fingerprint 版本不符是真实完整性错误,照旧抛出(exit 1)。
  let state = null
  let stateDegraded = false
  let stateError = null
  if (existsSync(join(stateDir, 'state.json'))) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        state = loadState(stateDir, FINGERPRINT_VERSION)
        stateError = null
        break
      } catch (err) {
        if (/schemaVersion|fingerprintVersion/.test(err.message)) throw err
        stateError = err.message
        sleepMs(100)
      }
    }
    if (!state && stateError) stateDegraded = true
  }
  let baseline = null
  try {
    baseline = JSON.parse(readFileSync(join(stateDir, 'react-baseline.json'), 'utf8'))
  } catch {
    baseline = null
  }
  let logsMd = ''
  try {
    logsMd = readFileSync(join(stateDir, 'logs.md'), 'utf8')
  } catch {
    logsMd = ''
  }
  if (stateDegraded) {
    // 台账读不出 → 不输出任何队列/PR/健康分字段(空态数字会被误当"一切正常"),
    // 只给显式降级信号;顺手记 logs.md 一行(指引降级文案里的"已记录"由此兑现)
    try {
      appendLog(stateDir, `${now} · intake-status · degraded: ${String(stateError).split('\n')[0]}`)
    } catch {
      /* 记录失败不影响降级应答 */
    }
    process.stdout.write(`${JSON.stringify({ status: 'degraded', generatedAt: now, stateError })}\n`)
    return
  }
  const card = buildStatus({ state: state || { clusters: {}, openPRs: [] }, baseline, logsMd, now })
  process.stdout.write(`${JSON.stringify({ status: 'ok', ...card })}\n`)
}

// ---- CLI ----

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  try {
    if (cmd === 'report') runReport(args)
    else if (cmd === 'status') runStatus(args)
    else {
      process.stderr.write('用法: intake.mjs <report|status> [选项](详见文件头注释)\n')
      process.exit(2)
    }
  } catch (err) {
    log(`失败: ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
