import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PENDING_ALERTS_FILE, appendPendingAlert, loadNotifyConfig } from './notify.mjs'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mivo-notify-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('pending-alerts 落地模板(Mivo 署名)', () => {
  it('首写头带 Mivo 署名,不再自称 bug-doctor;告警标题原样落地', () => {
    appendPendingAlert(dir, '🚨 [mivo] P0 告警 · 1 项(整点轻巡)', '• 簇 [Persist Boot] x\n台账:/tmp/x')
    const content = readFileSync(join(dir, PENDING_ALERTS_FILE), 'utf8')
    expect(content).toContain('# Mivo pending alerts')
    expect(content).not.toContain('bug-doctor pending alerts')
    expect(content).toContain('🚨 [mivo] P0 告警 · 1 项(整点轻巡)')
  })

  it('追加不重复头', () => {
    appendPendingAlert(dir, 't1', 'x')
    appendPendingAlert(dir, 't2', 'y')
    const content = readFileSync(join(dir, PENDING_ALERTS_FILE), 'utf8')
    expect(content.match(/# Mivo pending alerts/g)).toHaveLength(1)
    expect(content).toContain('t2')
  })
})

describe('loadNotifyConfig', () => {
  it('notify.env KV 解析,进程环境变量优先', () => {
    const prev = process.env.SLACK_WEBHOOK_URL
    delete process.env.SLACK_WEBHOOK_URL
    try {
      expect(loadNotifyConfig(dir)).toEqual({})
    } finally {
      if (prev !== undefined) process.env.SLACK_WEBHOOK_URL = prev
    }
  })
})
