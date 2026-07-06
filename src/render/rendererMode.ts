import { debugLogger } from '../store/debugLogStore'

/**
 * 渲染器模式契约（Phase 2a 建立；默认切换见下）。
 *
 * 解析 `?renderer=` 查询参数，决定 `.canvas-shell` 的 `data-renderer-mode` 标识。
 * Leafer 正式化已完成（paint 全集 #110/#112/#116/#120 + 文字壳 #124/#125），
 * 最终验收通过后默认渲染器切为 leafer（2026-07-06 用户拍板）：
 *
 * - 默认（无参数 / 非法值 / 非浏览器环境）`leafer`；非法值回退默认并 warn。
 * - `?renderer=dom` 是保留的应急回退通道，语义不变——DomRenderer 与双轨
 *   代码不删，观察窗后另行决策。
 * - `?renderer=pixi` 为 0d spike 遗留（NO-GO，engine-combo-0g），仅工装可用。
 *
 * 解析在模块加载时执行一次（renderer mode 在页面生命周期内不变）。
 */

export type RendererMode = 'dom' | 'leafer' | 'pixi'

const DEFAULT_MODE: RendererMode = 'leafer'

const VALID_MODES: ReadonlySet<string> = new Set(['dom', 'leafer', 'pixi'])

const normalize = (raw: string): string => raw.trim().toLowerCase()

const parseRendererModeFromUrl = (): RendererMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return DEFAULT_MODE

  const raw = new URLSearchParams(window.location.search).get('renderer')
  if (!raw) return DEFAULT_MODE

  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Renderer', `未知 renderer mode "${raw}"，回退默认 ${DEFAULT_MODE}`)
    return DEFAULT_MODE
  }

  if (normalized === 'dom') {
    debugLogger.log('Renderer', 'dom renderer requested（应急回退通道，默认已是 leafer）')
    return 'dom'
  }
  if (normalized === 'pixi') {
    debugLogger.log('Renderer', 'pixi 0d spike renderer active (image/frame/rect/text; dynamic import)')
    return 'pixi'
  }

  return 'leafer'
}

export const rendererMode: RendererMode = parseRendererModeFromUrl()

export const isLeaferRendererRequested = rendererMode === 'leafer'
