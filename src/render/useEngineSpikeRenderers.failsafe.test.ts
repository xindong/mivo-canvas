import { describe, expect, it } from 'vitest'
// leafer-ui 在 vitest 无 DOM 环境下无法 runtime 加载；useEngineSpikeRenderers
// 传递依赖 useLeaferSpikeRenderer → leafer-ui，故走源码契约（?raw）路径。
// computeEffectiveRendererMode 的 runtime 单测见 rendererFallback.test.ts。
import source from './useEngineSpikeRenderers.ts?raw'

describe('useEngineSpikeRenderers — PR-R1 fallback wiring source contracts', () => {
  it('把 leaferSpikeStats.fallbackToDom 接进 effectiveRendererMode 降级管道', () => {
    // 第二段：最终 effectiveRendererMode 由 pixi + leafer 双 fallback 决定。
    expect(source).toMatch(
      /computeEffectiveRendererMode\(\s*rendererMode,\s*pixiSpikeStats\.fallbackToDom,\s*leaferSpikeStats\.fallbackToDom/,
    )
  })

  it('两段式：pixiEffectiveMode（仅看 pixi fallback）喂给 leafer hook', () => {
    expect(source).toMatch(/computeEffectiveRendererMode\(\s*rendererMode,\s*pixiSpikeStats\.fallbackToDom,\s*false\s*\)/)
    expect(source).toMatch(/rendererMode:\s*pixiEffectiveMode/)
  })

  it('renderedNodes 用最终 effectiveRendererMode（leafer 失败后 DOM 渲染全部节点，非白屏）', () => {
    expect(source).toMatch(/filterDomNodesForRendererSpike\(\s*canvasRenderedNodes,\s*effectiveRendererMode/)
  })

  it('leafer hook 在 pixiEffectiveMode 计算之后、effectiveRendererMode 之前调用（两段顺序）', () => {
    const leaferCallIdx = source.indexOf('useLeaferSpikeRenderer({')
    const finalEffIdx = source.indexOf('const effectiveRendererMode = computeEffectiveRendererMode(')
    expect(leaferCallIdx).toBeGreaterThan(-1)
    expect(finalEffIdx).toBeGreaterThan(-1)
    expect(leaferCallIdx).toBeLessThan(finalEffIdx)
  })
})
