// src/kernel/sessionStore.test.ts
// T1.2 S2:MemorySessionStore selection CRUD + per-user/per-canvas 隔离 + defensive copy 单测。
// DP-1:selection per user+canvas,session scope,不双写 document。

import { describe, expect, it } from 'vitest'
import { createSessionStore } from './sessionStore'

describe('T1.2 S2 MemorySessionStore — selection CRUD + 隔离', () => {
  it('set/get/clear selection', () => {
    const s = createSessionStore()
    s.setSelection('c1', 'u1', ['n1', 'n2'])
    expect(s.getSelection('c1', 'u1')).toEqual(['n1', 'n2'])
    expect(s.clearSelection('c1', 'u1')).toBe(true)
    expect(s.getSelection('c1', 'u1')).toBeUndefined()
    expect(s.clearSelection('c1', 'u1')).toBe(false)
  })

  it('per-user isolation: 同 canvas 不同 user 不共享 selection (DP-1)', () => {
    const s = createSessionStore()
    s.setSelection('c1', 'u1', ['n1'])
    s.setSelection('c1', 'u2', ['n2'])
    expect(s.getSelection('c1', 'u1')).toEqual(['n1'])
    expect(s.getSelection('c1', 'u2')).toEqual(['n2'])
    // 清 u1 不影响 u2
    s.clearSelection('c1', 'u1')
    expect(s.getSelection('c1', 'u1')).toBeUndefined()
    expect(s.getSelection('c1', 'u2')).toEqual(['n2'])
  })

  it('per-canvas isolation: 同 user 不同 canvas 不共享', () => {
    const s = createSessionStore()
    s.setSelection('c1', 'u1', ['n1'])
    s.setSelection('c2', 'u1', ['n2'])
    expect(s.getSelection('c1', 'u1')).toEqual(['n1'])
    expect(s.getSelection('c2', 'u1')).toEqual(['n2'])
  })

  it('defensive copy: mutate 返回的 selection 不影响 store', () => {
    const s = createSessionStore()
    s.setSelection('c1', 'u1', ['n1'])
    const got = s.getSelection('c1', 'u1')!
    got.push('hacked')
    expect(s.getSelection('c1', 'u1')).toEqual(['n1']) // store 未变
  })

  it('tasksScopeNote 是 DP-8 占位标注', () => {
    const s = createSessionStore()
    expect(s.tasksScopeNote).toContain('FX-2')
    expect(s.tasksScopeNote).toContain('DP-8')
  })
})
