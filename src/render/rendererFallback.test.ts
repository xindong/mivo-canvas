import { describe, expect, it } from 'vitest'
import { computeEffectiveRendererMode } from './rendererFallback'

// PR-R1 降级管道：pixi / leafer 任一 init 失败 → 降到 'dom'，DOM 接管全部节点（非白屏）。
// 纯函数，不依赖 leafer-ui/pixi.js，直接单测。

describe('computeEffectiveRendererMode — PR-R1 fallback pipe', () => {
  it('无 fallback 时原样返回 rendererMode', () => {
    expect(computeEffectiveRendererMode('leafer', false, false)).toBe('leafer')
    expect(computeEffectiveRendererMode('dom', false, false)).toBe('dom')
    expect(computeEffectiveRendererMode('pixi', false, false)).toBe('pixi')
  })

  it('pixi fallback → 降到 dom（既有行为，未回归）', () => {
    expect(computeEffectiveRendererMode('leafer', true, false)).toBe('dom')
    expect(computeEffectiveRendererMode('pixi', true, false)).toBe('dom')
  })

  it('leafer fallback → 降到 dom（R-01 新增）', () => {
    expect(computeEffectiveRendererMode('leafer', false, true)).toBe('dom')
  })

  it('pixi + leafer 同时 fallback → dom', () => {
    expect(computeEffectiveRendererMode('leafer', true, true)).toBe('dom')
  })

  it('显式 dom 请求不受 fallback 影响（已是 dom）', () => {
    expect(computeEffectiveRendererMode('dom', false, true)).toBe('dom')
    expect(computeEffectiveRendererMode('dom', true, false)).toBe('dom')
  })
})
