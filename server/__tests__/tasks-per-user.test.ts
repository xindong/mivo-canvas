// @vitest-environment node
// server/__tests__/tasks-per-user.test.ts
// FX-2 (route-level acceptance): A creates a task; B's GET/DELETE return 404
// 'unknown-task' (same body as an unknown task — no existence leak); A's GET
// returns 200 and A's DELETE returns 200 canceled. Drives the real app in-process
// via app.request so the full boundary — rejectInvalidMivoApiKey +
// resolvePlatformCtx + getTaskForOwner — is exercised end-to-end. The owner is
// the X-Mivo-Api-Key header (per-user credential), fingerprinted by the registry.
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../app'
import { createTask, __resetTaskRegistry } from '../tasks/registry'

const KEY_A = 'mivo_aaa_user_a'
const KEY_B = 'mivo_bbb_user_b'

const hdr = (key: string): Record<string, string> => ({ 'x-mivo-api-key': key })

describe('FX-2 tasks route per-user isolation', () => {
  beforeEach(() => __resetTaskRegistry())

  it('A creates task → B GET 404 unknown-task, A GET 200', async () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)

    const resB = await app.request(`/api/mivo/tasks/${record.id}`, { headers: hdr(KEY_B) })
    expect(resB.status).toBe(404)
    expect(await resB.json()).toEqual({ error: 'unknown-task' })

    const resA = await app.request(`/api/mivo/tasks/${record.id}`, { headers: hdr(KEY_A) })
    expect(resA.status).toBe(200)
    const body = await resA.json()
    expect((body as { id: string }).id).toBe(record.id)
  })

  it('404 body identical for cross-user vs unknown task (no existence leak)', async () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)
    const crossUser = await app.request(`/api/mivo/tasks/${record.id}`, { headers: hdr(KEY_B) })
    const unknown = await app.request('/api/mivo/tasks/00000000-0000-0000-0000-000000000000', {
      headers: hdr(KEY_B),
    })
    expect(crossUser.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await crossUser.json()).toEqual(await unknown.json())
  })

  it('B DELETE on A task → 404 (no cancel, no leak); A DELETE → 200 canceled', async () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)

    const resB = await app.request(`/api/mivo/tasks/${record.id}`, { method: 'DELETE', headers: hdr(KEY_B) })
    expect(resB.status).toBe(404)
    // B's 404 DELETE did NOT cancel A's task — A can still read it.
    const resA = await app.request(`/api/mivo/tasks/${record.id}`, { headers: hdr(KEY_A) })
    expect(resA.status).toBe(200)

    const delA = await app.request(`/api/mivo/tasks/${record.id}`, { method: 'DELETE', headers: hdr(KEY_A) })
    expect(delA.status).toBe(200)
    expect(((await delA.json()) as { status: string }).status).toBe('canceled')
  })

  it('malformed X-Mivo-Api-Key on GET → 400 (boundary rejects, no env fallback)', async () => {
    const res = await app.request('/api/mivo/tasks/abc', { headers: { 'x-mivo-api-key': 'not-a-mivo-key' } })
    expect(res.status).toBe(400)
  })

  it('no key + empty env → owner is the shared fallback bucket (dev/legacy parity, not a cross-user leak between keyed users)', async () => {
    // With no header and no MIVO_PLATFORM_KEY, ownerKey resolves to '' — a stable
    // fallback fingerprint. Two no-key callers share it (dev parity); a keyed user
    // (KEY_A) does NOT see a no-key task (different fingerprint → 404).
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', '')
    const keyedGet = await app.request(`/api/mivo/tasks/${record.id}`, { headers: hdr(KEY_A) })
    expect(keyedGet.status).toBe(404)
  })
})
