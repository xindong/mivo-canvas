import type { CanvasId } from '../types/mivoCanvas'
import { useCanvasStore, warnCanvas } from './canvasStore'
import {
  settleCanvasGenerationInState,
  type CanvasGenerationSettleCounts,
} from './canvasGenerationHydration'

export const settleCanvasGenerationLocally = (options: {
  sceneId: CanvasId
  slotId?: string
  taskId?: string
  status: 'failed' | 'canceled'
}): CanvasGenerationSettleCounts => {
  let counts: CanvasGenerationSettleCounts = { settledTasks: 0, settledSlots: 0 }
  useCanvasStore.setState((current) => {
    const result = settleCanvasGenerationInState(current, options)
    counts = result.counts
    return result.patch
  })

  if (counts.settledTasks > 0 || counts.settledSlots > 0) {
    warnCanvas(
      `Cancel fallback settled canvas generation in ${options.sceneId}: slots=${counts.settledSlots}; tasks=${counts.settledTasks}; status=${options.status}`,
    )
  }

  return counts
}
