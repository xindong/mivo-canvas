// 生图占位符镜头跟随的纯视口计算(消费方:useViewport 的 auto-focus effect)。
// 缩放策略契约:占位符在当前视口内完全可见 → 返回 undefined(镜头不动);
// 不可见/部分可见 → 平移到居中,scale 保持用户当前值(不强制 zoom)。
import type { CanvasBounds, Viewport } from './canvasInteraction'

export type ShellSize = { width: number; height: number }

const boundsFullyVisible = (viewport: Viewport, shell: ShellSize, bounds: CanvasBounds): boolean => {
  const visibleX0 = -viewport.x / viewport.scale
  const visibleY0 = -viewport.y / viewport.scale
  const visibleX1 = (shell.width - viewport.x) / viewport.scale
  const visibleY1 = (shell.height - viewport.y) / viewport.scale
  return (
    bounds.x >= visibleX0 &&
    bounds.y >= visibleY0 &&
    bounds.x + bounds.width <= visibleX1 &&
    bounds.y + bounds.height <= visibleY1
  )
}

const viewportToCenter = (viewport: Viewport, shell: ShellSize, bounds: CanvasBounds): Viewport => ({
  x: shell.width / 2 - (bounds.x + bounds.width / 2) * viewport.scale,
  y: shell.height / 2 - (bounds.y + bounds.height / 2) * viewport.scale,
  scale: viewport.scale,
})

export const viewportToRevealBounds = (
  viewport: Viewport,
  shell: ShellSize,
  bounds: CanvasBounds,
): Viewport | undefined => {
  if (shell.width <= 0 || shell.height <= 0) return undefined
  if (boundsFullyVisible(viewport, shell, bounds)) return undefined

  return viewportToCenter(viewport, shell, bounds)
}

export const viewportToCenterBounds = (
  viewport: Viewport,
  shell: ShellSize,
  bounds: CanvasBounds,
): Viewport | undefined => {
  if (shell.width <= 0 || shell.height <= 0) return undefined

  return viewportToCenter(viewport, shell, bounds)
}
