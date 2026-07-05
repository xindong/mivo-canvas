import { debugLogger } from '../store/debugLogStore'
import type { ViewportState } from './useLeaferSpikeRenderer'

type EngineCameraHandler = (viewport: ViewportState) => void

const handlers = new Set<EngineCameraHandler>()

export const registerEngineSpikeCamera = (handler: EngineCameraHandler) => {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

export const applyEngineSpikeCamera = (viewport: ViewportState) => {
  for (const handler of handlers) {
    try {
      handler(viewport)
    } catch (error) {
      debugLogger.error('Renderer', `Engine freeze camera sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
