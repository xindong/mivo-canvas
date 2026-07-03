import { describe, expect, it } from 'vitest'
import {
  filterRemoteDebugRecords,
  normalizeRemoteDebugPayload,
  sanitizeRemoteDebugText,
  type RemoteDebugRecord,
} from './debug-records'

// Migrated from vite.config.test.ts (P1-c Task A). Assertion semantics are
// preserved 1:1 — these are the canonical proof that the BFF's debug-log
// normalize/sanitize/filter behavior matches the dev middleware baseline.

describe('remote debug server helpers', () => {
  it('normalizes only warning and error entries with server metadata', () => {
    const records = normalizeRemoteDebugPayload(
      {
        clientId: 'client-a',
        sessionId: 'session-1',
        appVersion: '0.0.0',
        pagePath: '/canvas',
        userAgent: 'Seed Browser',
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        screen: { width: 1440, height: 900, pixelRatio: 2 },
        entries: [
          { level: 'log', source: 'Canvas', message: 'local only', timestamp: 1 },
          { level: 'warning', source: 'Settings', message: 'missing feature', timestamp: 2 },
          { level: 'error', source: 'Canvas Import', message: 'failed import', timestamp: 3 },
        ],
      },
      {
        ip: '127.0.0.1',
        referer: 'https://mivo.example/canvas',
        receivedAt: '2026-07-03T08:00:00.000Z',
      },
    )

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      level: 'warning',
      source: 'Settings',
      clientId: 'client-a',
      sessionId: 'session-1',
      ip: '127.0.0.1',
    })
    expect(records[1]).toMatchObject({ level: 'error', source: 'Canvas Import' })
  })

  it('redacts likely secrets, data URLs, and long base64-like payloads', () => {
    const sanitized = sanitizeRemoteDebugText(
      'token=abc123SECRET data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABBBBCCCCDDDDEEEEFFFFGGGG',
    )

    expect(sanitized).toContain('token=[redacted]')
    expect(sanitized).toContain('data:[redacted]')
    expect(sanitized).not.toContain('abc123SECRET')
    expect(sanitized).not.toContain('iVBORw0KGgo')
  })

  it('filters records for the debug report browser', () => {
    const records: Partial<RemoteDebugRecord>[] = [
      { level: 'warning', source: 'Settings', message: 'missing feature', clientId: 'client-a', sessionId: 's1' },
      { level: 'error', source: 'Canvas Import', message: 'failed import', clientId: 'client-b', sessionId: 's2' },
    ]

    expect(filterRemoteDebugRecords(records, { level: 'error' })).toEqual([records[1]])
    expect(filterRemoteDebugRecords(records, { clientId: 'client-a' })).toEqual([records[0]])
    expect(filterRemoteDebugRecords(records, { query: 'import' })).toEqual([records[1]])
  })
})
