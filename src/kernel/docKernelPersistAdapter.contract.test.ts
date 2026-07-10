// src/kernel/docKernelPersistAdapter.contract.test.ts
// S6b-1:DocKernel-backed persist adapter 源码契约(防回潮)。
// Lead ① persist backend:?kernel=new canvasStore persist 读写 document+session 三域 canonical。
// Lead ② session 缺失优雅回退(首次迁移前/被清理后 session 不存在 → 空 session merge)。
// 项目无 IDB runtime 测试 harness,故源码契约验证结构(防回潮);行为测见 persistMigration.test
// (makeStorage mock rawIdbStorage 等价行为——document/session 拆 + corrupt 回退 + rollback 仪式)。

import { describe, expect, it } from 'vitest'
import source from './docKernelPersistAdapter.ts?raw'

describe('S6b-1 docKernelPersistAdapter 源码契约 — DocKernel-backed persist backend', () => {
  it('getItem 读 document+session 两 key(via rawIdbStorage + namespacedKey 拼 documentKey/sessionKey)', () => {
    expect(source).toMatch(/rawIdbStorage\.getItem\(documentKey\(name\)\)/)
    expect(source).toMatch(/rawIdbStorage\.getItem\(sessionKey\(name\)\)/)
  })

  it('getItem merge document+session → single envelope(Lead ① persist backend,session 覆盖 document 顶层)', () => {
    expect(source).toMatch(/\.\.\.docState.*\.\.\.sessState/)
  })

  it('getItem session 缺失优雅回退(Lead ②:session 不存在 → 空 session,不阻塞 document rehydrate)', () => {
    // sessRaw == null 时 sessState = {}(空 session merge);corrupt session → 空
    expect(source).toMatch(/sessRaw != null|sessRaw == null/)
    expect(source).toMatch(/let sessState.*\{\}/)
    expect(source).toMatch(/session 缺失优雅回退|空 session/)
  })

  it('getItem corrupt document/session → null/空(不抛,rehydrate 回退默认)', () => {
    expect(source).toMatch(/JSON\.parse\(docRaw\)/)
    expect(source).toMatch(/return null/) // corrupt document → null
  })

  it('getItem document 不存在 → null(未迁移/首次,canonical 不存在)', () => {
    expect(source).toMatch(/docRaw == null|return null/)
  })

  it('setItem partialize single → projectToThreeDomain 拆 document/session → 写两 key(version 11)', () => {
    expect(source).toMatch(/projectToThreeDomain\(blob\)/)
    expect(source).toMatch(/rawIdbStorage\.setItem\(documentKey\(name\)/)
    expect(source).toMatch(/rawIdbStorage\.setItem\(sessionKey\(name\)/)
  })

  it('setItem corrupt value → 不写(不破坏 canonical)', () => {
    expect(source).toMatch(/return \/\/ corrupt value/)
  })

  it('removeItem 删 document/session', () => {
    expect(source).toMatch(/rawIdbStorage\.removeItem\(documentKey\(name\)\)/)
    expect(source).toMatch(/rawIdbStorage\.removeItem\(sessionKey\(name\)\)/)
  })

  it('documentKey/sessionKey 用 namespacedKey 拼(与 migrateV10ToV11 一致,防 double-namespace)', () => {
    expect(source).toMatch(/namespacedKey\(name\)\}:document/)
    expect(source).toMatch(/namespacedKey\(name\)\}:session/)
  })
})
