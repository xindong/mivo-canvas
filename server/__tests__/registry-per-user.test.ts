// @vitest-environment node
// server/__tests__/registry-per-user.test.ts
// FX-2: per-user task registry isolation (unit-level). The registry partitions
// tasks by a fingerprint of the caller's mivo_ platform key
// (server/lib/keys.ts → fingerprintOfPlatformKey). A task created by user A is
// invisible to user B via getTaskForOwner (→ undefined → 404), and idempotency
// keys are scoped per owner (no cross-user collision). Route-level acceptance
// (A creates, B GET → 404) is in tasks-per-user.test.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTask,
  getTask,
  getTaskForOwner,
  cancelTask,
  completeTask,
  __resetTaskRegistry,
} from '../tasks/registry'
import { fingerprintOfPlatformKey } from '../lib/keys'

const KEY_A = 'mivo_aaa_user_a'
const KEY_B = 'mivo_bbb_user_b'

describe('FX-2 registry per-user isolation', () => {
  beforeEach(() => __resetTaskRegistry())

  it('getTaskForOwner: owner sees own task; non-owner gets undefined (→ 404)', () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)
    expect(getTaskForOwner(record.id, KEY_A)).toBeDefined()
    expect(getTaskForOwner(record.id, KEY_B)).toBeUndefined()
  })

  it('404 semantics unchanged: cross-user and genuinely-unknown both return undefined (no existence leak)', () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)
    const crossUser = getTaskForOwner(record.id, KEY_B) // exists, but not yours
    const unknown = getTaskForOwner('00000000-0000-0000-0000-000000000000', KEY_A) // never existed
    expect(crossUser).toBeUndefined()
    expect(unknown).toBeUndefined()
    // Indistinguishable to the caller → same 404 'unknown-task' body.
  })

  it('ownerFp is a fingerprint, not the raw key — raw key never lands on the record', () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)
    expect(record.ownerFp).toBe(fingerprintOfPlatformKey(KEY_A))
    expect(record.ownerFp).not.toBe(KEY_A)
    expect(JSON.stringify(record)).not.toContain(KEY_A)
  })

  it('idempotency scoped per owner: B reusing A idempotency-key creates a NEW task (no collision)', () => {
    const a1 = createTask('generate', 'gpt-image-2', 'req-1', KEY_A, 'idem-shared')
    expect(a1.created).toBe(true)
    // Same idempotency key, different owner → NEW task (not A's)
    const b1 = createTask('generate', 'gpt-image-2', 'req-2', KEY_B, 'idem-shared')
    expect(b1.created).toBe(true)
    expect(b1.record.id).not.toBe(a1.record.id)
    // A reusing own idempotency key → same task (created=false)
    const a2 = createTask('generate', 'gpt-image-2', 'req-3', KEY_A, 'idem-shared')
    expect(a2.created).toBe(false)
    expect(a2.record.id).toBe(a1.record.id)
  })

  it('non-owner cannot cancel (404 path); owner cancels', () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)
    expect(getTaskForOwner(record.id, KEY_B)).toBeUndefined() // B's DELETE → 404, no cancel
    const ownerRecord = getTaskForOwner(record.id, KEY_A)
    expect(ownerRecord).toBeDefined()
    cancelTask(record.id)
    expect(getTask(record.id)?.status).toBe('canceled')
  })

  it('owner fingerprint is deterministic — same key always maps to same partition', () => {
    const { record: r1 } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A)
    const { record: r2 } = createTask('generate', 'gpt-image-2', 'req-2', KEY_A)
    expect(r1.ownerFp).toBe(r2.ownerFp)
    expect(r1.ownerFp).not.toBe(createTask('generate', 'gpt-image-2', 'req-3', KEY_B).record.ownerFp)
  })

  it('terminal completion + later non-owner GET still 404 (owner scope holds post-terminal)', () => {
    const { record } = createTask('generate', 'gpt-image-2', 'req-1', KEY_A, 'idem-term')
    completeTask(record.id, { images: [{ b64: 'a' }] })
    // Done task is still owner-scoped — B cannot read the result.
    expect(getTaskForOwner(record.id, KEY_B)).toBeUndefined()
    expect(getTaskForOwner(record.id, KEY_A)?.status).toBe('done')
  })
})
