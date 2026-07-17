import { describe, expect, it } from 'vitest'
import {
  filterRemoteDebugRecords,
  normalizeRemoteDebugPayload,
  sanitizeRemoteDebugStack,
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

// T2-4 · stack trace 采集:stack 专用清洗。与 sanitizeRemoteDebugText 不同,stack 保留
// 换行结构;帧内保留「文件名:行号:列号」,剥用户目录/构建目录绝对路径前缀与 URL origin+query;
// 复用 token/base64/data-url 打码;总长截断 ≤2KB。
describe('sanitizeRemoteDebugStack (T2-4)', () => {
  it('strips absolute user-dir path prefixes but keeps file:line:col (spaces in path tolerated)', () => {
    const stack = [
      'Error: boom',
      '    at archiveCanvas (/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/src/store/documentSlice.ts:120:15)',
      '    at /AIGC_Group/mivo-canvas/dist/assets/index-abc123.js:1:23456',
    ].join('\n')

    const sanitized = sanitizeRemoteDebugStack(stack)

    expect(sanitized).toContain('documentSlice.ts:120:15')
    expect(sanitized).toContain('index-abc123.js:1:23456')
    expect(sanitized).not.toContain('/Users/')
    expect(sanitized).not.toContain('praise')
    expect(sanitized).not.toContain('/AIGC_Group/')
  })

  it('strips URL origin and query but keeps the relative path with line info', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at flush (http://localhost:5173/src/store/remoteDebugReporter.ts?t=1752770000000:613:9)',
      '    at drain (https://mivo-canvas.dsworks.cn/assets/index-9f8e7d.js:2:3344)',
    ].join('\n')

    const sanitized = sanitizeRemoteDebugStack(stack)

    expect(sanitized).toContain('src/store/remoteDebugReporter.ts:613:9')
    expect(sanitized).toContain('assets/index-9f8e7d.js:2:3344')
    expect(sanitized).not.toContain('http://localhost:5173')
    expect(sanitized).not.toContain('mivo-canvas.dsworks.cn')
    expect(sanitized).not.toContain('?t=')
  })

  it('redacts tokens and long base64-like payloads inside stacks', () => {
    const stack = [
      'Error: fetch failed for /api/x?token=abc123SECRET',
      `    at data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(4)}`,
    ].join('\n')

    const sanitized = sanitizeRemoteDebugStack(stack)

    expect(sanitized).toContain('token=[redacted]')
    expect(sanitized).not.toContain('abc123SECRET')
    expect(sanitized).not.toContain('iVBORw0KGgo')
  })

  it('truncates oversized stacks to 2KB with a marker and preserves line breaks', () => {
    const stack = `Error: huge\n${'    at frame (file.ts:1:1)\n'.repeat(200)}`

    const sanitized = sanitizeRemoteDebugStack(stack)

    expect(sanitized).toBeDefined()
    expect(sanitized!.length).toBeLessThanOrEqual(2048 + '... [truncated]'.length)
    expect(sanitized!.endsWith('... [truncated]')).toBe(true)
    expect(sanitized).toContain('\n')
  })

  it('returns undefined for missing / non-string / blank input (legacy-client compatible)', () => {
    expect(sanitizeRemoteDebugStack(undefined)).toBeUndefined()
    expect(sanitizeRemoteDebugStack(42)).toBeUndefined()
    expect(sanitizeRemoteDebugStack('   ')).toBeUndefined()
  })
})

describe('normalizeRemoteDebugPayload stack passthrough (T2-4)', () => {
  const serverMeta = {
    ip: '127.0.0.1',
    referer: 'https://mivo.example/canvas',
    receivedAt: '2026-07-18T08:00:00.000Z',
  }
  const basePayload = {
    clientId: 'client-a',
    sessionId: 'session-1',
    appVersion: '1.0.0',
    pagePath: '/canvas',
    userAgent: 'Seed Browser',
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    screen: { width: 1440, height: 900, pixelRatio: 2 },
  }

  it('attaches a sanitized stack to error entries only; warning stacks are dropped', () => {
    const records = normalizeRemoteDebugPayload(
      {
        ...basePayload,
        entries: [
          {
            level: 'error',
            source: 'Canvas Import',
            message: 'failed import',
            timestamp: 3,
            stack: 'Error: failed import\n    at load (/Users/praise/app/src/lib/import.ts:10:5)',
          },
          {
            level: 'warning',
            source: 'Settings',
            message: 'missing feature',
            timestamp: 2,
            stack: 'Error: should not be stored\n    at warnPath (src/x.ts:1:1)',
          },
        ],
      },
      serverMeta,
    )

    expect(records).toHaveLength(2)
    const errorRecord = records.find((r) => r.level === 'error')!
    const warningRecord = records.find((r) => r.level === 'warning')!
    expect(errorRecord.stack).toContain('import.ts:10:5')
    expect(errorRecord.stack).not.toContain('/Users/')
    expect(warningRecord.stack).toBeUndefined()
    expect('stack' in warningRecord).toBe(false)
  })

  it('keeps legacy payloads without stack working, with no stack key on records', () => {
    const records = normalizeRemoteDebugPayload(
      {
        ...basePayload,
        entries: [{ level: 'error', source: 'Canvas', message: 'legacy client', timestamp: 1 }],
      },
      serverMeta,
    )

    expect(records).toHaveLength(1)
    expect('stack' in records[0]!).toBe(false)
  })
})
