#!/usr/bin/env node
// patrol.mjs — T5 整点轻巡 wrapper(launchd 每小时调用,零 LLM;不改 gate 已验收逻辑,只消费其输出)
//
// 职责:
//   1. 跑 gate --s0-only(互斥锁/游标/台账/logs 全部由 gate 自理);
//   2. 工作包出现"新"S0 告警项 → 经 notify.mjs 投递;幂等去重:同一告警项持续存在不重发,
//      从工作包消失后清除标记,复发再发(契约"幂等标记,重复触发不重复建档");
//   3. gate 连续失败 ≥ rules.loop.consecutiveFailureAlertThreshold → 自告警"loop 已失明"
//      (6h 去重窗防每小时刷屏;gate 成功即清除去重标记,新一轮连败重新告警);
//   4. 正常空转轮(无新 S0、无失败)零告警零消息。
//
// 用法: node scripts/loops/bug-doctor/patrol.mjs [--state-dir <dir>] [--input <jsonl>] [--no-gh]
//   --input / --no-gh 原样透传 gate(离线/测试通道);state-dir 解析顺序同 gate:
//   --state-dir > MIVO_BUG_DOCTOR_STATE_DIR > <repoRoot>/history/loops/bug-doctor。
//
// 退出码:透传 gate 退出码(告警投递自身故障不改变退出码,fail-open 落 pending-alerts.md)。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadNotifyConfig, sendAlert } from './notify.mjs'
import { appendLog, STATE_FILE, WORKPACKET_FILE } from './state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const GATE_PATH = join(__dirname, 'gate.mjs')
const RULES_PATH = join(__dirname, 'rules.json')

export const PATROL_STATE_FILE = 'patrol-state.json'
const BLINDNESS_DEDUP_MS = 6 * 3_600_000

const log = (msg) => process.stderr.write(`[bug-doctor:patrol] ${msg}\n`)

const parseArgs = (argv) => {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

const loadPatrolState = (stateDir) => {
  const path = join(stateDir, PATROL_STATE_FILE)
  if (!existsSync(path)) return { alertedS0: {}, lastBlindnessAlertAt: '' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { alertedS0: parsed.alertedS0 || {}, lastBlindnessAlertAt: parsed.lastBlindnessAlertAt || '' }
  } catch {
    // patrol 自身状态损坏 → 重置(方向性:宁可重发一次告警,不静默失明)
    return { alertedS0: {}, lastBlindnessAlertAt: '' }
  }
}

const savePatrolState = (stateDir, patrolState) => {
  writeFileSync(join(stateDir, PATROL_STATE_FILE), `${JSON.stringify(patrolState, null, 2)}\n`)
}

const parseLastJsonLine = (stdout) => {
  const lines = (stdout || '').trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      /* 继续向上找 */
    }
  }
  return null
}

// 告警项稳定 key(幂等标记):簇按指纹,nightly 红灯按 run url(新一晚的红灯是新告警)
const alertKeyOf = (alert) =>
  alert.kind === 'cluster' ? `cluster:${alert.fp}` : `nightly-red:${alert.url || alert.conclusion || 'unknown'}`

const describeAlert = (alert, clustersByFp) => {
  if (alert.kind === 'nightly-red') {
    return `• nightly-e2e 红灯(${alert.conclusion || 'failure'}): ${alert.url || '无 url'}`
  }
  const c = clustersByFp[alert.fp]
  const stats = c
    ? ` — ${c.sLevel} · 24h ${c.count24h} 次 / ${c.distinctClients24h} 客户端 · 累计 ${c.count}`
    : ''
  return `• 簇 [${alert.source}] ${alert.pattern}${stats}\n  fp:${alert.fp}`
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const stateDir = resolve(
    args['state-dir'] || process.env.MIVO_BUG_DOCTOR_STATE_DIR || join(REPO_ROOT, 'history', 'loops', 'bug-doctor'),
  )
  const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'))
  const threshold = rules.loop.consecutiveFailureAlertThreshold

  const gateArgs = [GATE_PATH, '--s0-only', '--state-dir', stateDir]
  if (args.input) gateArgs.push('--input', String(args.input))
  if (args['no-gh']) gateArgs.push('--no-gh')
  const run = spawnSync(process.execPath, gateArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (run.stdout) process.stdout.write(run.stdout)

  const config = loadNotifyConfig(stateDir)
  const patrolState = loadPatrolState(stateDir)

  // ---- gate 失败路径:连败达阈值 → 失明自告警 ----
  if (run.status !== 0) {
    let failures = null
    try {
      failures = JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8')).consecutiveGateFailures
    } catch {
      /* state 也读不到 → 失明信号更强,按阈值已达处理 */
      failures = threshold
    }
    log(`gate 退出码 ${run.status},连续失败 ${failures}`)
    if (failures >= threshold) {
      const last = patrolState.lastBlindnessAlertAt ? Date.parse(patrolState.lastBlindnessAlertAt) : 0
      if (Date.now() - last > BLINDNESS_DEDUP_MS) {
        const title = '🛑 [bug-doctor] loop 已失明'
        const text =
          `gate --s0-only 连续失败 ${failures} 次(阈值 ${threshold}),S0 检测已停摆。\n` +
          `请人工检查:SSH 拉数 / gh / 台账目录 ${stateDir}(详见 logs.md 失败行)。`
        const res = await sendAlert({ stateDir, config, title, text })
        patrolState.lastBlindnessAlertAt = new Date().toISOString()
        savePatrolState(stateDir, patrolState)
        appendLog(stateDir, `${new Date().toISOString()} · patrol · 失明告警已发(channel=${res.channel},连续失败 ${failures})`)
        log(`失明告警已发(channel=${res.channel})`)
      } else {
        log('失明告警在 6h 去重窗内,跳过重发')
      }
    }
    process.exit(run.status ?? 1)
  }

  // ---- gate 成功路径 ----
  // 恢复期:清除失明去重标记,下一轮新连败重新告警
  if (patrolState.lastBlindnessAlertAt) {
    patrolState.lastBlindnessAlertAt = ''
    savePatrolState(stateDir, patrolState)
  }

  const summary = parseLastJsonLine(run.stdout)
  if (!summary || summary.status === 'locked') {
    log(summary ? '锁被占用,本轮跳过(不告警)' : '未解析到 gate summary,本轮跳过')
    return
  }

  // 当前 S0 告警项(summary.s0 为本轮权威计数;为 0 时不读工作包,直接清空标记)
  let currentAlerts = []
  let clustersByFp = {}
  if (summary.s0 > 0) {
    const wpPath = join(stateDir, WORKPACKET_FILE)
    if (existsSync(wpPath)) {
      const wp = JSON.parse(readFileSync(wpPath, 'utf8'))
      currentAlerts = wp.s0Alerts || []
      clustersByFp = Object.fromEntries((wp.clusters || []).map((c) => [c.fp, c]))
    }
  }

  const currentKeys = new Set(currentAlerts.map(alertKeyOf))
  const newAlerts = currentAlerts.filter((a) => !patrolState.alertedS0[alertKeyOf(a)])

  if (newAlerts.length > 0) {
    const title = `🚨 [bug-doctor] S0 告警 · ${newAlerts.length} 项(整点轻巡)`
    const text = `${newAlerts.map((a) => describeAlert(a, clustersByFp)).join('\n')}\n台账:${stateDir}`
    const res = await sendAlert({ stateDir, config, title, text })
    appendLog(stateDir, `${new Date().toISOString()} · patrol · S0 告警已发(channel=${res.channel},新 ${newAlerts.length} 项/在场 ${currentKeys.size} 项)`)
    log(`S0 告警已发(channel=${res.channel},新 ${newAlerts.length} 项)`)
  } else {
    log(`无新 S0(在场 ${currentKeys.size} 项均已告警或为零),零消息`)
  }

  // 幂等标记维护:在场项记时间戳;已消失项清除(复发再告警)
  const now = new Date().toISOString()
  const nextAlerted = {}
  for (const key of currentKeys) nextAlerted[key] = patrolState.alertedS0[key] || now
  const changed =
    newAlerts.length > 0 || Object.keys(nextAlerted).length !== Object.keys(patrolState.alertedS0).length
  if (changed) {
    patrolState.alertedS0 = nextAlerted
    savePatrolState(stateDir, patrolState)
  }
}

main().catch((err) => {
  log(`patrol 自身失败: ${err.message}`)
  process.exit(1)
})
