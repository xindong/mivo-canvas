// @vitest-environment node
// server/__tests__/tasks-settle.test.ts
// FX-3 (route-level): POST /api/mivo/tasks/settle — batch per-user task status
// query for hydrate-time reconciliation. Reuses FX-2's getTaskForOwner: only
// tasks the caller owns AND that still exist are returned; gone / non-owner /
// never-existed are omitted (the client treats as expired). 404 semantics
// unchanged (absence is indistinguishable from gone).
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../app'
import { createTask, completeTask, __resetTaskRegistry } from '../tasks/registry'

const KEY_A = 'mivo_aaa_user_a'
const KEY_B = 'mivo_bbb_user_b'

const post = (key: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-mivo-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('FX-3 POST /api/mivo/tasks/settle', () => {
  beforeEach(() => __resetTaskRegistry())

  it('returns TaskViews for owned+existing tasks; omits gone / non-owner / never-existed', async () => {
    const { record: aDone } = createTask('edit', 'gpt-image-2', 'req-1', KEY_A)
    completeTask(aDone.id, { images: [{ b64: 'img-a' }] })
    const { record: aRunning } = createTask('edit', 'gpt-image-2', 'req-2', KEY_A)
    const { record: bTask } = createTask('edit', 'gpt-image-2', 'req-3', KEY_B) // owned by B

    const res = await app.request(
      '/api/mivo/tasks/settle',
      post(KEY_A, { taskIds: [aDone.id, aRunning.id, bTask.id, 'never-existed'] }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Record<string, { id: string; status: string }> }
    // aDone + aRunning returned (owned by A + existing); bTask omitted (non-owner);
    // never-existed omitted — all absent taskIds are indistinguishable (no leak).
    expect(Object.keys(body.results).sort()).toEqual([aDone.id, aRunning.id].sort())
    expect(body.results[aDone.id].status).toBe('done')
    expect(body.results[aRunning.id].status).toBe('pending')
    expect(body.results[bTask.id]).toBeUndefined()
    expect(body.results['never-existed']).toBeUndefined()
  })

  it('empty taskIds → 200 {results:{}}', async () => {
    const res = await app.request('/api/mivo/tasks/settle', post(KEY_A, { taskIds: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: {} })
  })

  it('missing / non-array taskIds → 200 {results:{}} (defensive, no 400)', async () => {
    const res = await app.request('/api/mivo/tasks/settle', post(KEY_A, {}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: {} })
  })

  it('malformed X-Mivo-Api-Key → 400 (boundary rejects, no env fallback)', async () => {
    const res = await app.request('/api/mivo/tasks/settle', {
      method: 'POST',
      headers: { 'x-mivo-api-key': 'not-a-mivo-key', 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: ['x'] }),
    })
    expect(res.status).toBe(400)
  })

  it('caps the batch at 64 (rest silently dropped, no unbounded enumeration)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 70; i++) {
      ids.push(createTask('edit', 'gpt-image-2', `req-${i}`, KEY_A).record.id)
    }
    const res = await app.request('/api/mivo/tasks/settle', post(KEY_A, { taskIds: ids }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Record<string, unknown> }
    expect(Object.keys(body.results)).toHaveLength(64)
  })

  it('result images are NOT leaked for a non-owner (cross-user settle omits, no data exposure)', async () => {
    const { record } = createTask('edit', 'gpt-image-2', 'req-1', KEY_A)
    completeTask(record.id, { images: [{ b64: 'secret-image' }] })
    const res = await app.request('/api/mivo/tasks/settle', post(KEY_B, { taskIds: [record.id] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Record<string, unknown> }
    expect(body.results).toEqual({}) // B learns nothing — not even existence
  })
})
