// notify.mjs — Mivo(原 bug-doctor)告警投递小模块(T5)
//
// 通道优先级:Slack incoming webhook(SLACK_WEBHOOK_URL,来源:环境变量 > <stateDir>/notify.env)。
// 未配置或投递失败 → 降级双通道:追加 <stateDir>/pending-alerts.md(必落) + macOS 桌面通知(尽力)。
// 方向性 fail-open:告警宁可落本地也不静默丢(契约 docs/loops/bug-doctor.md 通知节)。
// 真实 webhook 到位后只需在 <stateDir>/notify.env 写一行 SLACK_WEBHOOK_URL=...,代码零改动。

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const PENDING_ALERTS_FILE = 'pending-alerts.md'
export const NOTIFY_ENV_FILE = 'notify.env'

const WEBHOOK_TIMEOUT_MS = 10_000

/** 读通知配置:<stateDir>/notify.env(KEY=VALUE 行) < 进程环境变量。 */
export const loadNotifyConfig = (stateDir) => {
  const config = {}
  const envPath = join(stateDir, NOTIFY_ENV_FILE)
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  }
  if (process.env.SLACK_WEBHOOK_URL) config.SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL
  return config
}

const postWebhook = async (url, text) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

export const appendPendingAlert = (stateDir, title, text) => {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, PENDING_ALERTS_FILE)
  const header = existsSync(path)
    ? ''
    : '# Mivo pending alerts(webhook 未配置/投递失败时落地;配置后由每日战报补报,不静默丢)\n\n'
  appendFileSync(path, `${header}## ${new Date().toISOString()} · ${title}\n\n${text}\n\n`)
}

const desktopNotify = (title, text) => {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  execFileSync(
    'osascript',
    ['-e', `display notification "${esc(text.slice(0, 200))}" with title "${esc(title)}"`],
    { stdio: 'ignore', timeout: 10_000 },
  )
}

const degrade = (stateDir, title, text, reason) => {
  appendPendingAlert(stateDir, reason ? `${title}(${reason})` : title, text)
  let desktopNotified = false
  try {
    desktopNotify(title, text)
    desktopNotified = true
  } catch {
    /* 无 GUI 会话等场景;pending-alerts.md 已落,不因通知失败抛错 */
  }
  return { channel: 'degraded', desktopNotified }
}

/**
 * 投递一条告警。返回 { channel: 'webhook'|'degraded', desktopNotified }。
 * 本函数不抛错(告警链路自身故障不打断轻巡)。
 */
export const sendAlert = async ({ stateDir, config, title, text }) => {
  const url = config.SLACK_WEBHOOK_URL
  if (url) {
    try {
      await postWebhook(url, `${title}\n${text}`)
      return { channel: 'webhook', desktopNotified: false }
    } catch (err) {
      return degrade(stateDir, title, text, `webhook 投递失败: ${err.message}`)
    }
  }
  return degrade(stateDir, title, text)
}
