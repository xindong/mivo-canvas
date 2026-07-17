import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debugLogger, useDebugLogStore } from './debugLogStore'
import {
  __createIdForTest,
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
    vi.unstubAllGlobals()
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

// ── P1-1 / P1-2 (double-review fixes) ──

describe('FX-7 P1-1: createId never uses Math.random (CWE-338)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await __resetRemoteDebugStateForTest()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await __resetRemoteDebugStateForTest()
  })

  it('branch 1 — crypto.randomUUID path produces unique ids without Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random')
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(__createIdForTest())
    expect(ids.size).toBe(100) // all unique (UUID)
    expect(randomSpy).not.toHaveBeenCalled()
  })

  it('branch 2 — crypto.getRandomValues (no randomUUID) path produces unique ids without Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random')
    let callN = 0
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        callN += 1
        for (let i = 0; i < arr.length; i++) arr[i] = (callN + i * 3) & 0xff
        return arr
      },
    })
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(__createIdForTest())
    expect(ids.size).toBe(100) // varying CSPRNG bytes → unique
    expect(randomSpy).not.toHaveBeenCalled()
    // CSPRNG-fallback id shape: debug-<8hex>-<4hex>-<4hex>-<16hex>
    expect([...ids][0]).toMatch(/^debug-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/)
  })

  it('branch 3 — no crypto at all → timestamp + counter fallback, no Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random')
    vi.stubGlobal('crypto', undefined)
    const ids: string[] = []
    for (let i = 0; i < 100; i++) ids.push(__createIdForTest())
    expect(new Set(ids).size).toBe(100) // monotonic counter → unique within the same ms
    expect(randomSpy).not.toHaveBeenCalled()
    expect(ids[0]).toMatch(/^debug-[0-9a-z]+-[0-9a-z]+$/) // timestamp + counter shape
  })
})

describe('FX-7 P1-2: fail-safe client info (no silent batch loss on localStorage failure)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await __resetRemoteDebugStateForTest()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await __resetRemoteDebugStateForTest()
  })

  it('createRemoteDebugClientInfo does NOT throw when storage.getItem throws (falls back to a fresh client id)', () => {
    const throwingStorage = {
      ...createMemoryStorage(),
      getItem: () => {
        throw new Error('localStorage blocked (sandboxed iframe)')
      },
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    // Must not throw — the read failure falls back to the injected createClientId.
    const info = createRemoteDebugClientInfo({
      storage: throwingStorage,
      createId: () => 'client-fallback',
      sessionId: 's1',
      locationPath: '/x',
      userAgent: 'ua',
      language: 'en',
      timezone: 'UTC',
      screen: { width: 1, height: 1, pixelRatio: 1 },
    })
    expect(info.clientId).toBe('client-fallback') // getItem threw → generated
    expect(info.sessionId).toBe('s1')
  })

  it('a failing browser client-info read does not silently lose the batch (emergency fallback → outbox persists)', async () => {
    // No buildClientInfo injected → createBrowserClientInfo uses readBrowserClientInfo →
    // window.localStorage throws (node test env has no window) → emergencyClientInfo.
    // The batch must still land in the durable outbox, NOT be silently dropped.
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    const clock = 1000
    __setRemoteDebugTestHooks({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      random: () => 0.5,
      enabled: true, // no buildClientInfo → exercises the fail-safe default path
    })

    reportRemoteDebugEntry({ level: 'error', source: 'S', message: 'm', timestamp: 1000 })
    await flushRemoteDebugEntries()
    // Batch persisted to the durable outbox despite the client-info read failing.
    expect(await getRemoteDebugOutboxCount()).toBe(1)
    expect(await getRemoteDebugDropCount()).toBe(0)
  })
})

// ── T2-4: error 级上报附带 stack(≤2KB 截断;warning 级不带,控体积)──

describe('T2-4 stack capture on error-level entries', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await __resetRemoteDebugStateForTest()
  })

  afterEach(async () => {
    await __resetRemoteDebugStateForTest()
  })

  it('clamps error-entry stacks to 2KB with a truncation marker', () => {
    const hugeStack = `Error: huge\n${'    at frame (file.ts:1:1)\n'.repeat(200)}`
    const payload = buildRemoteDebugPayload(
      [{ level: 'error', source: 'Canvas', message: 'boom', timestamp: 1, stack: hugeStack }],
      fixedClientInfo(),
    )

    expect(payload.entries).toHaveLength(1)
    const stack = payload.entries[0]!.stack
    expect(stack).toBeDefined()
    expect(stack!.length).toBeLessThanOrEqual(2048 + '... [truncated]'.length)
    expect(stack!.endsWith('... [truncated]')).toBe(true)
  })

  it('drops stacks from warning-level entries (error-only field)', () => {
    const payload = buildRemoteDebugPayload(
      [
        { level: 'warning', source: 'Settings', message: 'warn', timestamp: 1, stack: 'Error: w\n    at x (a.ts:1:1)' },
        { level: 'error', source: 'Canvas', message: 'boom', timestamp: 2, stack: 'Error: e\n    at y (b.ts:2:2)' },
      ],
      fixedClientInfo(),
    )

    expect(payload.entries).toHaveLength(2)
    expect('stack' in payload.entries[0]!).toBe(false)
    expect(payload.entries[1]!.stack).toContain('b.ts:2:2')
  })

  it('debugLogger.error(source, message, error) forwards error.stack into the remote payload', async () => {
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return { ok: true, status: 200 } as Response
    })
    __setRemoteDebugTestHooks({
      fetchImpl: fetchMock as unknown as typeof fetch,
      buildClientInfo: fixedClientInfo,
      enabled: true,
    })

    debugLogger.error('Canvas Sync', 'sync failed', new Error('sync failed'))
    await flushRemoteDebugEntries()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(bodies[0]!) as { entries: Array<{ level: string; stack?: string }> }
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0]!.level).toBe('error')
    expect(payload.entries[0]!.stack).toContain('sync failed')
    expect(payload.entries[0]!.stack).toMatch(/at /)
  })
})
