// src/lib/persistIdbStorage.contract.test.ts
// S6a:rawStateStorage 源码契约(防回潮)——raw IDB storage(无 FX-6 namespacedKey),
// 给 migrateV10ToV11/dryRun/rollback 用(Greptile 义务 1:防 double-namespacing)。
// 项目无 IDB runtime 测试 harness,故用源码契约验证结构(防回潮:未来若有人误把
// rawStateStorage 的 key 改回 namespacedKey,或删 export,本测试 fail)。

import { describe, expect, it } from 'vitest'
import source from './persistIdbStorage.ts?raw'

// 提取 rawStateStorage 对象段(到下一个 /** 注释,即 clearCurrentUserCache 前)。
const rawSection = source.match(/export const rawStateStorage = \{[\s\S]*?\n\}(?=\n\n\/\*\*)/)?.[0] ?? ''

describe('S6a rawStateStorage 源码契约 — raw IDB(无 namespacedKey,Greptile 义务 1)', () => {
  it('rawStateStorage exported(给 migrateV10ToV11/dryRun/rollback 用)', () => {
    expect(source).toMatch(/export\s+const\s+rawStateStorage\s*=/)
  })

  it('rawStateStorage 段存在(可提取)', () => {
    expect(rawSection, 'rawStateStorage 段应能提取').toBeTruthy()
  })

  it('rawStateStorage 的 key 不经 namespacedKey(raw IDB,防 double-namespacing)', () => {
    // migrateV10ToV11 内部已 namespacedKey 拼 document/session/ckpt key;rawStateStorage 再套
    // namespacedKey 会 double-namespace。rawStateStorage 的 getItem/setItem/removeItem 用 raw `name`。
    expect(rawSection).not.toMatch(/namespacedKey\(/)
    // store.get(name)/store.delete(name)(raw,非 namespacedKey(name))
    expect(rawSection).toMatch(/store\.get\(name\)/)
    expect(rawSection).toMatch(/store\.delete\(name\)/)
    // setItem put 用 { key: name }(raw,非 namespacedKey(name))
    expect(rawSection).toMatch(/key:\s*name/)
  })

  it('rawStateStorage 复用 runTransaction + localStorage fallback(同 idbStateStorage 语义)', () => {
    expect(rawSection).toMatch(/runTransaction/)
    expect(rawSection).toMatch(/isIdbAvailable\(\)/)
    expect(rawSection).toMatch(/localStorage/) // IDB 不可用时回退
    // quota 错误用 toastFeedback(不静默丢,同 idbStateStorage)
    expect(rawSection).toMatch(/isQuotaError/)
    expect(rawSection).toMatch(/toastFeedback/)
  })
})
