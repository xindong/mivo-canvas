import { debugLogger } from '../store/debugLogStore'

/**
 * Culling 契约（Phase 0a / Leafer 接入 PR-1）。
 *
 * 解析 `?culling=` 查询参数，决定 viewport culling（视口裁剪）是否开启。
 * 默认 `on`（生产行为：只渲染视口内 + overscan 的节点）；`off` 时全量渲染
 * visibleNodes，用于 0b「Leafer 全量 vs Leafer+culling vs DOM」对照实验。
 *
 * 默认 `on`；非法值回退 `on` 并 warn。模块加载时解析一次（页面生命周期内不变）。
 */

export type CullingMode = 'on' | 'off'

const VALID_MODES: ReadonlySet<string> = new Set(['on', 'off'])

const normalize = (raw: string): string => raw.trim().toLowerCase()

const parseCullingModeFromUrl = (): CullingMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return 'on'

  const raw = new URLSearchParams(window.location.search).get('culling')
  if (!raw) return 'on'

  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Renderer', `未知 culling mode "${raw}"，回退 on`)
    return 'on'
  }

  return normalized === 'off' ? 'off' : 'on'
}

export const cullingMode: CullingMode = parseCullingModeFromUrl()

export const isCullingDisabled = cullingMode === 'off'
