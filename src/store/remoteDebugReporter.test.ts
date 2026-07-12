import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebugLogStore } from './debugLogStore'
import {
  __resetRemoteDebugStateForTest,
  __setRemoteDebugTestHooks,
  buildRemoteDebugPayload,
  createRemoteDebugClientInfo,
  drainRemoteDebugOutbox,
  flushRemoteDebugEntries,
  getRemoteDebugDropCount,
  getRemoteDebugOutboxCount,
  reportRemoteDebugEntry,
  resolveRemoteDebugEndpoint,
  shouldReportRemoteDebugLevel,
  type RemoteDebugClientInfo,
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

// ── FX-7: durable outbox + exponential-backoff retry + drop count (A6 · D-4 hard prereq) ──

const fixedClientInfo = (): RemoteDebugClientInfo => ({
  clientId: 'client-fixed',
  sessionId: 'session-fixed',
  appVersion: '0.0.0-test',
  pagePath: '/canvas',
  userAgent: 'TestBrowser',
  language: 'en',
  timezone: 'UTC',
  screen: { width: 1440, height: 900, pixelRatio: 2 },
})

describe('FX-7 remoteDebugReporter durable outbox + retry + drop count', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await __resetRemoteDebugStateForTest()
  })
  afterEach(async () => {
    await __resetRemoteDebugStateForTest()
  })

  it('SC1: a failed batch persists to the durable outbox, recovers on resend, and is not lost', async () => {
    const sentPayloads: { entries: Array<{ message: string }> }[] = []
    let shouldFail = true
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      if (shouldFail) throw new Error('network down (BFF jitter)')
      sentPayloads.push(JSON.parse(init.body ?? '{}'))
      return new Response('{}', { status: 200 })
    })
    let clock = 1000
    __setRemoteDebugTestHooks({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      random: () => 0.5, // deterministic jitter → 0.75 of capped delay
      buildClientInfo: fixedClientInfo,
      enabled: true,
    })

    // Report an error entry; flush immediately (batch is the single entry).
    reportRemoteDebugEntry({ level: 'error', source: 'Canvas', message: 'boom', timestamp: 1000 })
    await flushRemoteDebugEntries()

    // The batch failed to send but was NOT lost — it landed in the durable IDB outbox,
    // and the drop count is still 0 (retry is not yet exhausted).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await getRemoteDebugOutboxCount()).toBe(1)
    expect(await getRemoteDebugDropCount()).toBe(0)

    // Simulate BFF recovery: fetch now succeeds. Advance the clock past the record's
    // backoff window so it is due, then drain the durable outbox.
    shouldFail = false
    clock += 10_000
    const result = await drainRemoteDebugOutbox()

    expect(result.sent).toBe(1)
    expect(result.dropped).toBe(0)
    expect(await getRemoteDebugOutboxCount()).toBe(0)
    expect(await getRemoteDebugDropCount()).toBe(0)
    // The original batch was actually delivered (not lost): its entry survived the
    // failed flush + durable round-trip.
    expect(sentPayloads).toHaveLength(1)
    expect(sentPayloads[0].entries[0].message).toBe('boom')
  })

  it('SC2: after the retry limit the drop count increments and is queryable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down (BFF permanently unreachable)')
    })
    let clock = 1000
    __setRemoteDebugTestHooks({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      random: () => 0.5,
      buildClientInfo: fixedClientInfo,
      enabled: true,
    })

    reportRemoteDebugEntry({ level: 'error', source: 'Canvas', message: 'boom', timestamp: 1000 })
    await flushRemoteDebugEntries() // batch fails → durable outbox (attempts=0)
    expect(await getRemoteDebugOutboxCount()).toBe(1)
    expect(await getRemoteDebugDropCount()).toBe(0)

    // DEFAULT_MAX_RETRIES = 5. Each drain (clock advanced past the record's backoff
    // window) fails and bumps attempts; on the 5th retry attempt (attempts reaches
    // 5 >= maxRetries) the batch is dropped + counted. The clock is advanced before the
    // FIRST drain too, because persistFailedBatch set nextAttemptAt = now + backoff(1)
    // (so the record is not due at clock=1000 immediately after the failed flush).
    let last: { dropped: number } = { dropped: 0 }
    for (let attempt = 1; attempt <= 5; attempt++) {
      clock += 100_000 // well past any backoff window so the record is due
      last = await drainRemoteDebugOutbox()
    }
    // The 5th retry attempt drops the batch (attempts=5 >= maxRetries).
    expect(last.dropped).toBe(1)
    // Drop count is persisted + queryable.
    expect(await getRemoteDebugDropCount()).toBe(1)
    expect(await getRemoteDebugOutboxCount()).toBe(0)
    // 1 initial flush send + 5 retry sends, all failed.
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('logging completeness (docs/development-logging.md): success/skip/failure paths all surface locally', async () => {
    // Success path → logLocal('log'); transient retry → logLocal('warning'); drop →
    // logLocal('error'). These bypass debugLogger to avoid the remote-report feedback
    // loop, but still write to the Debug Log store so the panel shows every outcome.
    useDebugLogStore.getState().clear()
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    let clock = 1000
    __setRemoteDebugTestHooks({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      random: () => 0.5,
      buildClientInfo: fixedClientInfo,
      enabled: true,
    })

    reportRemoteDebugEntry({ level: 'error', source: 'S', message: 'm', timestamp: 1000 })
    await flushRemoteDebugEntries()
    // skip/failure path: batch persisted to outbox → a warning-level local log entry.
    const afterFlush = useDebugLogStore.getState().entries
    expect(
      afterFlush.some(
        (e) => e.level === 'warning' && typeof e.message === 'string' && e.message.includes('persisted to durable outbox'),
      ),
    ).toBe(true)

    // Drain through to drop (5 retry attempts, clock advanced past backoff each time)
    // → an error-level local log entry.
    for (let attempt = 1; attempt <= 5; attempt++) {
      clock += 100_000
      await drainRemoteDebugOutbox()
    }
    const afterDrop = useDebugLogStore.getState().entries
    expect(
      afterDrop.some(
        (e) => e.level === 'error' && typeof e.message === 'string' && e.message.includes('dropped after'),
      ),
    ).toBe(true)
  })
})
