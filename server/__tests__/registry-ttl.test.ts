// @vitest-environment node
// server/__tests__/registry-ttl.test.ts
// V02: terminal-task TTL eviction. Drives the real registry with fake timers
// (no HTTP, no mock upstream) — verifies the sweeper (a) deletes only terminal
// tasks older than TERMINAL_TTL_MS, (b) drops their idempotencyIndex entries in
// lockstep, (c) leaves non-terminal and unexpired terminal tasks alone, and
// (d) the lazily-started interval actually fires the sweep.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTask,
  completeTask,
  completePartialTask,
  failTask,
  cancelTask,
  getTask,
  __resetTaskRegistry,
  __sweepTerminalTasks,
} from '../tasks/registry'

// FX-2: createTask takes an ownerKey (4th arg) for per-user partition. The TTL
// mechanics are owner-agnostic, so one fixed owner is fine across these cases.
const OWNER = 'mivo_ttl_owner'

describe('V02 registry TTL sweeper', () => {
  beforeEach(() => {
    // now:0 → Date.now() starts at 0 so terminalAt is deterministic and
    // advanceTimersByTime(ms) lands on exact TTL boundaries.
    vi.useFakeTimers({ now: 0 })
    __resetTaskRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts terminal tasks past TTL + their idempotency keys; retains unexpired + non-terminal', () => {
    const { record: doneTask } = createTask('generate', 'gpt-image-2', 'req-1', OWNER, 'idem-1')
    completeTask(doneTask.id, { images: [{ b64: 'a' }] })
    // a non-terminal task — pending, no terminalAt — must never be swept
    const { record: pendingTask } = createTask('generate', 'gpt-image-2', 'req-2', OWNER)
    expect(getTask(doneTask.id)?.terminalAt).toBe(0)
    expect(getTask(pendingTask.id)?.terminalAt).toBeUndefined()

    // 9 min in — both retained (under TTL)
    vi.advanceTimersByTime(9 * 60_000)
    __sweepTerminalTasks()
    expect(getTask(doneTask.id)).toBeDefined()
    expect(getTask(pendingTask.id)).toBeDefined()

    // 2 more min (total 11 min, past TTL) — doneTask swept, pendingTask retained
    vi.advanceTimersByTime(2 * 60_000)
    __sweepTerminalTasks()
    expect(getTask(doneTask.id)).toBeUndefined()
    expect(getTask(pendingTask.id)).toBeDefined()

    // idempotencyIndex cleaned in lockstep (owner-scoped composite key): reusing
    // the key creates a new task
    const reuse = createTask('generate', 'gpt-image-2', 'req-3', OWNER, 'idem-1')
    expect(reuse.created).toBe(true)
    expect(reuse.record.id).not.toBe(doneTask.id)
  })

  it('TTL boundary: retained at exactly 10 min, swept just past', () => {
    const { record: t } = createTask('generate', 'gpt-image-2', 'req-1', OWNER, 'idem-1')
    completeTask(t.id, { images: [{ b64: 'a' }] })

    vi.advanceTimersByTime(10 * 60_000) // exactly TTL — strict `>` keeps it
    __sweepTerminalTasks()
    expect(getTask(t.id)).toBeDefined()

    vi.advanceTimersByTime(1) // 1 ms past TTL
    __sweepTerminalTasks()
    expect(getTask(t.id)).toBeUndefined()
  })

  it('sweeps all four terminal statuses', () => {
    const { record: done } = createTask('generate', 'm', 'r1', OWNER)
    const { record: partial } = createTask('variations', 'm', 'r2', OWNER, undefined, { batchId: 'b1', count: 2 })
    const { record: failed } = createTask('edit', 'm', 'r3', OWNER)
    const { record: canceled } = createTask('generate', 'm', 'r4', OWNER)
    completeTask(done.id, { images: [{ b64: 'a' }] })
    completePartialTask(partial.id, { images: [{ b64: 'p', variationIndex: 0 }] }, [{ variationIndex: 1, error: 'boom' }])
    failTask(failed.id, 'boom')
    cancelTask(canceled.id)

    expect(getTask(done.id)?.terminalAt).toBe(0)
    expect(getTask(partial.id)?.terminalAt).toBe(0)
    expect(getTask(failed.id)?.terminalAt).toBe(0)
    expect(getTask(canceled.id)?.terminalAt).toBe(0)

    vi.advanceTimersByTime(10 * 60_000 + 1)
    __sweepTerminalTasks()
    expect(getTask(done.id)).toBeUndefined()
    expect(getTask(partial.id)).toBeUndefined()
    expect(getTask(failed.id)).toBeUndefined()
    expect(getTask(canceled.id)).toBeUndefined()
  })

  it('the lazily-started interval fires the sweep automatically', () => {
    const { record: t } = createTask('generate', 'gpt-image-2', 'req-1', OWNER, 'idem-1')
    completeTask(t.id, { images: [{ b64: 'a' }] })
    // no manual __sweepTerminalTasks() — rely on the 60s interval firing under
    // fake timers. Advancing 11 min fires ~11 sweeps; the >10min one evicts.
    vi.advanceTimersByTime(11 * 60_000)
    expect(getTask(t.id)).toBeUndefined()
  })
})
