import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './serverPersistAdapter'
import type { NodeRecord } from '../kernel/records'
import { abortPendingCanvasSyncCreate, createFetchCanvasSyncPort } from './canvasSyncPortClient'
import { buildBundle, unwrapBundle } from './snapshotCursorBundle'
import { __resetCanvasCursorStore, getCanvasCursor, setCanvasCursor } from './snapshotCursorStore'

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const headerValue = (headers: HeadersInit | undefined, key: string): string | undefined => {
  if (!headers) return undefined
  const target = key.toLowerCase()
  for (const [headerKey, value] of Object.entries(headers as Record<string, string>)) {
    if (headerKey.toLowerCase() === target) return value
  }
  return undefined
}

const imageRecord = (id: string): NodeRecord => ({
  id,
  type: 'image',
  title: `Node ${id}`,
  revision: 0,
  transform: { x: 10, y: 20, width: 120, height: 80, rotation: 0 },
  fills: [],
  strokes: [],
  effects: [],
  relations: {},
  hidden: false,
})

describe('createFetchCanvasSyncPort(Block 1 write driving)', () => {
  beforeEach(() => {
    __resetCanvasCursorStore()
  })

  it('maps edit delete-field intents to wire unset ops', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; ifMatch?: string }> = []
    const fetch: FetchLike = vi.fn(async (input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: headerValue(init?.headers, 'If-Match'),
      })
      return jsonResponse(200, { id: 'n1', revision: 1, seq: 2, base: 'base:n1:r2' })
    })
    const port = createFetchCanvasSyncPort({
      fetch,
      getAuthHeaders: async () => ({}),
    })

    setCanvasCursor('c1', buildBundle('c1', { n1: 'base:n1:r1' }, 7, 1))

    await port.submitChange('c1', {
      kind: 'edit-node',
      nodeId: 'n1',
      intents: [{ op: 'delete-field', fieldPath: ['sectionLockMode'] }],
    })

    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/canvas/c1/nodes/n1',
        body: [{ kind: 'unset', fieldPath: ['sectionLockMode'] }],
        ifMatch: 'base:n1:r1',
      },
    ])
  })

  // PR-C1 CR-6:409 `{error:'archived'}` 必须映射为独立 rejected reason 'archived',而非 revision-conflict
  //   (archived canvas 可读,若当 conflict 处理会 refetch 出可读 cursor 假装编辑可继续 → 编辑静默丢)。
  it('maps 409 {error:archived} to rejected reason archived (NOT conflict) — edit on archived canvas', async () => {
    const fetch: FetchLike = vi.fn(async () => jsonResponse(409, { error: 'archived' }))
    const port = createFetchCanvasSyncPort({ fetch, getAuthHeaders: async () => ({}) })
    setCanvasCursor('c1', buildBundle('c1', { n1: 'base:n1:r1' }, 7, 1))

    const outcome = await port.submitChange('c1', {
      kind: 'edit-node',
      nodeId: 'n1',
      intents: [{ op: 'set', fieldPath: ['title'], value: 'renamed' }],
    })

    expect(outcome).toEqual({
      kind: 'rejected',
      reason: 'archived',
      detail: 'canvas archived (CR-6); restore before editing',
    })
  })

  it('create-node 409 {error:archived} surfaces rejected archived (held edits resolve dependency-failed)', async () => {
    const fetch: FetchLike = vi.fn(async () => jsonResponse(409, { error: 'archived' }))
    const port = createFetchCanvasSyncPort({ fetch, getAuthHeaders: async () => ({}) })

    const outcome = await port.submitChange('c1', { kind: 'create-node', node: imageRecord('n-new') })

    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('archived')
  })

  it('uses the created record id as clientId and holds same-record edits until create ack refreshes base', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; ifMatch?: string }> = []
    let resolveCreate!: (response: Response) => void
    const createPending = new Promise<Response>((resolve) => {
      resolveCreate = resolve
    })
    const fetch: FetchLike = vi.fn((input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: headerValue(init?.headers, 'If-Match'),
      })
      if (init?.method === 'POST') return createPending
      return Promise.resolve(jsonResponse(200, { id: 'client-n1', revision: 2, seq: 3, base: 'base:client-n1:r2' }))
    })
    const port = createFetchCanvasSyncPort({
      fetch,
      getAuthHeaders: async () => ({}),
    })

    const createPromise = port.submitChange('c1', {
      kind: 'create-node',
      node: imageRecord('client-n1'),
    })
    const editPromise = port.submitChange('c1', {
      kind: 'edit-node',
      nodeId: 'client-n1',
      intents: [{ op: 'set', fieldPath: ['title'], value: 'Renamed' }],
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(1)

    resolveCreate(jsonResponse(200, { id: 'client-n1', revision: 1, seq: 2, base: 'base:client-n1:r1' }))
    await createPromise
    await editPromise

    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/canvas/c1/nodes/client-n1',
      body: {
        clientId: 'client-n1',
        type: 'node',
      },
    })
    expect((calls[0].body as { payload: Record<string, unknown> }).payload).not.toHaveProperty('id')
    expect((calls[0].body as { payload: Record<string, unknown> }).payload).not.toHaveProperty('revision')
    expect(calls[1]).toEqual({
      method: 'PATCH',
      path: '/api/canvas/c1/nodes/client-n1',
      body: [{ kind: 'set', fieldPath: ['title'], value: 'Renamed' }],
      ifMatch: 'base:client-n1:r1',
    })
  })

  it('accepted edits update only the touched bundle entry', async () => {
    const fetch: FetchLike = vi.fn(async () =>
      jsonResponse(200, { id: 'n1', revision: 2, seq: 4, base: 'base:n1:r2' }),
    )
    const port = createFetchCanvasSyncPort({
      fetch,
      getAuthHeaders: async () => ({}),
    })

    setCanvasCursor('c1', buildBundle('c1', { n1: 'base:n1:r1', n2: 'base:n2:r1' }, 9, 3))

    await port.submitChange('c1', {
      kind: 'edit-node',
      nodeId: 'n1',
      intents: [{ op: 'set', fieldPath: ['title'], value: 'Next' }],
    })

    expect(unwrapBundle(getCanvasCursor('c1'))).toEqual({
      canvasId: 'c1',
      records: { n1: 'base:n1:r2', n2: 'base:n2:r1' },
      orderCv: 9,
      sinceSeq: 4,
    })
  })

  it('retryable create can be explicitly abandoned so held edits resolve instead of hanging forever', async () => {
    let resolveCreate!: (response: Response) => void
    const createPending = new Promise<Response>((resolve) => {
      resolveCreate = resolve
    })
    const fetch: FetchLike = vi.fn((input, init) => {
      void input
      if (init?.method === 'POST') return createPending
      return Promise.resolve(jsonResponse(200, { id: 'n1', revision: 2, seq: 3, base: 'base:n1:r2' }))
    })
    const port = createFetchCanvasSyncPort({
      fetch,
      getAuthHeaders: async () => ({}),
    })

    const create = { kind: 'create-node', node: imageRecord('n1') } as const
    const createPromise = port.submitChange('c1', create)
    const editPromise = port.submitChange('c1', {
      kind: 'edit-node',
      nodeId: 'n1',
      intents: [{ op: 'set', fieldPath: ['title'], value: 'later' }],
    })

    await Promise.resolve()
    resolveCreate(jsonResponse(503, { error: 'upstream-busy' }))
    const createOutcome = await createPromise
    expect(createOutcome).toEqual({ kind: 'retryable', reason: 'http_503' })

    expect(
      abortPendingCanvasSyncCreate(port, 'c1', create, 'submitChange retryable for c1:create-node (http_503)'),
    ).toBe(true)
    await expect(editPromise).resolves.toEqual({
      kind: 'rejected',
      reason: 'dependency-failed',
      detail: 'submitChange retryable for c1:create-node (http_503)',
    })
  })
})
