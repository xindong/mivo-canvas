// @vitest-environment node
// server/__tests__/c1a.test.ts
// P2-C1a: async task registry + real progress + upstream cancel. Drives the real
// BFF (app + @hono/node-server) against the local mock upstream. Covers:
//  - progress monotonic + stage-driven (platform: 10→20-90→95→100; not hardcoded)
//  - cancel stops platform poll (mock no longer polled) + status=canceled + no result
//  - cancel stops llm-proxy fetch
//  - idempotency key returns same taskId
//  - unknown task 404
//  - N concurrent tasks don't cross-talk
//  - bad request (missing prompt) → 400
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { app } from '../app'
import { resetPlatformState } from '../platform/state'
import { __resetTaskRegistry } from '../tasks/registry'
import { defaultMockState, startMockUpstream, type MockState } from './mockUpstream'

type TaskView = {
  id: string
  kind: string
  status: string
  progress: number
  stage: string
  requestId: string
  model: string
  result?: { images: Array<{ b64: string }> }
  error?: string
}

const BASE_ENV: Record<string, string> = {
  MIVO_PLATFORM_KEY: 'mivo_test',
  MIVO_IMAGE_API_KEY: 'sk_test',
  MIVO_LLM_API_KEY: 'sk_test',
  MIVO_UPSTREAM_TIMEOUT_MS: '5000',
  MIVO_EDIT_UPSTREAM_TIMEOUT_MS: '5000',
  MIVO_PLATFORM_POLL_DEADLINE_MS: '600',
  MIVO_PLATFORM_POLL_INTERVAL_MS: '20',
}

let bffServer: Server
let bffBase = ''
let mockState: MockState
let mockUrl = ''
let mockServer: Server

const applyEnv = (overrides: Record<string, string> = {}): void => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v
  process.env.MIVO_PLATFORM_ENDPOINT = mockUrl
  process.env.MIVO_IMAGE_API_BASE = `${mockUrl}/v1/images`
  process.env.MIVO_LLM_API_BASE = `${mockUrl}/v1`
  delete process.env.MIVO_BFF_TOKEN
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v
}

const req = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(bffBase + path, init)
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body }
}

const asTask = (body: unknown): TaskView => body as TaskView
const field = (body: unknown, key: string): unknown => (body as Record<string, unknown>)[key]

const jsonReq = (body: unknown, extraHeaders: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body),
})

beforeAll(async () => {
  mockState = defaultMockState()
  const up = await startMockUpstream(mockState)
  mockServer = up.server
  mockUrl = up.url
  mockState.downloadUrl = mockUrl
  applyEnv()
  await new Promise<void>((resolve) => {
    bffServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      bffBase = `http://${info.address}:${info.port}`
      resolve()
    }) as unknown as Server
  })
})

afterAll(async () => {
  await new Promise<void>((r) => bffServer.close(() => r()))
  await new Promise<void>((r) => mockServer.close(() => r()))
})

beforeEach(() => {
  resetPlatformState()
  __resetTaskRegistry()
  Object.assign(mockState, defaultMockState())
  mockState.downloadUrl = mockUrl
})

const pollTask = async (
  taskId: string,
  until: (b: TaskView) => boolean,
  timeoutMs = 2000,
  sample?: (b: TaskView) => void,
): Promise<TaskView | null> => {
  const t0 = Date.now()
  let last: TaskView | null = null
  while (Date.now() - t0 < timeoutMs) {
    const r = await req(`/api/mivo/tasks/${taskId}`)
    if (r.status === 200) {
      last = asTask(r.body)
      sample?.(last)
      if (until(last)) return last
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return last
}

describe('C1a — progress is monotonic + stage-driven (not hardcoded)', () => {
  it('platform generate: 10 → poll(20-90) → 95 → 100, monotonic', async () => {
    mockState.pollSequence = ['pending', 'pending', 'pending', 'pending', 'completed']
    mockState.downloadDelayMs = 80 // make the 'download' stage sampleable by GET polling
    const create = await req('/api/mivo/tasks/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(create.status).toBe(202)
    const taskId = field(create.body, 'taskId') as string

    const samples: Array<{ progress: number; stage: string }> = []
    const done = await pollTask(
      taskId,
      (b) => b.status === 'done' || b.status === 'failed',
      2000,
      (b) => samples.push({ progress: b.progress, stage: b.stage }),
    )
    expect(done).not.toBeNull()
    expect(done!.status).toBe('done')
    expect(done!.progress).toBe(100)
    expect(done!.result?.images?.[0]?.b64).toBeTruthy()

    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].progress).toBeGreaterThanOrEqual(samples[i - 1].progress)
    }
    const stages = samples.map((s) => s.stage)
    expect(stages).toContain('submit')
    expect(samples.find((s) => s.stage === 'submit')?.progress).toBe(10)
    const pollSamples = samples.filter((s) => s.stage === 'poll')
    expect(pollSamples.length).toBeGreaterThan(0)
    for (const s of pollSamples) {
      expect(s.progress).toBeGreaterThanOrEqual(20)
      expect(s.progress).toBeLessThanOrEqual(90)
    }
    expect(stages).toContain('download')
    expect(samples.find((s) => s.stage === 'download')?.progress).toBe(95)
    if (pollSamples.length >= 2) {
      expect(pollSamples[pollSamples.length - 1].progress).toBeGreaterThan(pollSamples[0].progress)
    }
  })

  it('llm-proxy generate: coarse 10 → 100', async () => {
    const create = await req('/api/mivo/tasks/generate', jsonReq({ prompt: 'a cat', model: 'doubao-seedance-2-0-260128' }))
    expect(create.status).toBe(202)
    const done = await pollTask(field(create.body, 'taskId') as string, (b) => b.status === 'done' || b.status === 'failed')
    expect(done).not.toBeNull()
    expect(done!.status).toBe('done')
    expect(done!.progress).toBe(100)
    expect(done!.result?.images?.[0]?.b64).toBeTruthy()
  })
})

describe('C1a — cancel propagates to upstream', () => {
  it('platform: DELETE stops the poll loop + canceled + no result', async () => {
    mockState.pollSequence = ['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'completed']
    const create = await req('/api/mivo/tasks/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    const taskId = field(create.body, 'taskId') as string

    // Wait for the poll loop to actually land at least one poll request (stage
    // 'poll' is reported before the fetch, so counting mock calls is the
    // deterministic signal that polling has started).
    const t0 = Date.now()
    while (Date.now() - t0 < 1500 && mockState.pollCalls === 0) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const pollCallsAtCancel = mockState.pollCalls
    expect(pollCallsAtCancel).toBeGreaterThan(0)

    const del = await req(`/api/mivo/tasks/${taskId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ id: taskId, status: 'canceled' })

    await new Promise((r) => setTimeout(r, 150))
    const pollCallsAfter = mockState.pollCalls
    expect(pollCallsAfter - pollCallsAtCancel).toBeLessThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 120))
    expect(mockState.pollCalls).toBe(pollCallsAfter)

    const view = await req(`/api/mivo/tasks/${taskId}`)
    expect(asTask(view.body).status).toBe('canceled')
    expect(asTask(view.body).result).toBeUndefined()
  })

  it('llm-proxy: DELETE aborts the upstream fetch', async () => {
    mockState.generateDelayMs = 1000
    const create = await req('/api/mivo/tasks/generate', jsonReq({ prompt: 'a cat', model: 'doubao-seedance-2-0-260128' }))
    const taskId = field(create.body, 'taskId') as string
    await new Promise((r) => setTimeout(r, 50))
    expect(mockState.generateCalls).toBe(1)
    const del = await req(`/api/mivo/tasks/${taskId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    await new Promise((r) => setTimeout(r, 1200))
    const view = await req(`/api/mivo/tasks/${taskId}`)
    expect(asTask(view.body).status).toBe('canceled')
    expect(asTask(view.body).result).toBeUndefined()
  })
})

describe('C1a — idempotency, 404, concurrency, validation', () => {
  it('Idempotency-Key returns the same taskId on repeat', async () => {
    const a = await req('/api/mivo/tasks/generate', jsonReq({ prompt: 'a', model: 'doubao-seedance-2-0-260128' }, { 'idempotency-key': 'k-1' }))
    const b = await req('/api/mivo/tasks/generate', jsonReq({ prompt: 'a', model: 'doubao-seedance-2-0-260128' }, { 'idempotency-key': 'k-1' }))
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect(field(b.body, 'taskId')).toBe(field(a.body, 'taskId'))
  })

  it('unknown task → 404 {error:"unknown-task"}', async () => {
    const r = await req('/api/mivo/tasks/does-not-exist')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'unknown-task' })
    const d = await req('/api/mivo/tasks/does-not-exist', { method: 'DELETE' })
    expect(d.status).toBe(404)
    expect(d.body).toEqual({ error: 'unknown-task' })
  })

  it('N concurrent tasks do not cross-talk', async () => {
    mockState.pollSequence = ['pending', 'pending', 'completed']
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const c = await req('/api/mivo/tasks/generate', jsonReq({ prompt: `cat-${i}`, model: 'gpt-image-2' }))
      expect(c.status).toBe(202)
      ids.push(field(c.body, 'taskId') as string)
    }
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) {
      const done = await pollTask(id, (b) => b.status === 'done' || b.status === 'failed', 2000)
      expect(done).not.toBeNull()
      expect(done!.status).toBe('done')
      expect(done!.id).toBe(id)
    }
  })

  it('missing prompt → 400', async () => {
    const r = await req('/api/mivo/tasks/generate', jsonReq({}))
    expect(r.status).toBe(400)
    expect(field(r.body, 'error')).toBe('prompt is required')
  })
})

describe('C1a — edit task (platform, no mask)', () => {
  it('completes with a result', async () => {
    const form = new FormData()
    form.append('image', new File([Buffer.from('png-bytes')], 'image.png', { type: 'image/png' }))
    form.append('prompt', 'edit this')
    form.append('model', 'gpt-image-2')
    const create = await req('/api/mivo/tasks/edit', { method: 'POST', body: form })
    expect(create.status).toBe(202)
    const done = await pollTask(field(create.body, 'taskId') as string, (b) => b.status === 'done' || b.status === 'failed', 2000)
    expect(done).not.toBeNull()
    expect(done!.status).toBe('done')
    expect(done!.result?.images?.[0]?.b64).toBeTruthy()
    expect(mockState.uploadCalls).toBe(1)
  })
})
