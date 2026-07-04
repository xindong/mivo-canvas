// src/lib/useResolvedAssetUrl.contract.test.ts
//
// Source-contract guard for the Phase 3a lease wiring inside useResolvedAssetUrl.
//
// Why a source contract (not a runtime render test): the project has no React
// hook render harness (no @testing-library/react, no jsdom/happy-dom — see
// src/canvas/scene-reset.contract.test.ts for the same precedent). The lease's
// runtime semantics are covered by assetUrlLease.test.ts; this test locks the
// WIRING between the hook and the lease so a future edit can't silently break
// the release-exactly-once / pending-unmount contract.
//
// What this asserts:
// 1. The hook imports acquireAssetUrl from the lease module (not resolveAssetUrl
//    directly) — the whole point of 3a is that the hook goes through the lease.
// 2. The .then branch releases when the mount was cancelled (active=false) —
//    pending-unmount is handled HERE, not by the lease.
// 3. The cleanup branch releases only when localRelease is set — mutual
//    exclusion with the .then branch (exactly one release per acquire).
// 4. The return signature is still `string` (three consumers depend on this).
import { describe, expect, it } from 'vitest'
import hookSource from './useResolvedAssetUrl.ts?raw'
import leaseSource from './assetUrlLease.ts?raw'

describe('useResolvedAssetUrl — lease wiring contract (Phase 3a)', () => {
  it('imports acquireAssetUrl from ./assetUrlLease (goes through the lease, not resolveAssetUrl directly)', () => {
    expect(hookSource).toMatch(/from\s+['"]\.\/assetUrlLease['"]/)
    expect(hookSource).toContain('acquireAssetUrl')
    // resolveAssetUrl is no longer imported by the hook — the lease owns IDB
    // resolution. isImportedAssetUrl is still imported (pure predicate, no IO).
    expect(hookSource).not.toMatch(/resolveAssetUrl/)
  })

  it('declares a localRelease variable for the release-once mutual exclusion', () => {
    expect(hookSource).toContain('localRelease')
  })

  it('the .then branch releases when the mount was cancelled (pending-unmount path)', () => {
    // The cancelled branch must call release() so the lease's refcount is balanced
    // when the component unmounted while the lease was still in flight.
    const thenBranch = /if\s*\(\s*!active\s*\)\s*\{[^}]*release\(\)/
    expect(thenBranch.test(hookSource)).toBe(true)
  })

  it('the cleanup branch releases only when localRelease is set (mutual exclusion with .then)', () => {
    const cleanupBranch = /if\s*\(\s*localRelease\s*\)\s*localRelease\(\)/
    expect(cleanupBranch.test(hookSource)).toBe(true)
  })

  it('sets active=false in cleanup so the .then sees the cancelled state', () => {
    expect(hookSource).toContain('active = false')
  })

  it('return signature stays string-only (three consumers depend on this)', () => {
    // The function returns '' / assetUrl / resolvedAsset.url — all strings.
    const returnStrings = hookSource.match(/return\s+([^;\n]+)/g) || []
    expect(returnStrings.length).toBeGreaterThan(0)
    // No JSX, no object return — every return is a string expression.
    for (const ret of returnStrings) {
      expect(ret).not.toMatch(/=>\s*</)
      expect(ret).not.toMatch(/return\s+\{/)
    }
  })
})

describe('assetUrlLease — release contract (locks the contract the hook depends on)', () => {
  it('release is idempotent (released flag) — documented invariant', () => {
    expect(leaseSource).toMatch(/let\s+released\s*=\s*false/)
    expect(leaseSource).toMatch(/if\s*\(\s*released\s*\)\s*return/)
  })

  it('revoke only fires when refCount hits 0', () => {
    expect(leaseSource).toMatch(/entry\.refCount\s*-=\s*1/)
    expect(leaseSource).toMatch(/if\s*\(\s*entry\.refCount\s*>\s*0\s*\)\s*return/)
    expect(leaseSource).toMatch(/URL\.revokeObjectURL\(entry\.blobUrl\)/)
  })

  it('pass-through: non-leaseable URLs return a noop release (no refcount, no revoke)', () => {
    expect(leaseSource).toMatch(/isLeaseable/)
    expect(leaseSource).toMatch(/noopRelease/)
  })
})
