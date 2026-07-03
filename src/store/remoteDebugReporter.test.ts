import { describe, expect, it } from 'vitest'
import {
  buildRemoteDebugPayload,
  createRemoteDebugClientInfo,
  resolveRemoteDebugEndpoint,
  shouldReportRemoteDebugLevel,
} from './remoteDebugReporter'

const createMemoryStorage = () => {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  } satisfies Storage
}

describe('remoteDebugReporter', () => {
  it('keeps a transparent client id while using a per-page session id', () => {
    const storage = createMemoryStorage()

    const first = createRemoteDebugClientInfo({
      storage,
      createId: () => 'client-a',
      sessionId: 'session-1',
      locationPath: '/canvas',
      userAgent: 'Seed Browser',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      screen: { width: 1440, height: 900, pixelRatio: 2 },
    })
    const second = createRemoteDebugClientInfo({
      storage,
      createId: () => 'client-b',
      sessionId: 'session-2',
      locationPath: '/canvas',
      userAgent: 'Seed Browser',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      screen: { width: 1440, height: 900, pixelRatio: 2 },
    })

    expect(first.clientId).toBe('client-a')
    expect(first.sessionId).toBe('session-1')
    expect(second.clientId).toBe('client-a')
    expect(second.sessionId).toBe('session-2')
  })

  it('reports warning and error entries but leaves normal logs local only', () => {
    expect(shouldReportRemoteDebugLevel('log')).toBe(false)
    expect(shouldReportRemoteDebugLevel('warning')).toBe(true)
    expect(shouldReportRemoteDebugLevel('error')).toBe(true)
  })

  it('uses an external endpoint when static hosting cannot serve APIs', () => {
    expect(resolveRemoteDebugEndpoint('https://debug.example.com/api/mivo/debug-logs')).toBe(
      'https://debug.example.com/api/mivo/debug-logs',
    )
    expect(resolveRemoteDebugEndpoint('')).toBe('/api/mivo/debug-logs')
  })

  it('builds one remote payload with client metadata and only reportable entries', () => {
    const payload = buildRemoteDebugPayload(
      [
        { level: 'log', source: 'Canvas', message: 'local only', timestamp: 1 },
        { level: 'warning', source: 'Settings', message: 'missing feature', timestamp: 2 },
        { level: 'error', source: 'Canvas Import', message: 'failed import', timestamp: 3 },
      ],
      {
        clientId: 'client-a',
        sessionId: 'session-1',
        appVersion: '0.0.0',
        pagePath: '/canvas',
        userAgent: 'Seed Browser',
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        screen: { width: 1440, height: 900, pixelRatio: 2 },
      },
    )

    expect(payload.clientId).toBe('client-a')
    expect(payload.sessionId).toBe('session-1')
    expect(payload.entries).toEqual([
      { level: 'warning', source: 'Settings', message: 'missing feature', timestamp: 2 },
      { level: 'error', source: 'Canvas Import', message: 'failed import', timestamp: 3 },
    ])
  })
})
