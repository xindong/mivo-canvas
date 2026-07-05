import { debugLogger } from '../store/debugLogStore'

export type VirtualizationMode = 'on' | 'off'

const VALID_MODES: ReadonlySet<string> = new Set(['on', 'off', 'true', 'false', '1', '0'])

const normalize = (raw: string): string => raw.trim().toLowerCase()

const parseVirtualizationModeFromUrl = (): VirtualizationMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return 'off'

  const raw = new URLSearchParams(window.location.search).get('virtualize')
  if (!raw) return 'off'

  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Renderer', `未知 virtualize mode "${raw}"，回退 off`)
    return 'off'
  }

  if (normalized === 'on' || normalized === 'true' || normalized === '1') {
    debugLogger.log('Renderer', 'DOM virtualization 0e spike active (pan freezes visible set)')
    return 'on'
  }

  return 'off'
}

export const virtualizationMode: VirtualizationMode = parseVirtualizationModeFromUrl()

export const isDomVirtualizationRequested = virtualizationMode === 'on'
