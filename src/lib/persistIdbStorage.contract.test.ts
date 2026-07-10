// src/lib/persistIdbStorage.contract.test.ts
// S6a:rawIdbStorage 源码契约(防回潮)——raw IDB storage(无 FX-6 namespacedKey),
// 给 migrateV10ToV11/dryRun/rollback 用(Greptile 义务 1:防 double-namespacing)。
// Lead 裁决 ③:命名 rawIdbStorage(直白含 IDB,不复用 strictIdbStateStorage DP-7 专用);
// cast as RawStorage 集中在此导出点(调用方直接传,别散落)。
// 项目无 IDB runtime 测试 harness,故源码契约验证结构(防回潮)。

import { describe, expect, it } from 'vitest'
import source from './persistIdbStorage.ts?raw'

// 提取 rawIdbStorage 对象段(到 cast as unknown as RawStorage 结尾)。
const rawSection = source.match(/export const rawIdbStorage = \{[\s\S]*?\} as unknown as RawStorage/)?.[0] ?? ''

describe('S6a rawIdbStorage 源码契约 — raw IDB(Lead ③:命名 + cast 集中导出)', () => {
  it('rawIdbStorage exported(给 migrateV10ToV11/dryRun/rollback 用)', () => {
    expect(source).toMatch(/export\s+const\s+rawIdbStorage\s*=/)
  })

  it('rawIdbStorage 段存在(含 cast as RawStorage 集中导出)', () => {
    expect(rawSection, 'rawIdbStorage 段应能提取(含 cast as unknown as RawStorage)').toBeTruthy()
    expect(rawSection).toMatch(/as unknown as RawStorage/)
  })

  it('cast as RawStorage 集中导出点 + RawStorage 从 persistMigration import(Lead ③:调用方不散落 cast)', () => {
    expect(source).toMatch(/export const rawIdbStorage = \{[\s\S]*?\} as unknown as RawStorage/)
    expect(source).toMatch(/import type \{ RawStorage \} from '\.\.\/kernel\/persistMigration'/)
  })

  it('rawIdbStorage 的 key 不经 namespacedKey(raw IDB,防 double-namespacing,Greptile 义务 1)', () => {
    expect(rawSection).not.toMatch(/namespacedKey\(/)
    expect(rawSection).toMatch(/store\.get\(name\)/)
    expect(rawSection).toMatch(/store\.delete\(name\)/)
    expect(rawSection).toMatch(/key:\s*name/)
  })

  it('rawIdbStorage 复用 runTransaction + localStorage fallback(同 idbStateStorage 语义)', () => {
    expect(rawSection).toMatch(/runTransaction/)
    expect(rawSection).toMatch(/isIdbAvailable\(\)/)
    expect(rawSection).toMatch(/localStorage/)
    expect(rawSection).toMatch(/isQuotaError/)
    expect(rawSection).toMatch(/toastFeedback/)
  })
})
