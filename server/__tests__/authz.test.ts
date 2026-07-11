// server/__tests__/authz.test.ts
// T1.4 authz 纯函数单测:角色矩阵(roleCan)+ 分享矩阵(shareCan)+ decideAccess(派生 owner 优先)+ denyStatus(404/403)。
// 权威:docs/decisions/permission-schema.md §2 矩阵。
import { describe, it, expect } from 'vitest'
import { roleCan, shareCan, decideAccess, denyStatus, type AuthzInfo } from '../lib/authz'

describe('T1.4 authz 纯函数 — 角色矩阵', () => {
  it('owner:read/write/move/manage 全 allow', () => {
    for (const a of ['read', 'write', 'move', 'manage'] as const) {
      expect(roleCan('owner', a)).toBe('allow')
    }
  })
  it('editor:read/write allow;move/manage deny', () => {
    expect(roleCan('editor', 'read')).toBe('allow')
    expect(roleCan('editor', 'write')).toBe('allow')
    expect(roleCan('editor', 'move')).toBe('deny')
    expect(roleCan('editor', 'manage')).toBe('deny')
  })
  it('viewer:read allow;write/move/manage deny', () => {
    expect(roleCan('viewer', 'read')).toBe('allow')
    expect(roleCan('viewer', 'write')).toBe('deny')
    expect(roleCan('viewer', 'move')).toBe('deny')
    expect(roleCan('viewer', 'manage')).toBe('deny')
  })
})

describe('T1.4 authz 纯函数 — 分享矩阵(≤ editor,不授 manage/move)', () => {
  it('edit:read/write allow;move/manage deny', () => {
    expect(shareCan('edit', 'read')).toBe('allow')
    expect(shareCan('edit', 'write')).toBe('allow')
    expect(shareCan('edit', 'move')).toBe('deny')
    expect(shareCan('edit', 'manage')).toBe('deny')
  })
  it('view:read allow;write/move/manage deny', () => {
    expect(shareCan('view', 'read')).toBe('allow')
    expect(shareCan('view', 'write')).toBe('deny')
    expect(shareCan('view', 'move')).toBe('deny')
    expect(shareCan('view', 'manage')).toBe('deny')
  })
})

describe('T1.4 decideAccess — 派生 owner 优先 → member → share → deny', () => {
  const owner = (actor: string): AuthzInfo => ({ actor, ownerId: 'alice' })
  it('actor===ownerId → owner(派生,无需 member 行;T1.3 owner===actor 自归属)', () => {
    expect(decideAccess(owner('alice'), 'manage')).toBe('allow') // owner 派生,manage allow
  })
  it('member editor:write allow;manage deny', () => {
    const info: AuthzInfo = { actor: 'bob', ownerId: 'alice', memberRole: 'editor' }
    expect(decideAccess(info, 'write')).toBe('allow')
    expect(decideAccess(info, 'manage')).toBe('deny')
  })
  it('member viewer:write deny', () => {
    const info: AuthzInfo = { actor: 'carol', ownerId: 'alice', memberRole: 'viewer' }
    expect(decideAccess(info, 'write')).toBe('deny')
    expect(decideAccess(info, 'read')).toBe('allow')
  })
  it('share edit:write allow;manage deny(actor=null 未认证)', () => {
    const info: AuthzInfo = { actor: null, ownerId: 'alice', sharePermission: 'edit' }
    expect(decideAccess(info, 'write')).toBe('allow')
    expect(decideAccess(info, 'manage')).toBe('deny')
  })
  it('share view:write deny', () => {
    const info: AuthzInfo = { actor: null, ownerId: 'alice', sharePermission: 'view' }
    expect(decideAccess(info, 'write')).toBe('deny')
    expect(decideAccess(info, 'read')).toBe('allow')
  })
  it('派生 owner 优先于 memberRole(即便有 stale 行也认 owner)', () => {
    // actor===ownerId 但 memberRole='editor'(stale)→ 仍按 owner(派生优先,§3)
    const info: AuthzInfo = { actor: 'alice', ownerId: 'alice', memberRole: 'editor' }
    expect(decideAccess(info, 'manage')).toBe('allow') // owner,not editor
  })
  it('无 member 无 share → deny(非成员)', () => {
    const info: AuthzInfo = { actor: 'eve', ownerId: 'alice' }
    expect(decideAccess(info, 'read')).toBe('deny')
  })
})

describe('T1.4 denyStatus — 404(非成员,无泄漏)/403(成员越权)', () => {
  it('非成员 → 404', () => {
    expect(denyStatus({ actor: 'eve', ownerId: 'alice' })).toBe(404)
  })
  it('成员越权 → 403', () => {
    expect(denyStatus({ actor: 'bob', ownerId: 'alice', memberRole: 'editor' })).toBe(403)
    expect(denyStatus({ actor: 'carol', ownerId: 'alice', memberRole: 'viewer' })).toBe(403)
  })
  it('分享越权 → 403', () => {
    expect(denyStatus({ actor: null, ownerId: 'alice', sharePermission: 'view' })).toBe(403)
  })
})
