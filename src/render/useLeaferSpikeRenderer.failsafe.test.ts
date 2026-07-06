import { describe, expect, it } from 'vitest'
// leafer-ui 在 vitest 无 DOM 环境下无法 runtime 加载，本仓 render 测试统一走
// 源码契约（?raw）路径（见 useNodeTransform.contract.test.ts 说明）。本测试锁定
// PR-R1 的 failsafe 结构：init try/catch + failToDom 三件套 + 探针/window DEV 门控。
import source from './useLeaferSpikeRenderer.ts?raw'

describe('useLeaferSpikeRenderer — PR-R1 failsafe source contracts', () => {
  describe('R-01: Leafer init 失败 → 降级 dom', () => {
    it('new Leafer / leafer.start() / paint 模块绑定包在 try/catch，catch 调 failToDom', () => {
      expect(source).toMatch(
        /try\s*{[\s\S]*?new Leafer\([\s\S]*?leafer\.start\(\)[\s\S]*?createLeaferBrushStampPaint\([\s\S]*?catch\s*\(error\)[\s\S]*?failToDom\(/,
      )
    })

    it('catch 块清掉 local leafer 引用避免 cleanup 二次 destroy', () => {
      expect(source).toMatch(/catch\s*\(error\)\s*{[\s\S]*?leafer\s*=\s*null[\s\S]*?failToDom\(/)
    })

    it('failToDom 调 debugLogger.error 一条（source=Leafer Spike）', () => {
      expect(source).toMatch(/debugLogger\.error\(\s*['"]Leafer Spike['"]\s*,/)
    })

    it('failToDom 调 toastFeedback.error 一条（用户反馈）', () => {
      expect(source).toMatch(/toastFeedback\.error\(/)
    })

    it('failToDom publishStats 置 fallbackToDom:true', () => {
      expect(source).toMatch(/publishStats\(\{\s*\.\.\.EMPTY_STATS,\s*panCacheEnabled,\s*fallbackToDom:\s*true\s*\}\)/)
    })

    it('failToDom 销毁半成品 Leafer 实例 + 清空四个 paint ref（镜像 pixi failToDom）', () => {
      expect(source).toMatch(/imagePaintRef\.current\?\.dispose\(\)/)
      expect(source).toMatch(/shapePaintRef\.current\?\.dispose\(\)/)
      expect(source).toMatch(/linePaintRef\.current\?\.dispose\(\)/)
      expect(source).toMatch(/brushStampPaintRef\.current\?\.dispose\(\)/)
      expect(source).toMatch(/current\.destroy\(\)/)
    })

    it('LeaferSpikeStats 类型 + EMPTY_STATS + publishStats 比较器都含 fallbackToDom', () => {
      expect(source).toMatch(/fallbackToDom:\s*boolean/)
      expect(source).toMatch(/fallbackToDom:\s*false/)
      expect(source).toMatch(/current\.fallbackToDom\s*===\s*next\.fallbackToDom/)
    })

    it('init effect deps 含 failToDom（避免 stale callback）', () => {
      expect(source).toMatch(/\},\s*\[failToDom,\s*hostRef,\s*panCacheEnabled,\s*publishStats,\s*rendererMode\]\)/)
    })
  })

  describe('R-02: 像素探针 DEV 门控', () => {
    it('sampleNonEmptyCanvasPixels 加 import.meta.env.DEV 门控', () => {
      expect(source).toMatch(/sampleNonEmptyCanvasPixels[\s\S]*?import\.meta\.env\.DEV/)
    })

    it('生产（!DEV）跳过 getImageData，置 nonEmpty:true（信任 Leafer 已上像素）', () => {
      expect(source).toMatch(/!import\.meta\.env\.DEV[\s\S]*?nonEmpty:\s*true/)
    })
  })

  describe('R-06: window 调试探针 DEV 门控', () => {
    it('window.__MIVO_LEAFER_SPIKE__ 赋值在正向 DEV 分支内（生产 if(false) 被 tree-shake，无 window 写）', () => {
      // 正向 `if (import.meta.env.DEV) { window.__MIVO_LEAFER_SPIKE__ = {...} }`：
      // 生产构建 import.meta.env.DEV=false → 整块死代码被 tree-shake，effect body 空，
      // 无 window 赋值副作用。反转写法 `if(!DEV){window=undefined;return}` 在生产是
      // if(true) 仍执行 window=undefined，不达标，故锁定正向分支。
      expect(source).toMatch(
        /if\s*\(\s*import\.meta\.env\.DEV\s*\)\s*{[\s\S]*?window\.__MIVO_LEAFER_SPIKE__\s*=/,
      )
      // 且不得出现反转写法 `if (!import.meta.env.DEV) { window.__MIVO_LEAFER_SPIKE__ = undefined; ... }`
      // （收紧：要求 window=undefined 紧邻 if(!DEV){ 之后，避免与 R-02 的 !DEV 或
      // cleanup return 里的 =undefined 跨文件误匹配）
      expect(source).not.toMatch(
        /if\s*\(\s*!\s*import\.meta\.env\.DEV\s*\)\s*{\s*window\.__MIVO_LEAFER_SPIKE__\s*=\s*undefined/,
      )
    })
  })
})
