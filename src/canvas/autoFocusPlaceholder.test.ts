import { describe, expect, it } from 'vitest'
import { viewportToRevealBounds } from './autoFocusPlaceholder'

const shell = { width: 1200, height: 800 }

describe('viewportToRevealBounds', () => {
  it('returns undefined when bounds are fully visible (camera stays put)', () => {
    // viewport (0,0) scale 1 → visible canvas region is (0,0)-(1200,800)。
    const result = viewportToRevealBounds({ x: 0, y: 0, scale: 1 }, shell, { x: 100, y: 100, width: 300, height: 200 })
    expect(result).toBeUndefined()
  })

  it('pans to center off-screen bounds and keeps the current scale', () => {
    const viewport = { x: 0, y: 0, scale: 1 }
    const bounds = { x: 5000, y: 3000, width: 300, height: 200 }
    const result = viewportToRevealBounds(viewport, shell, bounds)
    expect(result).toBeDefined()
    // 应用 result 后占位符中心应落在 shell 中心:screen = canvas*scale + offset。
    expect((bounds.x + bounds.width / 2) * result!.scale + result!.x).toBeCloseTo(shell.width / 2)
    expect((bounds.y + bounds.height / 2) * result!.scale + result!.y).toBeCloseTo(shell.height / 2)
    expect(result!.scale).toBe(viewport.scale)
  })

  it('pans when bounds are only partially visible', () => {
    // 右边缘越界 40px(1000+240 > 1200/1)。
    const result = viewportToRevealBounds({ x: 0, y: 0, scale: 1 }, shell, { x: 1000, y: 100, width: 240, height: 100 })
    expect(result).toBeDefined()
    expect(result!.x).toBeCloseTo(shell.width / 2 - 1120)
  })

  it('keeps a non-1 user scale untouched when revealing', () => {
    const result = viewportToRevealBounds({ x: 200, y: 100, scale: 0.5 }, shell, { x: 4000, y: 4000, width: 400, height: 400 })
    expect(result!.scale).toBe(0.5)
    expect(result!.x).toBeCloseTo(shell.width / 2 - 4200 * 0.5)
    expect(result!.y).toBeCloseTo(shell.height / 2 - 4200 * 0.5)
  })

  it('respects scale when judging visibility (visible at 0.5x despite exceeding half-shell canvas units)', () => {
    // scale 0.5 → 可见画布区域 (0,0)-(2400,1600),节点 (1400,900,300,200) 完全可见。
    const result = viewportToRevealBounds({ x: 0, y: 0, scale: 0.5 }, shell, { x: 1400, y: 900, width: 300, height: 200 })
    expect(result).toBeUndefined()
  })

  it('returns undefined for a degenerate shell size', () => {
    expect(viewportToRevealBounds({ x: 0, y: 0, scale: 1 }, { width: 0, height: 0 }, { x: 9999, y: 9999, width: 10, height: 10 })).toBeUndefined()
  })
})
