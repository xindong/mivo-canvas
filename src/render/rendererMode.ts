import { debugLogger } from '../store/debugLogStore'

/**
 * 渲染器模式契约（Phase 2a / Leafer 接入 PR-1）。
 *
 * 解析 `?renderer=` 查询参数，决定 `.canvas-shell` 的 `data-renderer-mode` 标识。
 * 本 PR 仅建立开关与标识，不实现 LeaferRenderer：`leafer` 模式当前等同 dom 渲染（占位），
 * 仅用于让 bench / e2e / 视觉 diff 工装能提前以 leafer 标识跑通采集链路。
 *
 * 默认 `dom`；非法值回退 `dom` 并 warn；`leafer` warn「未实现暂用 dom」。
 * 解析在模块加载时执行一次（renderer mode 在页面生命周期内不变）。
 */

export type RendererMode = 'dom' | 'leafer' | 'pixi'

const VALID_MODES: ReadonlySet<string> = new Set(['dom', 'leafer', 'pixi'])

const normalize = (raw: string): string => raw.trim().toLowerCase()

const parseRendererModeFromUrl = (): RendererMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return 'dom'

  const raw = new URLSearchParams(window.location.search).get('renderer')
  if (!raw) return 'dom'

  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Renderer', `未知 renderer mode "${raw}"，回退 dom`)
    return 'dom'
  }

  if (normalized === 'leafer') {
    debugLogger.log('Renderer', 'leafer spike renderer active (image/frame/rect only; Phase 2b 正式化时扩展)')
    return 'leafer'
  }
  if (normalized === 'pixi') {
    debugLogger.log('Renderer', 'pixi 0d spike renderer active (image/frame/rect/text; dynamic import)')
    return 'pixi'
  }

  return 'dom'
}

export const rendererMode: RendererMode = parseRendererModeFromUrl()

export const isLeaferRendererRequested = rendererMode === 'leafer'
