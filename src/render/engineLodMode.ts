import { debugLogger } from '../store/debugLogStore'

export type EngineLodMode = 'on' | 'off'

const DEFAULT_THRESHOLD_PX = 32
const VALID_MODES: ReadonlySet<string> = new Set(['on', 'off', 'true', 'false', '1', '0'])

const normalize = (raw: string): string => raw.trim().toLowerCase()

const parseThresholdPxFromUrl = (): number => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return DEFAULT_THRESHOLD_PX

  const raw = new URLSearchParams(window.location.search).get('lodPx')
  if (!raw) return DEFAULT_THRESHOLD_PX

  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    debugLogger.warn('Renderer', `未知 lodPx "${raw}"，回退 ${DEFAULT_THRESHOLD_PX}px`)
    return DEFAULT_THRESHOLD_PX
  }
  return value
}

const parseEngineLodModeFromUrl = (): EngineLodMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return 'off'

  const raw = new URLSearchParams(window.location.search).get('lod')
  if (!raw) return 'off'

  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Renderer', `未知 lod mode "${raw}"，回退 off`)
    return 'off'
  }

  if (normalized === 'on' || normalized === 'true' || normalized === '1') {
    debugLogger.log('Renderer', `Engine LOD 0g spike active (threshold=${parseThresholdPxFromUrl()}px)`)
    return 'on'
  }

  return 'off'
}

export const engineLodThresholdPx = parseThresholdPxFromUrl()
export const engineLodMode: EngineLodMode = parseEngineLodModeFromUrl()
export const isEngineLodRequested = engineLodMode === 'on'
