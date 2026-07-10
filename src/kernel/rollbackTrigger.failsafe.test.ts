// src/kernel/rollbackTrigger.failsafe.test.ts
// T1.2 S6c:rollbackTrigger 口子 failsafe 源码契约——锁定 DEV 门控 + 防误触 + 调用链。
// 走源码契约路径(?raw),不 runtime(同 useLeaferSpikeRenderer.failsafe.test.ts):
// vitest 默认 node 环境,window probe 不宜 runtime 触发;源码契约足以锁定生产安全。

import { describe, expect, it } from 'vitest'
import source from './rollbackTrigger.ts?raw'

describe('rollbackTrigger — S6c failsafe source contracts', () => {
  describe('DEV 门控:生产零 window 写(同 R-06 failsafe 仪式)', () => {
    it('window.__MIVO_KERNEL_ROLLBACK__ 赋值在正向 import.meta.env.DEV 分支内(生产 if(false) tree-shake)', () => {
      // 正向 `if (import.meta.env.DEV && typeof window !== 'undefined') { window.__MIVO_KERNEL_ROLLBACK__ = ... }`:
      // 生产构建 import.meta.env.DEV=false → 整块死代码 tree-shake,无 window 赋值副作用。
      expect(source).toMatch(
        /if\s*\(\s*import\.meta\.env\.DEV[\s\S]*?window\.__MIVO_KERNEL_ROLLBACK__\s*=/,
      )
      // 不得出现反转写法 `if (!import.meta.env.DEV) { window.__MIVO_KERNEL_ROLLBACK__ = undefined; ... }`
      // (反转写法在生产是 if(true),仍执行 window=undefined 一次,违背"生产零 window 写")。
      expect(source).not.toMatch(
        /if\s*\(\s*!\s*import\.meta\.env\.DEV\s*\)\s*{\s*window\.__MIVO_KERNEL_ROLLBACK__\s*=\s*undefined/,
      )
    })

    it('SSR/node 守卫:typeof window !== "undefined"(防非浏览器环境炸)', () => {
      expect(source).toMatch(/typeof\s+window\s*!==\s*['"]undefined['"]/)
    })
  })

  describe('防误触:run 需显式 confirm', () => {
    it('runRollbackWithConfirm 检查 opts.confirm !== true → refuse(防 console 误触删除已迁移数据)', () => {
      expect(source).toMatch(/opts\.confirm\s*!==\s*true/)
    })
  })

  describe('调用链:口子 → rollbackFromV11(lead 契约)', () => {
    it('import rollbackFromV11 + RawStorage from ./persistMigration', () => {
      expect(source).toMatch(/import\s+\{\s*rollbackFromV11\s*\}\s+from\s+['"]\.\/persistMigration['"]/)
      expect(source).toMatch(/import\s+type\s+\{\s*RawStorage\s*\}\s+from\s+['"]\.\/persistMigration['"]/)
    })

    it('triggerRollbackFromV11 内 await rollbackFromV11(storage, ...)(实际调用,非死引用)', () => {
      expect(source).toMatch(/await\s+rollbackFromV11\s*\(\s*storage/)
    })

    it('import rawIdbStorage from ../lib/persistIdbStorage(S6b #189 改名后的 raw IDB storage)', () => {
      expect(source).toMatch(/import\s+\{\s*rawIdbStorage\s*\}\s+from\s+['"]\.\.\/lib\/persistIdbStorage['"]/)
    })

    it('默认 storage = rawIdbStorage(S6b 已在 export 处 cast as RawStorage,本处无需再 cast)', () => {
      // S6b 把 `as unknown as RawStorage` 集中在 rawIdbStorage 导出点;调用方直接传 rawIdbStorage。
      expect(source).toMatch(/storage:\s*RawStorage\s*=\s*rawIdbStorage\b/)
      // 不得在调用点重复 cast(S6b 已集中到 export,重复 cast 是冗余)。
      expect(source).not.toMatch(/rawIdbStorage\s+as\s+unknown\s+as\s+RawStorage/)
    })
  })

  describe('日志/toast 契约(docs/development-logging.md)', () => {
    it('success → debugLogger.log + toastFeedback.success', () => {
      expect(source).toMatch(/case\s+['"]success['"]\s*:[\s\S]*?debugLogger\.log\(/)
      expect(source).toMatch(/case\s+['"]success['"]\s*:[\s\S]*?toastFeedback\.success\(/)
    })
    it('no-ckpt → debugLogger.warn + toastFeedback.warn', () => {
      expect(source).toMatch(/case\s+['"]no-ckpt['"]\s*:[\s\S]*?debugLogger\.warn\(/)
      expect(source).toMatch(/case\s+['"]no-ckpt['"]\s*:[\s\S]*?toastFeedback\.warn\(/)
    })
    it('failure → debugLogger.error + toastFeedback.error', () => {
      expect(source).toMatch(/case\s+['"]failure['"]\s*:[\s\S]*?debugLogger\.error\(/)
      expect(source).toMatch(/case\s+['"]failure['"]\s*:[\s\S]*?toastFeedback\.error\(/)
    })
  })
})
